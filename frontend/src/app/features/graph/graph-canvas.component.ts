// graph-canvas.component.ts — Canvas-based D3 force graph
// Replaces the SVG renderer with a Canvas 2D context.
// D3 force simulation is unchanged; only the drawing pipeline differs.
// Canvas can handle 10 000+ nodes at 60 fps where SVG stalls at ~500.
import { Component, ElementRef, ViewChild, OnDestroy, AfterViewInit, inject, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as d3          from 'd3';
import { Subject, takeUntil } from 'rxjs';
import { GraphService, PinnedEntity, PairwiseFocus } from '../../core/services/graph.service';
import {
  SubgraphResponse, SimNode, SimEdge,
  ds, CRIT_STROKE, CRIT_WIDTH, CRIT_DASH,
} from '../../core/models/models';

const NW = 152, NH = 56;   // node width / height

@Component({
  selector:'abacus-graph-canvas', standalone:true, imports:[CommonModule],
  templateUrl:'./graph-canvas.component.html',
  styleUrls:  ['./graph-canvas.component.scss'],
})
export class GraphCanvasComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas', {static:true}) canvasRef!: ElementRef<HTMLCanvasElement>;

  gs        = inject(GraphService);
  zone      = inject(NgZone);
  subgraph$ = this.gs.subgraph$;
  selected$ = this.gs.selected$;
  loading$  = this.gs.loading$;

  critEntries = Object.entries(CRIT_STROKE) as [string,string][];
  trackPin(_: number, p: PinnedEntity): string { return p.candidate.entity_id; }

  private sim:        d3.Simulation<SimNode, SimEdge> | null = null;
  private _nodes:     SimNode[] = [];
  private _edges:     SimEdge[] = [];
  private _ctx:       CanvasRenderingContext2D | null = null;
  private _transform  = d3.zoomIdentity;
  private _zoom:      d3.ZoomBehavior<HTMLCanvasElement, unknown> | null = null;
  private _raf:       number | null = null;
  private _edgeFactor     = new Map<string, number>();
  private _labelWidthCache= new Map<string, number>(); // avoids measureText on every frame
  private _dragMoved      = false;
  private _tickCount      = 0;   // throttle: only redraw every N simulation ticks
  private destroy         = new Subject<void>();

  ngAfterViewInit() {
    // Interaction wiring is set up ONCE here, not inside _render.
    // Re-calling _render (on every search) used to re-attach zoom/drag/click
    // listeners, accumulating them indefinitely → multiple handlers per click.
    this._initInteraction(this.canvasRef.nativeElement);

    this.gs.subgraph$.pipe(takeUntil(this.destroy))
      .subscribe(sg => sg ? this._render(sg) : this._clear());
    this.gs.selected$.pipe(takeUntil(this.destroy))
      .subscribe(sel => {
        this._scheduleFrame();
        if (sel?.kind === 'edge' && sel.edge) this._panToEdge(sel.edge.id);
      });
    this.gs.pairwiseFocus$.pipe(takeUntil(this.destroy))
      .subscribe(pw => {
        this._scheduleFrame();
        if (pw) this._panToPair(pw.nodeA, pw.nodeB);
      });
  }

  ngOnDestroy() {
    this.sim?.stop();
    if (this._raf) cancelAnimationFrame(this._raf);
    this.destroy.next(); this.destroy.complete();
  }

  // ── Frame scheduling ───────────────────────────────────────────────────────

  private _scheduleFrame() {
    if (this._raf) return;
    // Zone.js monkey-patches the global requestAnimationFrame, meaning every rAF
    // callback — even those queued from outside-zone code — can still execute inside
    // Angular zone and trigger change detection at 60fps.
    // Zone.js preserves the original native rAF at __zone_symbol__requestAnimationFrame.
    // Using it keeps the ENTIRE canvas draw loop completely invisible to Angular CD.
    // Falls back to the patched version in environments without Zone.js (unit tests etc.)
    const nativeRaf = (window as any).__zone_symbol__requestAnimationFrame as
                      (typeof requestAnimationFrame) | undefined;
    this._raf = (nativeRaf ?? requestAnimationFrame)(() => { this._raf = null; this._drawFrame(); });
  }

  // ── Interaction setup (called once) ───────────────────────────────────────

  private _initInteraction(canvas: HTMLCanvasElement) {
    // ── Run ALL D3 event listeners outside Angular zone ────────────────────
    // D3 zoom, drag, and mousemove fire on every pointer event at 60 fps.
    // Zone.js patches addEventListener → each event triggers full Angular
    // change detection even though canvas drawing is purely imperative.
    // Running outside zone removes this overhead entirely; we call zone.run()
    // only for the 3 places that actually update Angular state (selections).
    this.zone.runOutsideAngular(() => {
      const sel = d3.select(canvas);

      // ── Zoom ──────────────────────────────────────────────────────────────
      // filter: wheel events always zoom; mousedown only pans when NOT over a node
      // (so that clicking/dragging a node is handled exclusively by d3.drag below).
      this._zoom = d3.zoom<HTMLCanvasElement, unknown>()
        .scaleExtent([0.15, 4])
        .filter((ev: any) => {
          if (ev.type === 'wheel') return true;
          if (ev.type === 'mousedown' || ev.type === 'touchstart') {
            const ox = ev.offsetX ?? ev.clientX - canvas.getBoundingClientRect().left;
            const oy = ev.offsetY ?? ev.clientY - canvas.getBoundingClientRect().top;
            const [mx, my] = this._transform.invert([ox, oy]);
            return !this._hitNode(mx, my);   // yield to drag when over a node
          }
          return !ev.button;
        })
        .on('zoom', ev => { this._transform = ev.transform; this._scheduleFrame(); });
      sel.call(this._zoom);

      // ── Drag (node pinning) ────────────────────────────────────────────────
      // CRITICAL coordinate fix:
      //   D3 drag computes an offset: dx = subject.x - initialPointer.x
      //   If subject.x is in simulation space but pointer is in element/screen space,
      //   dx is a garbage value → the node teleports on the very first drag move.
      //   Fix: return subject with x/y in SCREEN space so dx ≈ 0 (user clicked the
      //   node center) or a small pixel offset. In drag we invert ev.x/ev.y back to
      //   simulation space as usual.
      sel.call(
        d3.drag<HTMLCanvasElement, unknown>()
          .subject((ev: any) => {
            // ev.x/ev.y = element-relative CSS pixels (d3.pointer result)
            const [mx, my] = this._transform.invert([ev.x, ev.y]);
            const node = this._hitNode(mx, my);
            if (!node) return null;
            // Return screen-space coords so D3 drag's offset is computed correctly.
            // Carry the SimNode reference on _node for use in start/drag/end.
            return {
              _node: node,
              x: this._transform.applyX(node.x ?? 0),
              y: this._transform.applyY(node.y ?? 0),
            };
          })
          .on('start', (ev: any) => {
            this._dragMoved = false;
            if (!ev.active) {
              // Keep alpha very low during drag for ALL graph sizes:
              // a high alphaTarget (0.3) heats the whole simulation and makes every
              // other node fly around while the user is moving one — feels chaotic.
              // 0.06 keeps the dragged node responsive while neighbours barely shift.
              this.sim?.alphaTarget(0.06).restart();
            }
            const node = (ev.subject as any)?._node as SimNode | undefined;
            if (node) { node.fx = node.x; node.fy = node.y; }
          })
          .on('drag', (ev: any) => {
            this._dragMoved = true;
            const node = (ev.subject as any)?._node as SimNode | undefined;
            if (node) {
              // ev.x/ev.y are screen-space with D3's offset applied → invert to sim
              const [mx, my] = this._transform.invert([ev.x, ev.y]);
              node.fx = mx; node.fy = my;
              if (!this.sim) { node.x = mx; node.y = my; }
              // Always schedule a frame directly — the sim-tick drawEvery throttle
              // caps rendering to 20fps for n=50-80 nodes, which feels jerky during
              // interactive drag. Calling _scheduleFrame() here gives 60fps drag
              // regardless of drawEvery. The _raf guard prevents double-scheduling.
              this._scheduleFrame();
            }
          })
          .on('end', (ev: any) => {
            if (!ev.active) this.sim?.alphaTarget(0);
            const node = (ev.subject as any)?._node as SimNode | undefined;
            // No movement → treat as a node click (re-enter zone for Angular state)
            if (!this._dragMoved && node) this.zone.run(() => this.gs.selectNode(node));
            // Always reset so subsequent edge/background clicks aren't blocked
            this._dragMoved = false;
          }),
      );

      // ── Cursor (pointer hand over nodes / edge labels) ──────────────────
      sel.on('mousemove.cursor', (ev: MouseEvent) => {
        const [mx, my] = this._transform.invert([ev.offsetX, ev.offsetY]);
        canvas.style.cursor =
          (this._hitNode(mx, my) || this._hitEdge(mx, my)) ? 'pointer' : 'default';
      });

      // ── Click (edge label or background) ────────────────────────────────
      // Node clicks are handled in drag.end above; this handles everything else.
      sel.on('click.canvas', (ev: MouseEvent) => {
        // D3 drag suppresses the browser click event after a real drag,
        // but _dragMoved is a safety net in case it slips through.
        if (this._dragMoved) return;
        const [mx, my] = this._transform.invert([ev.offsetX, ev.offsetY]);
        if (this._hitNode(mx, my)) return;   // drag.end already handled this
        const e = this._hitEdge(mx, my);
        if (e) {
          // Re-enter zone only for Angular state updates
          this.zone.run(() => this.gs.selectEdge({
            ...e, source: e.source_app, target: e.sinc_app,
            sourceNode: e.source as SimNode, targetNode: e.target as SimNode,
          }));
        } else {
          this.zone.run(() => this.gs.clearSelection());
        }
      });
    }); // end runOutsideAngular
  }

  // ── Build (called on every new subgraph) ──────────────────────────────────

  private _render(sg: SubgraphResponse) {
    this.sim?.stop();
    this.sim = null;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    this._labelWidthCache.clear(); // edge labels may differ between graphs

    const canvas = this.canvasRef.nativeElement;
    const dpr = window.devicePixelRatio || 1;
    // canvas has [hidden] (display:none) when data first arrives → clientWidth === 0.
    // The parent .wrap div is always visible and has the correct layout dimensions.
    const parent = canvas.parentElement ?? canvas;
    const W   = parent.clientWidth  || 900;
    const H   = parent.clientHeight || 560;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    this._ctx = canvas.getContext('2d');

    // Reset zoom to identity; will be overridden by _fitToViewport for large graphs
    this._transform = d3.zoomIdentity;
    if (this._zoom) d3.select(canvas).call(this._zoom.transform, d3.zoomIdentity);

    // ── Detect pre-computed layout (full-graph endpoint) ───────────────────
    // When layout_x/layout_y are present on nodes the backend has already done
    // the positioning. We skip D3 force simulation entirely and just fit the
    // bounding box into the viewport — instant rendering for 4-5 k nodes.
    const hasLayout = sg.nodes.length > 0 && sg.nodes[0].layout_x != null;

    // ── Nodes & edges ──────────────────────────────────────────────────────
    // Compute count early — used for scatter radius, link distance, and forces
    const n = sg.nodes.length;

    // Initial random scatter: tight start = less kinetic energy = faster settling.
    // Small graphs now run 200 synchronous pre-ticks so they appear immediately
    // settled — a tighter start radius keeps those pre-ticks effective.
    const scatter = n < 20 ? 100 : n < 50 ? 160 : n < 80 ? 260 : 400;

    const nodes: SimNode[] = sg.nodes.map(nd => ({
      ...nd,
      x: hasLayout ? nd.layout_x! : W/2 + (Math.random()-.5)*scatter,
      y: hasLayout ? nd.layout_y! : H/2 + (Math.random()-.5)*scatter,
      vx:0, vy:0, fx:null, fy:null,
    }));
    const byId = new Map(nodes.map(nd => [nd.id, nd]));
    const edges: SimEdge[] = sg.edges
      .map(e => ({ ...e, source: byId.get(e.source_app) as any, target: byId.get(e.sinc_app) as any }))
      .filter(e => e.source && e.target);
    this._nodes = nodes;
    this._edges = edges;

    // Parallel-edge bezier offsets
    const pairCount = new Map<string, number>();
    edges.forEach(e => {
      const k = `${(e.source as SimNode).id}→${(e.target as SimNode).id}`;
      pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
    });
    const pairCur = new Map<string, number>();
    this._edgeFactor.clear();
    edges.forEach(e => {
      const k = `${(e.source as SimNode).id}→${(e.target as SimNode).id}`;
      const cnt = pairCount.get(k)!;
      const i   = pairCur.get(k) ?? 0;
      pairCur.set(k, i + 1);
      this._edgeFactor.set(e.id, cnt === 1 ? 0.16 : (i - (cnt-1)/2) * 0.22);
    });

    // ── Pre-laid graph: fit to viewport, no simulation ─────────────────────
    if (hasLayout) {
      this._fitToViewport();
      this._scheduleFrame();
      return;
    }

    // ── Layout: ALL ticks run synchronously — zero visible animation ──────────
    //
    // Same approach as the full-enterprise-graph page (hasLayout=true):
    // compute the final layout before the first paint, then show a static result.
    //
    // Force parameters — tuned for fast convergence, not physics realism.
    const charge    = n < 50  ? -700  : n < 150 ? -650  : -400;
    const linkDist  = n < 20  ? 130   : n < 80  ? 180   : 240;
    const centerStr = n < 20  ? 0.15  : n < 80  ? 0.10  : n < 200 ? 0.06 : 0.03;
    // alphaDecay: higher = fewer ticks needed to reach alphaMin (0.001).
    // n<200: (1-0.05)^120 ≈ 0.0017 → ~120 ticks.  n>=200: ~95 ticks.
    const alphaDecay = n < 200 ? 0.05 : 0.065;
    // How many synchronous ticks to run — enough to fully exhaust the alpha budget.
    // Barnes-Hut O(n log n) per tick: even n=300 nodes × 200 ticks ≈ 1-2 ms.
    const preTicks  = n < 200 ? 200 : 150;

    this._tickCount = 0;

    this.zone.runOutsideAngular(() => {
      this.sim = d3.forceSimulation<SimNode, SimEdge>(nodes)
        .force('link',    d3.forceLink<SimNode,SimEdge>(edges).id((d:any)=>d.id).distance(linkDist).strength(.38))
        .force('charge',  d3.forceManyBody<SimNode>().strength(charge))
        .force('center',  d3.forceCenter(W/2, H/2))
        .force('x',       d3.forceX<SimNode>(W/2).strength(centerStr))
        .force('y',       d3.forceY<SimNode>(H/2).strength(centerStr))
        .force('collide', d3.forceCollide<SimNode>(90))
        .alphaDecay(alphaDecay)
        .stop();

      // Run ALL layout ticks synchronously — no requestAnimationFrame involved,
      // no visible animation.  The simulation is fully settled before first paint.
      for (let i = 0; i < preTicks; i++) this.sim.tick();

      this._fitToViewport();
      this._scheduleFrame(); // single draw of the settled graph

      // Register tick handler for drag-initiated physics.
      // We do NOT call .restart() here — the graph stays static until the user
      // drags a node, at which point drag.start calls alphaTarget(0.06).restart().
      // The tick handler then fires to redraw while physics plays out.
      const drawEvery = n < 50 ? 1 : n < 200 ? 2 : 4;
      this.sim.on('tick', () => {
        if (++this._tickCount % drawEvery === 0) this._scheduleFrame();
      });
      // Intentionally NO .restart() — zero animation on load.
    }); // end runOutsideAngular
  }

  // ── Fit all nodes into the current viewport ────────────────────────────────

  private _fitToViewport() {
    if (!this._zoom) return;
    const canvas = this.canvasRef.nativeElement;
    const W = canvas.clientWidth || 900, H = canvas.clientHeight || 560;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of this._nodes) {
      if (n.x != null && n.y != null) {
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      }
    }
    if (!isFinite(minX)) return;

    const pad  = 60;
    const extW = maxX - minX || 1, extH = maxY - minY || 1;
    const k    = Math.min((W - pad*2) / extW, (H - pad*2) / extH, 4);
    const tx   = (W - k * (minX + maxX)) / 2;
    const ty   = (H - k * (minY + maxY)) / 2;

    const t = d3.zoomIdentity.translate(tx, ty).scale(k);
    this._transform = t;
    d3.select(canvas).call(this._zoom.transform, t);
  }

  // ── Pan to two specific nodes (pairwise focus) ────────────────────────────

  private _panToPair(nodeAId: string, nodeBId: string) {
    if (!this._zoom) return;
    const canvas = this.canvasRef.nativeElement;
    const W = canvas.clientWidth || 900, H = canvas.clientHeight || 560;
    const a = this._nodes.find(n => n.id === nodeAId);
    const b = this._nodes.find(n => n.id === nodeBId);
    if (!a || !b || a.x == null || b.x == null) return;

    const pad  = 100;
    const minX = Math.min(a.x, b.x) - NW, maxX = Math.max(a.x, b.x) + NW;
    const minY = Math.min(a.y!, b.y!) - NH, maxY = Math.max(a.y!, b.y!) + NH;
    const extW = maxX - minX || 1, extH = maxY - minY || 1;
    const k    = Math.min((W - pad*2) / extW, (H - pad*2) / extH, 2.2);
    const tx   = (W - k * (minX + maxX)) / 2;
    const ty   = (H - k * (minY + maxY)) / 2;

    const t = d3.zoomIdentity.translate(tx, ty).scale(k);
    d3.select(canvas).transition().duration(550).call(this._zoom.transform, t);
  }

  // ── Draw ──────────────────────────────────────────────────────────────────

  private _drawFrame() {
    const ctx = this._ctx;
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cW  = ctx.canvas.width, cH = ctx.canvas.height;
    // Reset to identity before clearRect — the previous frame's pan/zoom transform
    // is still active; without this, clearRect only wipes a partial region and
    // every element leaves a persistent ghost trail when panning.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cW, cH);

    const t = this._transform;
    // Merge DPR into the transform so all drawing stays in CSS-pixel space
    ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);

    this._drawGrid(ctx, cW / dpr, cH / dpr, t);

    const sel       = this.gs.selectionValue;
    const hasPins   = this.gs.hasPins();
    const pinColors = this.gs.edgePinColors();

    // 1-hop neighbour set
    const neighborIds = new Set<string>();
    if (sel?.kind === 'node' && sel.node) {
      const id = sel.node.id;
      this._edges.forEach(e => {
        const src = (e.source as SimNode).id, tgt = (e.target as SimNode).id;
        if (src === id) neighborIds.add(tgt);
        if (tgt === id) neighborIds.add(src);
      });
    }

    // ── Batched overview rendering (no selection, low zoom) ───────────────
    // At k<0.35 each edge would otherwise call ctx.stroke() individually.
    // 44k strokes/frame × 60fps = 2.6M GPU flushes/sec → drops to ~10fps.
    // Batching groups edges by color into one beginPath → one stroke per
    // criticality bucket (4 strokes total instead of 44k).
    // Same for node dots: group by domain accent color → 10 fills vs 4k.
    const vpW = cW / dpr, vpH = cH / dpr;

    const pairwiseFocus = this.gs.pairwiseFocusValue;
    if (t.k < 0.35 && !sel && !hasPins && !pairwiseFocus) {
      this._drawEdgesBatched(ctx, vpW, vpH);
      this._drawNodesBatched(ctx, vpW, vpH, sel, neighborIds);
      return;
    }

    // Viewport culling for the detail draw path (k ≥ 0.35).
    // Without this, every frame iterates ALL nodes/edges regardless of visibility.
    // At normal zoom with 400+ nodes, ~90% are off-screen — culling drops
    // draw calls from O(total) to O(visible), making pan/zoom smooth.
    const { x0, y0, x1, y1 } = this._viewportBounds(vpW, vpH, 400);

    for (const e of this._edges) {
      const es = e.source as SimNode, et = e.target as SimNode;
      if (es.x == null || et.x == null) continue;
      // Skip if both endpoints are clearly off the same side of the viewport
      if ((es.x < x0 && et.x < x0) || (es.x > x1 && et.x > x1) ||
          (es.y! < y0 && et.y! < y0) || (es.y! > y1 && et.y! > y1)) continue;
      this._drawEdge(ctx, e, sel, hasPins, pinColors, pairwiseFocus);
    }
    for (const nd of this._nodes) {
      if (nd.x == null || nd.y == null) continue;
      if (nd.x + NW < x0 || nd.x - NW > x1 || nd.y + NH < y0 || nd.y - NH > y1) continue;
      this._drawNode(ctx, nd, sel, neighborIds, pairwiseFocus);
    }
  }

  // ── Batched overview draws (overview zoom, no selection) ─────────────────
  // Called instead of the per-element loops when k < 0.35 and nothing is
  // selected. Reduces GPU flush calls from O(n_edges) → O(4 criticalities)
  // and O(n_nodes) → O(n_domains). Also culls elements outside the viewport.

  private _viewportBounds(vpW: number, vpH: number, pad: number) {
    const t = this._transform;
    return {
      x0: -t.x / t.k - pad, y0: -t.y / t.k - pad,
      x1: (vpW - t.x) / t.k + pad, y1: (vpH - t.y) / t.k + pad,
    };
  }

  private _drawEdgesBatched(ctx: CanvasRenderingContext2D, vpW: number, vpH: number) {
    const { x0, y0, x1, y1 } = this._viewportBounds(vpW, vpH, 300);

    // Group visible edges by stroke colour (one beginPath per colour)
    const batches = new Map<string, Array<[number, number, number, number]>>();
    for (const e of this._edges) {
      const s = e.source as SimNode, t = e.target as SimNode;
      if (s.x == null || t.x == null) continue;
      // Cull: skip if both endpoints are on the same off-screen side
      if ((s.x < x0 && t.x < x0) || (s.x > x1 && t.x > x1) ||
          (s.y! < y0 && t.y! < y0) || (s.y! > y1 && t.y! > y1)) continue;
      const color = CRIT_STROKE[e.criticality] ?? '#6b7280';
      if (!batches.has(color)) batches.set(color, []);
      batches.get(color)!.push([s.x!, s.y!, t.x!, t.y!]);
    }

    for (const [color, lines] of batches) {
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = color;
      ctx.lineWidth   = 0.6;
      ctx.beginPath();
      for (const [ax, ay, bx, by] of lines) { ctx.moveTo(ax, ay); ctx.lineTo(bx, by); }
      ctx.stroke();
      ctx.restore();
    }
  }

  private _drawNodesBatched(
    ctx: CanvasRenderingContext2D, vpW: number, vpH: number,
    sel: any, neighborIds: Set<string>,
  ) {
    const k = this._transform.k;
    if (k < 0.18) {
      // Dot mode: group by domain accent colour; cull off-screen nodes
      const { x0, y0, x1, y1 } = this._viewportBounds(vpW, vpH, 20);
      const batches = new Map<string, Array<[number, number]>>();
      for (const n of this._nodes) {
        if (n.x == null || n.y == null) continue;
        if (n.x < x0 || n.x > x1 || n.y < y0 || n.y > y1) continue;
        const color = ds(n.domain).accent;
        if (!batches.has(color)) batches.set(color, []);
        batches.get(color)!.push([n.x, n.y]);
      }
      ctx.globalAlpha = 0.75;
      for (const [color, pts] of batches) {
        ctx.fillStyle = color;
        ctx.beginPath();
        // moveTo(x+r, y) before arc prevents the browser drawing a connecting
        // line between consecutive arcs inside the same beginPath.
        for (const [nx, ny] of pts) { ctx.moveTo(nx + 3, ny); ctx.arc(nx, ny, 3, 0, Math.PI * 2); }
        ctx.fill();
      }
    } else {
      // Small-box mode (0.18 ≤ k < 0.35): still per-node but viewport-culled
      const { x0, y0, x1, y1 } = this._viewportBounds(vpW, vpH, 40);
      for (const n of this._nodes) {
        if (n.x == null || n.y == null) continue;
        if (n.x < x0 || n.x > x1 || n.y < y0 || n.y > y1) continue;
        this._drawNode(ctx, n, sel, neighborIds, this.gs.pairwiseFocusValue);
      }
    }
  }

  // ── Grid ──────────────────────────────────────────────────────────────────

  private _drawGrid(ctx: CanvasRenderingContext2D, W: number, H: number, t: d3.ZoomTransform) {
    const step = 40;
    const x0 = -t.x / t.k, y0 = -t.y / t.k;
    const x1 = (W - t.x) / t.k, y1 = (H - t.y) / t.k;
    ctx.save();
    ctx.globalAlpha = 0.04;
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    for (let x = Math.floor(x0/step)*step; x < x1; x += step) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = Math.floor(y0/step)*step; y < y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
    ctx.restore();
  }

  // ── Edge ──────────────────────────────────────────────────────────────────

  private _drawEdge(
    ctx: CanvasRenderingContext2D, e: SimEdge,
    sel: any, hasPins: boolean, pinColors: Map<string, string>,
    pw: PairwiseFocus | null = null,
  ) {
    const s = e.source as SimNode, t = e.target as SimNode;
    if (s.x == null || t.x == null) return;

    const k = this._transform.k;

    // ── LOD: at very low zoom draw a simple straight line (no Bezier / label)
    if (k < 0.35) {
      const color = CRIT_STROKE[e.criticality] ?? '#6b7280';
      let op: number;
      if (pw) {
        op = pw.edgeIds.has(e.id) ? 0.9 : 0.04;
      } else {
        op = sel ? (sel.kind === 'edge' ? (sel.edge?.id === e.id ? 0.9 : 0.08)
                                        : (((e.source as SimNode).id === sel.node?.id ||
                                            (e.target as SimNode).id === sel.node?.id) ? 0.9 : 0.08))
                 : 0.35;
      }
      ctx.save();
      ctx.globalAlpha = op;
      ctx.strokeStyle = color;
      ctx.lineWidth   = 0.6;
      ctx.beginPath(); ctx.moveTo(s.x!, s.y!); ctx.lineTo(t.x!, t.y!);
      ctx.stroke();
      ctx.restore();
      return;
    }

    // Opacity
    let op = 0.78;
    if (pw) {
      op = pw.edgeIds.has(e.id) ? 1 : 0.04;
    } else if (sel) {
      if (sel.kind === 'edge')
        op = sel.edge?.id === e.id ? 1 : 0.04;
      else if (sel.kind === 'node') {
        const src = (e.source as SimNode).id, tgt = (e.target as SimNode).id;
        op = (src === sel.node?.id || tgt === sel.node?.id) ? 1 : 0.04;
      }
    }

    const color = hasPins
      ? (pinColors.get(e.id) ?? CRIT_STROKE[e.criticality] ?? '#6b7280')
      : (CRIT_STROKE[e.criticality] ?? '#6b7280');
    const lw    = hasPins ? 1.8 : (CRIT_WIDTH[e.criticality] ?? 1.5);
    const dash  = hasPins ? [] : (CRIT_DASH[e.criticality] ? [3, 6] : []);

    const dx = t.x - s.x!, dy = t.y! - s.y!;
    const len = Math.sqrt(dx*dx + dy*dy) || 1;
    const nx = dx/len, ny = dy/len;
    const gap  = 5;
    const sOff = this._rectEdgeDist(nx, ny, NW + gap*2, NH + gap*2);
    const tOff = this._rectEdgeDist(nx, ny, NW + gap*2, NH + gap*2);
    const sx = len > sOff + tOff ? s.x! + nx * sOff      : s.x!;
    const sy = len > sOff + tOff ? s.y! + ny * sOff      : s.y!;
    const ex = len > sOff + tOff ? t.x! - nx * (tOff+10) : t.x!;
    const ey = len > sOff + tOff ? t.y! - ny * (tOff+10) : t.y!;

    const f   = this._edgeFactor.get(e.id) ?? 0.16;
    const pmx = (sx+ex)/2, pmy = (sy+ey)/2;
    const ox  = (ey-sy)*f, oy  = (ex-sx)*f;
    const cpx = pmx+ox,    cpy = pmy-oy;

    ctx.save();
    ctx.globalAlpha = op;
    ctx.strokeStyle = color;
    ctx.lineWidth   = lw;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(cpx, cpy, ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrow
    this._arrow(ctx, ex, ey, Math.atan2(ey - cpy, ex - cpx), color, 9);

    // Label — information_entity is now string[]
    const lx  = pmx + ox*0.35, ly = pmy - oy*0.35;
    const ie  = e.information_entity;
    const raw = Array.isArray(ie) ? ie.join(' · ') : (ie ?? '');
    const lbl = raw.length > 32 ? raw.slice(0, 31) + '…' : raw;
    ctx.font = '9.5px "IBM Plex Mono",monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // measureText is called every frame for every visible edge — cache to avoid
    // repeated font-metric lookups (font layout can be 0.02–0.05 ms each call).
    let tw = this._labelWidthCache.get(lbl);
    if (tw === undefined) { tw = ctx.measureText(lbl).width; this._labelWidthCache.set(lbl, tw); }
    ctx.globalAlpha = op * 0.9;
    ctx.fillStyle = '#030810';
    ctx.fillRect(lx - tw/2 - 5, ly - 7, tw + 10, 14);
    ctx.globalAlpha = op;
    ctx.fillStyle = color;
    ctx.fillText(lbl, lx, ly);
    ctx.restore();
  }

  // ── Node ──────────────────────────────────────────────────────────────────

  private _drawNode(
    ctx: CanvasRenderingContext2D, n: SimNode,
    sel: any, neighborIds: Set<string>,
    pw: PairwiseFocus | null = null,
  ) {
    if (n.x == null || n.y == null) return;

    const k  = this._transform.k;
    const st = ds(n.domain);
    const x  = n.x!, y = n.y!;

    // Pairwise opacity: 1 for the two nodes, very dim for everything else
    const isPairNode = pw ? (n.id === pw.nodeA || n.id === pw.nodeB) : false;

    // ── LOD: dot at very low zoom ──────────────────────────────────────────
    if (k < 0.18) {
      const isSelected = sel?.kind === 'node' && sel.node?.id === n.id;
      ctx.save();
      ctx.globalAlpha = pw ? (isPairNode ? 1 : 0.06)
                           : (sel ? (isSelected || neighborIds.has(n.id) ? 1 : 0.2) : 0.85);
      ctx.beginPath();
      ctx.arc(x, y, (isSelected || isPairNode) ? 7 : 4, 0, Math.PI * 2);
      ctx.fillStyle = isPairNode ? '#60a5fa' : (isSelected ? st.accent : (n.active === false ? '#ef4444' : st.accent));
      ctx.fill();
      ctx.restore();
      return;
    }

    // ── LOD: small coloured box, no text ──────────────────────────────────
    if (k < 0.55) {
      const bw = 28, bh = 18;
      const isSelected = sel?.kind === 'node' && sel.node?.id === n.id;
      ctx.save();
      ctx.globalAlpha = pw ? (isPairNode ? 1 : 0.06)
                           : (sel ? (isSelected || neighborIds.has(n.id) ? 1 : 0.15) : 0.9);
      this._rRect(ctx, x - bw/2, y - bh/2, bw, bh, 4);
      ctx.fillStyle = st.bg; ctx.fill();
      ctx.strokeStyle = (isSelected || isPairNode) ? st.accent : st.border;
      ctx.lineWidth = (isSelected || isPairNode) ? 2 : 1;
      ctx.stroke();
      this._rRect(ctx, x - bw/2, y - bh/2, 3, bh, 2);
      ctx.fillStyle = st.accent; ctx.fill();
      ctx.restore();
      return;
    }

    // ── Full card (standard zoom) ──────────────────────────────────────────
    let op: number;
    if (pw) {
      op = isPairNode ? 1 : 0.07;
    } else if (sel) {
      if (sel.kind === 'node') {
        if (sel.node?.id === n.id) op = 1;
        else if (neighborIds.has(n.id)) op = 0.88;
        else op = 0.12;
      } else if (sel.kind === 'edge') {
        const sn = sel.edge?.sourceNode?.id ?? sel.edge?.source;
        const tn = sel.edge?.targetNode?.id ?? sel.edge?.target;
        op = (n.id === sn || n.id === tn) ? 1 : 0.18;
      } else { op = 1; }
    } else { op = 1; }

    const isSelected  = !pw && sel?.kind === 'node' && sel.node?.id === n.id;
    const isNeighbour = !pw && sel?.kind === 'node' && neighborIds.has(n.id);

    ctx.save();
    ctx.globalAlpha = op;

    // Glow — for selected node, neighbour, or either of the pairwise nodes
    if (isSelected || isPairNode)  { ctx.shadowColor = '#60a5fa'; ctx.shadowBlur = 18; }
    else if (isNeighbour) { ctx.shadowColor = '#60a5fa'; ctx.shadowBlur = 8; }

    // Background rect
    this._rRect(ctx, x - NW/2, y - NH/2, NW, NH, 10);
    ctx.fillStyle = st.bg; ctx.fill();
    ctx.strokeStyle = (isSelected || isNeighbour || isPairNode) ? st.accent : st.border;
    ctx.lineWidth   = (isSelected || isPairNode) ? 2.5 : isNeighbour ? 2 : 1.5;
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // Left accent bar
    this._rRect(ctx, x - NW/2, y - NH/2, 4, NH, 3);
    ctx.fillStyle = st.accent; ctx.fill();

    // Name
    ctx.font      = 'bold 13px "IBM Plex Sans",sans-serif';
    ctx.fillStyle = st.text;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(n.name, x, y - 8);

    // Domain
    ctx.font      = '9px "IBM Plex Mono",monospace';
    ctx.fillStyle = st.accent;
    ctx.fillText(n.domain.toUpperCase(), x, y + 11);

    // Active dot
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(x + NW/2 - 9, y - NH/2 + 9, 5, 0, Math.PI*2);
    ctx.fillStyle   = n.active === false ? '#ef4444' : '#22c55e';
    ctx.fill();
    ctx.strokeStyle = '#030810';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    ctx.restore();
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private _rRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.lineTo(x+w-r, y); ctx.arcTo(x+w, y,   x+w, y+r,   r);
    ctx.lineTo(x+w, y+h-r); ctx.arcTo(x+w, y+h, x+w-r, y+h, r);
    ctx.lineTo(x+r, y+h); ctx.arcTo(x,   y+h, x,   y+h-r, r);
    ctx.lineTo(x, y+r);   ctx.arcTo(x,   y,   x+r, y,     r);
    ctx.closePath();
  }

  private _arrow(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string, sz: number) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(-sz*1.3, -sz*0.55); ctx.lineTo(-sz*1.3, sz*0.55);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  }

  private _rectEdgeDist(nx: number, ny: number, w: number, h: number): number {
    return Math.min(
      Math.abs(nx) > 1e-9 ? (w/2) / Math.abs(nx) : Infinity,
      Math.abs(ny) > 1e-9 ? (h/2) / Math.abs(ny) : Infinity,
    );
  }

  // ── Hit testing ───────────────────────────────────────────────────────────

  private _hitNode(mx: number, my: number): SimNode | undefined {
    for (let i = this._nodes.length - 1; i >= 0; i--) {
      const n = this._nodes[i];
      if (n.x != null && n.y != null &&
          Math.abs(mx - n.x) < NW/2 && Math.abs(my - n.y) < NH/2) return n;
    }
    return undefined;
  }

  private _hitEdge(mx: number, my: number): SimEdge | undefined {
    for (const e of this._edges) {
      const s = e.source as SimNode, t = e.target as SimNode;
      if (s.x == null || t.x == null) continue;
      const f  = this._edgeFactor.get(e.id) ?? 0.16;
      const ox = (t.y! - s.y!) * f, oy = (t.x! - s.x!) * f;
      const lx = (s.x! + t.x!)/2 + ox*0.35;
      const ly = (s.y! + t.y!)/2 - oy*0.35;
      if (Math.abs(mx - lx) < 42 && Math.abs(my - ly) < 12) return e;
    }
    return undefined;
  }

  // ── Pan to edge ───────────────────────────────────────────────────────────

  private _panToEdge(edgeId: string) {
    if (!this._zoom) return;
    const e = this._edges.find(e => e.id === edgeId);
    if (!e) return;
    const s = e.source as SimNode, t = e.target as SimNode;
    if (s.x == null || s.y == null || t.x == null || t.y == null) return;
    const canvas = this.canvasRef.nativeElement;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const k  = this._transform.k;
    const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
    d3.select(canvas).transition().duration(480)
      .call(this._zoom.transform, d3.zoomIdentity.translate(W/2 - k*mx, H/2 - k*my).scale(k));
  }

  // ── Clear ─────────────────────────────────────────────────────────────────

  private _clear() {
    this.sim?.stop();
    this._nodes = []; this._edges = [];
    const ctx = this._ctx;
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
  }
}
