// graph-canvas.component.ts — Canvas-based D3 force graph
// Replaces the SVG renderer with a Canvas 2D context.
// D3 force simulation is unchanged; only the drawing pipeline differs.
// Canvas can handle 10 000+ nodes at 60 fps where SVG stalls at ~500.
import { Component, ElementRef, ViewChild, OnDestroy, AfterViewInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as d3          from 'd3';
import { Subject, takeUntil } from 'rxjs';
import { GraphService, PinnedEntity } from '../../core/services/graph.service';
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
  private _edgeFactor = new Map<string, number>();
  private _dragMoved  = false;
  private destroy     = new Subject<void>();

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
  }

  ngOnDestroy() {
    this.sim?.stop();
    if (this._raf) cancelAnimationFrame(this._raf);
    this.destroy.next(); this.destroy.complete();
  }

  // ── Frame scheduling ───────────────────────────────────────────────────────

  private _scheduleFrame() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._drawFrame(); });
  }

  // ── Interaction setup (called once) ───────────────────────────────────────

  private _initInteraction(canvas: HTMLCanvasElement) {
    const sel = d3.select(canvas);

    // ── Zoom ────────────────────────────────────────────────────────────────
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

    // ── Drag (node pinning) ──────────────────────────────────────────────────
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
          if (!ev.active) this.sim?.alphaTarget(0.3).restart();
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
          }
        })
        .on('end', (ev: any) => {
          if (!ev.active) this.sim?.alphaTarget(0);
          const node = (ev.subject as any)?._node as SimNode | undefined;
          // No movement → treat as a node click
          if (!this._dragMoved && node) this.gs.selectNode(node);
          // Always reset so subsequent edge/background clicks aren't blocked
          this._dragMoved = false;
        }),
    );

    // ── Cursor (pointer hand over nodes / edge labels) ────────────────────
    sel.on('mousemove.cursor', (ev: MouseEvent) => {
      const [mx, my] = this._transform.invert([ev.offsetX, ev.offsetY]);
      canvas.style.cursor =
        (this._hitNode(mx, my) || this._hitEdge(mx, my)) ? 'pointer' : 'default';
    });

    // ── Click (edge label or background) ──────────────────────────────────
    // Node clicks are handled in drag.end above; this handles everything else.
    sel.on('click.canvas', (ev: MouseEvent) => {
      // D3 drag suppresses the browser click event after a real drag,
      // but _dragMoved is a safety net in case it slips through.
      if (this._dragMoved) return;
      const [mx, my] = this._transform.invert([ev.offsetX, ev.offsetY]);
      if (this._hitNode(mx, my)) return;   // drag.end already handled this
      const e = this._hitEdge(mx, my);
      if (e) {
        this.gs.selectEdge({
          ...e, source: e.source_app, target: e.sinc_app,
          sourceNode: e.source as SimNode, targetNode: e.target as SimNode,
        });
      } else {
        this.gs.clearSelection();
      }
    });
  }

  // ── Build (called on every new subgraph) ──────────────────────────────────

  private _render(sg: SubgraphResponse) {
    this.sim?.stop();
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }

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

    // Reset zoom to identity for each new subgraph
    this._transform = d3.zoomIdentity;
    if (this._zoom) d3.select(canvas).call(this._zoom.transform, d3.zoomIdentity);

    // ── Nodes & edges ──────────────────────────────────────────────────────
    const nodes: SimNode[] = sg.nodes.map(n => ({
      ...n, x: W/2 + (Math.random()-.5)*480, y: H/2 + (Math.random()-.5)*480,
      vx:0, vy:0, fx:null, fy:null,
    }));
    const byId = new Map(nodes.map(n => [n.id, n]));
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
      const n = pairCount.get(k)!;
      const i = pairCur.get(k) ?? 0;
      pairCur.set(k, i + 1);
      this._edgeFactor.set(e.id, n === 1 ? 0.16 : (i - (n-1)/2) * 0.22);
    });

    // ── Adaptive simulation ────────────────────────────────────────────────
    // Thresholds are generous — BP queries are no longer capped at 80 nodes
    // so graphs with 100–300+ systems must still settle in reasonable time.
    const n = nodes.length;
    const alphaDecay = n < 20  ? 0.013
                     : n < 80  ? 0.022
                     : n < 200 ? 0.035
                     :           0.055;
    const maxTicks   = n < 20  ? 0
                     : n < 80  ? 400
                     : n < 200 ? 250
                     :           150;
    // Repulsion: weaker for very large graphs so they don't explode outward
    const charge     = n < 50  ? -1600
                     : n < 150 ? -900
                     :           -500;

    this.sim = d3.forceSimulation<SimNode, SimEdge>(nodes)
      .force('link',    d3.forceLink<SimNode,SimEdge>(edges).id((d:any)=>d.id).distance(270).strength(.38))
      .force('charge',  d3.forceManyBody<SimNode>().strength(charge))
      .force('center',  d3.forceCenter(W/2, H/2))
      .force('collide', d3.forceCollide<SimNode>(115))
      .alphaDecay(alphaDecay)
      .on('tick', () => this._scheduleFrame());

    if (maxTicks > 0) {
      let ticks = 0;
      this.sim.on('tick.stopper', () => { if (++ticks >= maxTicks) this.sim?.alphaTarget(0).alpha(0); });
    }
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

    for (const e of this._edges) this._drawEdge(ctx, e, sel, hasPins, pinColors);
    for (const n of this._nodes) this._drawNode(ctx, n, sel, neighborIds);
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
  ) {
    const s = e.source as SimNode, t = e.target as SimNode;
    if (s.x == null || t.x == null) return;

    // Opacity
    let op = 0.78;
    if (sel) {
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

    // Label
    const lx = pmx + ox*0.35, ly = pmy - oy*0.35;
    const raw = e.information_entity ?? '';
    const lbl = raw.length > 30 ? raw.slice(0,29)+'…' : raw;
    ctx.font = '9.5px "IBM Plex Mono",monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(lbl).width;
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
  ) {
    if (n.x == null || n.y == null) return;

    let op = 1;
    if (sel) {
      if (sel.kind === 'node') {
        if (sel.node?.id === n.id) op = 1;
        else if (neighborIds.has(n.id)) op = 0.88;
        else op = 0.12;
      } else if (sel.kind === 'edge') {
        const sn = sel.edge?.sourceNode?.id ?? sel.edge?.source;
        const tn = sel.edge?.targetNode?.id ?? sel.edge?.target;
        op = (n.id === sn || n.id === tn) ? 1 : 0.18;
      }
    }

    const st        = ds(n.domain);
    const x = n.x!, y = n.y!;
    const isSelected  = sel?.kind === 'node' && sel.node?.id === n.id;
    const isNeighbour = sel?.kind === 'node' && neighborIds.has(n.id);

    ctx.save();
    ctx.globalAlpha = op;

    // Glow
    if (isSelected)  { ctx.shadowColor = '#60a5fa'; ctx.shadowBlur = 18; }
    else if (isNeighbour) { ctx.shadowColor = '#60a5fa'; ctx.shadowBlur = 8; }

    // Background rect
    this._rRect(ctx, x - NW/2, y - NH/2, NW, NH, 10);
    ctx.fillStyle = st.bg; ctx.fill();
    ctx.strokeStyle = (isSelected || isNeighbour) ? st.accent : st.border;
    ctx.lineWidth   = isSelected ? 2.5 : isNeighbour ? 2 : 1.5;
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
