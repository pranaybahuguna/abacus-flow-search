// graph-canvas.component.ts — D3 force-directed graph canvas
import { Component, ElementRef, ViewChild, OnDestroy, AfterViewInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as d3          from 'd3';
import { Subject, takeUntil } from 'rxjs';
import { GraphService, PinnedEntity } from '../../core/services/graph.service';
import {
  SubgraphResponse, SimNode, SimEdge, SearchCandidate,
  ds, CRIT_STROKE, CRIT_WIDTH, CRIT_DASH,
} from '../../core/models/models';

@Component({
  selector:'abacus-graph-canvas', standalone:true, imports:[CommonModule],
  templateUrl:'./graph-canvas.component.html',
  styleUrls:  ['./graph-canvas.component.scss'],
})
export class GraphCanvasComponent implements AfterViewInit, OnDestroy {
  @ViewChild('svg', {static:true}) svgRef!: ElementRef<SVGSVGElement>;

  gs        = inject(GraphService);
  subgraph$ = this.gs.subgraph$;
  selected$ = this.gs.selected$;
  loading$  = this.gs.loading$;

  critEntries = Object.entries(CRIT_STROKE) as [string,string][];
  trackPin(_: number, p: PinnedEntity): string { return p.candidate.entity_id; }

  private sim:     d3.Simulation<SimNode, SimEdge> | null = null;
  private _edges:  SimEdge[] = [];
  private destroy  = new Subject<void>();
  // Stored so _highlight() can programmatically pan the viewport
  private _zoom:   d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
  private _svgSel: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private _vW = 900; private _vH = 560;

  ngAfterViewInit() {
    this.gs.subgraph$.pipe(takeUntil(this.destroy))
      .subscribe(sg => sg ? this._render(sg) : this._clear());
    this.gs.selected$.pipe(takeUntil(this.destroy))
      .subscribe(() => this._highlight());
  }

  ngOnDestroy() { this.sim?.stop(); this.destroy.next(); this.destroy.complete(); }

  private _render(sg: SubgraphResponse) {
    this.sim?.stop();
    const el  = this.svgRef.nativeElement;
    const svg = d3.select<SVGSVGElement, unknown>(el);
    svg.selectAll('*').remove();

    const W = el.clientWidth  || 900;
    const H = el.clientHeight || 560;

    // Clone data — D3 mutates nodes with x/y — wider initial scatter = less initial overlap
    const nodes: SimNode[] = sg.nodes.map(n => ({
      ...n, x: W/2 + (Math.random()-.5)*480, y: H/2 + (Math.random()-.5)*480,
      vx:0, vy:0, fx:null, fy:null,
    }));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const edges: SimEdge[] = sg.edges
      .map(e => ({ ...e, source: byId.get(e.source) as any, target: byId.get(e.target) as any }))
      .filter(e => e.source && e.target);
    this._edges = edges;

    // Parallel edge fan-out: edges between the same source→target pair get
    // different perpendicular bezier offsets so each flow draws a distinct arc.
    // Single edges keep the base 0.16 curve; parallel edges spread ±0.22 per step.
    const pairCount = new Map<string, number>();
    edges.forEach(e => {
      const key = `${(e.source as SimNode).id}→${(e.target as SimNode).id}`;
      pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
    });
    const pairCur = new Map<string, number>();
    const edgeFactor = new Map<string, number>();
    edges.forEach(e => {
      const key = `${(e.source as SimNode).id}→${(e.target as SimNode).id}`;
      const n = pairCount.get(key)!;
      const i = pairCur.get(key) ?? 0;
      pairCur.set(key, i + 1);
      // n=1 → standard gentle arc; n>1 → spread symmetrically around 0
      edgeFactor.set(e.id, n === 1 ? 0.16 : (i - (n - 1) / 2) * 0.22);
    });

    // Snapshot pin colours at render time (set synchronously before _sg emits)
    const pinColors = this.gs.edgePinColors();
    const hasPins   = pinColors.size > 0;

    // Helper: resolve stroke for an edge (pin colour takes precedence)
    const edgeStroke = (d: SimEdge) =>
      hasPins ? (pinColors.get(d.id) ?? CRIT_STROKE[d.criticality] ?? '#6b7280')
              : (CRIT_STROKE[d.criticality] ?? '#6b7280');

    // Defs: arrowheads per criticality + pin colours + glow filter
    const defs = svg.append('defs');
    Object.entries(CRIT_STROKE).forEach(([crit, stroke]) => {
      defs.append('marker').attr('id',`arr-${crit}`)
        .attr('viewBox','0 -6 12 12').attr('refX',10).attr('refY',0)
        .attr('markerWidth',9).attr('markerHeight',9).attr('orient','auto')
        .append('path').attr('d','M0,-6L12,0L0,6').attr('fill', stroke);
    });
    if (hasPins) {
      const uniquePinColors = new Set(pinColors.values());
      uniquePinColors.forEach(color => {
        const id = `arr-pin-${color.replace('#','')}`;
        defs.append('marker').attr('id', id)
          .attr('viewBox','0 -6 12 12').attr('refX',10).attr('refY',0)
          .attr('markerWidth',9).attr('markerHeight',9).attr('orient','auto')
          .append('path').attr('d','M0,-6L12,0L0,6').attr('fill', color);
      });
    }
    const gf = defs.append('filter').attr('id','glow')
      .attr('x','-40%').attr('y','-40%').attr('width','180%').attr('height','180%');
    gf.append('feGaussianBlur').attr('stdDeviation','4').attr('result','b');
    gf.append('feFlood').attr('flood-color','#60a5fa').attr('flood-opacity','.55').attr('result','c');
    gf.append('feComposite').attr('in','c').attr('in2','b').attr('operator','in').attr('result','g');
    const fm = gf.append('feMerge');
    fm.append('feMergeNode').attr('in','g'); fm.append('feMergeNode').attr('in','SourceGraphic');

    // Soft glow for 1-hop neighbours
    const gn = defs.append('filter').attr('id','glow-nb')
      .attr('x','-30%').attr('y','-30%').attr('width','160%').attr('height','160%');
    gn.append('feGaussianBlur').attr('stdDeviation','2.5').attr('result','b');
    gn.append('feFlood').attr('flood-color','#60a5fa').attr('flood-opacity','.28').attr('result','c');
    gn.append('feComposite').attr('in','c').attr('in2','b').attr('operator','in').attr('result','g');
    const fnm = gn.append('feMerge');
    fnm.append('feMergeNode').attr('in','g'); fnm.append('feMergeNode').attr('in','SourceGraphic');

    // Background grid
    const grid = svg.append('g').attr('opacity','.04');
    for (let i=0;i<H;i+=40) grid.append('line').attr('x1',0).attr('y1',i).attr('x2',W).attr('y2',i).attr('stroke','#3b82f6').attr('stroke-width','.5');
    for (let i=0;i<W;i+=40) grid.append('line').attr('x1',i).attr('y1',0).attr('x2',i).attr('y2',H).attr('stroke','#3b82f6').attr('stroke-width','.5');

    // Zoom container — store reference so _highlight() can pan the viewport
    this._vW = W; this._vH = H;
    this._svgSel = svg;
    const g = svg.append('g').attr('class','zg');
    this._zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([.15,4])
      .on('zoom', e => g.attr('transform', e.transform as unknown as string));
    svg.call(this._zoom);
    svg.on('click', () => this.gs.clearSelection());

    // Simulation — longer links + stronger repulsion = well-spread layout
    this.sim = d3.forceSimulation<SimNode, SimEdge>(nodes)
      .force('link',    d3.forceLink<SimNode,SimEdge>(edges).id((d:any)=>d.id).distance(270).strength(.38))
      .force('charge',  d3.forceManyBody<SimNode>().strength(-1600))
      .force('center',  d3.forceCenter(W/2, H/2))
      .force('collide', d3.forceCollide<SimNode>(115))
      .alphaDecay(0.013);  // slower decay → more time to reach spread equilibrium

    const NW=152, NH=56;

    // Edges
    const eG  = g.append('g');
    const eSel = eG.selectAll<SVGGElement,SimEdge>('g').data(edges).join('g')
      .attr('class','edge').style('cursor','pointer')
      .on('click', (ev, d) => {
        ev.stopPropagation();
        this.gs.selectEdge({
          ...d, source: (d.source as SimNode).id, target: (d.target as SimNode).id,
          sourceNode: d.source as SimNode, targetNode: d.target as SimNode,
        });
      });
    eSel.append('path').attr('fill','none')
      .attr('stroke',           d => edgeStroke(d))
      .attr('stroke-width',     d => hasPins ? 1.8 : (CRIT_WIDTH[d.criticality] ?? 1.5))
      .attr('stroke-dasharray', d => hasPins ? null : (CRIT_DASH[d.criticality] ?? null))
      .attr('marker-end', d => {
        if (hasPins) {
          const c = pinColors.get(d.id);
          if (c) return `url(#arr-pin-${c.replace('#','')})`;
        }
        return `url(#arr-${d.criticality})`;
      })
      .attr('opacity', .82);
    eSel.append('rect').attr('rx',3).attr('fill','#030810').attr('opacity',.9);
    eSel.append('text').attr('text-anchor','middle').attr('dominant-baseline','middle')
      .attr('font-size','9.5px').attr('font-family','IBM Plex Mono,monospace')
      .attr('pointer-events','none')
      .attr('fill', d => edgeStroke(d))
      .text(d => d.data_entity.length>30 ? d.data_entity.slice(0,29)+'…' : d.data_entity);

    // Nodes
    const nG  = g.append('g');
    const nSel = nG.selectAll<SVGGElement,SimNode>('g').data(nodes).join('g')
      .attr('class','node').style('cursor','pointer')
      .on('click', (ev,d) => { ev.stopPropagation(); this.gs.selectNode(d); })
      .call(d3.drag<SVGGElement,SimNode>()
        .on('start', (e,d) => { if (!e.active) this.sim?.alphaTarget(.3).restart(); d.fx=d.x; d.fy=d.y; })
        .on('drag',  (e,d) => { d.fx=e.x; d.fy=e.y; })
        .on('end',   (e,d) => { if (!e.active) this.sim?.alphaTarget(0); d.fx=null; d.fy=null; }));
    nSel.append('rect')
      .attr('x',-NW/2).attr('y',-NH/2).attr('width',NW).attr('height',NH).attr('rx',10)
      .attr('fill',   d => ds(d.domain).bg)
      .attr('stroke', d => ds(d.domain).border)
      .attr('stroke-width',1.5);
    nSel.append('rect')
      .attr('x',-NW/2).attr('y',-NH/2).attr('width',4).attr('height',NH).attr('rx',3)
      .attr('fill', d => ds(d.domain).accent);
    nSel.append('text').attr('y',-8).attr('text-anchor','middle')
      .attr('font-size','13px').attr('font-weight','600')
      .attr('font-family','IBM Plex Sans,sans-serif')
      .attr('fill', d => ds(d.domain).text).text(d => d.name);
    nSel.append('text').attr('y',11).attr('text-anchor','middle')
      .attr('font-size','9px').attr('font-family','IBM Plex Mono,monospace')
      .attr('fill', d => ds(d.domain).accent).text(d => d.domain.toUpperCase());

    // Tick — clip edge paths to node rectangle boundaries so arrows land at node edges
    // rectEdgeDist: distance from node center to rectangle boundary in direction (nx,ny)
    const rectEdgeDist = (nx: number, ny: number, w: number, h: number) =>
      Math.min(
        Math.abs(nx) > 1e-9 ? (w/2) / Math.abs(nx) : Infinity,
        Math.abs(ny) > 1e-9 ? (h/2) / Math.abs(ny) : Infinity,
      );

    this.sim.on('tick', () => {
      eSel.each(function(d) {
        const s = d.source as SimNode, t = d.target as SimNode;
        const dx = t.x! - s.x!, dy = t.y! - s.y!;
        const len = Math.sqrt(dx*dx + dy*dy) || 1;
        const nx = dx/len, ny = dy/len;

        // Clip start/end to node edge + 5px gap
        const gap = 5;
        const sOff = rectEdgeDist(nx, ny, NW + gap*2, NH + gap*2);
        const tOff = rectEdgeDist(nx, ny, NW + gap*2, NH + gap*2);

        // Guard: if nodes are too close the clipped path would cross — fall back to center points
        const sx = len > sOff + tOff ? s.x! + nx * sOff : s.x!;
        const sy = len > sOff + tOff ? s.y! + ny * sOff : s.y!;
        const ex = len > sOff + tOff ? t.x! - nx * tOff : t.x!;
        const ey = len > sOff + tOff ? t.y! - ny * tOff : t.y!;

        // Bezier control: perpendicular offset per edge (parallel edges fan out)
        const f = edgeFactor.get(d.id) ?? 0.16;
        const mx=(sx+ex)/2, my=(sy+ey)/2;
        const ox=(ey-sy)*f, oy=(ex-sx)*f;

        d3.select(this).select<SVGPathElement>('path')
          .attr('d',`M${sx},${sy} Q${mx+ox},${my-oy} ${ex},${ey}`);

        const lx=mx+ox*.35, ly=my-oy*.35;
        const txt = d3.select(this).select<SVGTextElement>('text').attr('x',lx).attr('y',ly);
        try {
          const bb = txt.node()!.getBBox();
          d3.select(this).select<SVGRectElement>('rect')
            .attr('x',bb.x-5).attr('y',bb.y-3)
            .attr('width',bb.width+10).attr('height',bb.height+6);
        } catch(_) {}
      });
      nSel.attr('transform', d => `translate(${d.x},${d.y})`);
    });
  }

  private _highlight() {
    const el  = this.svgRef?.nativeElement; if (!el) return;
    const svg = d3.select(el);
    const sel = this.gs.selectionValue;

    // Compute 1-hop neighbour IDs for the selected node
    const neighborIds = new Set<string>();
    if (sel?.kind === 'node' && sel.node) {
      const selId = sel.node.id;
      this._edges.forEach(e => {
        const src = (e.source as SimNode).id;
        const tgt = (e.target as SimNode).id;
        if (src === selId) neighborIds.add(tgt);
        if (tgt === selId) neighborIds.add(src);
      });
    }

    // Node opacity: 3-tier — selected=1, neighbour=0.88, far=0.12
    svg.selectAll<SVGGElement,SimNode>('g.node')
      .attr('opacity', d => {
        if (!sel) return 1;
        if (sel.kind === 'node') {
          if (sel.node?.id === d.id)   return 1;
          if (neighborIds.has(d.id))   return 0.88;
          return 0.12;
        }
        if (sel.kind === 'edge') {
          const sn = sel.edge?.sourceNode?.id ?? (sel.edge?.source as any);
          const tn = sel.edge?.targetNode?.id ?? (sel.edge?.target as any);
          return (d.id === sn || d.id === tn) ? 1 : .18;
        }
        return 1;
      });

    // Node rect: glow on selected, soft glow + accent border on neighbours
    svg.selectAll<SVGGElement,SimNode>('g.node rect:first-child')
      .attr('filter', (d: SimNode) => {
        if (sel?.kind === 'node' && sel.node?.id === d.id) return 'url(#glow)';
        if (sel?.kind === 'node' && neighborIds.has(d.id)) return 'url(#glow-nb)';
        return null;
      })
      .attr('stroke', (d: SimNode) => {
        if (sel?.kind === 'node' && sel.node?.id === d.id) return ds(d.domain).accent;
        if (sel?.kind === 'node' && neighborIds.has(d.id)) return ds(d.domain).accent;
        return ds(d.domain).border;
      })
      .attr('stroke-width', (d: SimNode) => {
        if (sel?.kind === 'node' && sel.node?.id === d.id) return 2.5;
        if (sel?.kind === 'node' && neighborIds.has(d.id)) return 2;
        return 1.5;
      });

    // Edge group opacity — targets the whole <g class="edge"> so path + label rect + label text all dim together
    svg.selectAll<SVGGElement,SimEdge>('g.edge')
      .attr('opacity', d => {
        if (!sel) return .78;
        if (sel.kind === 'edge' && sel.edge?.id === d.id) return 1;
        if (sel.kind === 'node') {
          const src = (d.source as SimNode).id, tgt = (d.target as SimNode).id;
          if (src === sel.node?.id || tgt === sel.node?.id) return 1;
        }
        return .04;   // dim unrelated edges + their labels completely
      });

    // Pan viewport to edge midpoint when an edge is selected (from panel or graph click)
    if (sel?.kind === 'edge' && sel.edge) this._panToEdge(sel.edge.id);
  }

  /** Smoothly pan (preserving zoom scale) so the selected edge's midpoint is centred */
  private _panToEdge(edgeId: string) {
    if (!this._zoom || !this._svgSel) return;
    const e = this._edges.find(e => e.id === edgeId);
    if (!e) return;
    const s = e.source as SimNode, t = e.target as SimNode;
    if (s.x == null || s.y == null || t.x == null || t.y == null) return;
    const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
    const k  = d3.zoomTransform(this._svgSel.node()!).k;
    const tx = this._vW / 2 - k * mx, ty = this._vH / 2 - k * my;
    this._svgSel.transition().duration(480)
      .call(this._zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
  }

  private _clear() {
    this.sim?.stop();
    d3.select(this.svgRef?.nativeElement).selectAll('*').remove();
  }
}
