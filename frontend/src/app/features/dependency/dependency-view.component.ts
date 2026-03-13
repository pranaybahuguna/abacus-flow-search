// dependency-view.component.ts
// Answers: "What does this system/process touch end-to-end?"
// Shows upstream (what it depends on) AND downstream (what it feeds)
import { Component, inject, signal } from '@angular/core';
import { CommonModule }              from '@angular/common';
import { FormsModule }               from '@angular/forms';
import { of }                        from 'rxjs';
import { tap }                       from 'rxjs/operators';
import { DependencyService }         from '../../core/services/dependency.service';
import { GraphService }              from '../../core/services/graph.service';
import {
  Footprint, FootprintNode, AffectedProcess, DependencyResponse,
  ViaFlow, SimNode, ds, SEVERITY_COLOR,
} from '../../core/models/models';

/** Distinct accent colours cycled across BP chips — each BP gets a unique hue. */
const BP_COLORS: { border: string; bg: string; text: string }[] = [
  { border: '#f59e0b', bg: 'rgba(245,158,11,.08)',  text: '#fbbf24' },  // amber
  { border: '#22d3ee', bg: 'rgba(34,211,238,.08)',  text: '#67e8f9' },  // cyan
  { border: '#a855f7', bg: 'rgba(168,85,247,.08)',  text: '#c084fc' },  // purple
  { border: '#22c55e', bg: 'rgba(34,197,94,.08)',   text: '#4ade80' },  // green
  { border: '#f87171', bg: 'rgba(248,113,113,.08)', text: '#fca5a5' },  // red
  { border: '#3b82f6', bg: 'rgba(59,130,246,.08)',  text: '#93c5fd' },  // blue
  { border: '#ec4899', bg: 'rgba(236,72,153,.08)',  text: '#f9a8d4' },  // pink
  { border: '#fb923c', bg: 'rgba(251,146,60,.08)',  text: '#fdba74' },  // orange
];

const EXAMPLE_GROUPS = [
  { label: 'PROCESSES', items: [
      'Cross-Border Payment', 'Trade Settlement',
      'AML and Sanctions Screening', 'Regulatory Reporting',
  ]},
  { label: 'SYSTEMS', items: [
      'Murex trading system', 'Payments Hub', 'DataWarehouse',
  ]},
];

@Component({
  selector:    'abacus-dependency-view',
  standalone:  true,
  imports:     [CommonModule, FormsModule],
  templateUrl: './dependency-view.component.html',
  styleUrls:   ['./dependency-view.component.scss'],
})
export class DependencyViewComponent {
  private ds = inject(DependencyService);
  private gs = inject(GraphService);

  query        = signal('');
  maxHops      = signal(3);
  /** ID of the system currently being fetched for the inspector — drives the loading ring on cards. */
  loadingSysId = signal<string | null>(null);

  /** Search signals for BP, upstream, downstream sections */
  bpSearch = signal('');
  upSearch = signal('');
  dnSearch = signal('');

  /** Search mode: exact = substring phrase match, similar = any-token fuzzy match */
  upMode = signal<'exact'|'similar'>('exact');
  dnMode = signal<'exact'|'similar'>('exact');

  result$  = this.ds.result$;
  loading$ = this.ds.loading$;

  exampleGroups = EXAMPLE_GROUPS;

  run(q?: string) {
    const query = q ?? this.query();
    if (!query.trim()) return;
    this.query.set(query);
    this.bpSearch.set('');
    this.upSearch.set('');
    this.dnSearch.set('');
    this.ds.analyse(query, this.maxHops()).subscribe();
  }

  pick(c: { entity_id: string; entity_type: string; name: string }) {
    this.query.set(c.name);
    this.bpSearch.set('');
    this.upSearch.set('');
    this.dnSearch.set('');
    this.ds.analyse(c.name, this.maxHops(), c.entity_id, c.entity_type).subscribe();
  }

  // ── Data helpers ─────────────────────────────────────────────────────────────

  upstreamList(fp: Footprint): FootprintNode[] {
    return Object.values(fp.upstream).sort((a, b) => a.hops - b.hops);
  }

  downstreamList(fp: Footprint): FootprintNode[] {
    return Object.values(fp.downstream).sort((a, b) => a.hops - b.hops);
  }

  topCrit(node: FootprintNode): string {
    const W: Record<string,number> = {Critical:4, High:3, Medium:2, Low:1};
    return node.via_flows.sort((a,b) => (W[b.criticality]??0) - (W[a.criticality]??0))[0]
      ?.criticality ?? 'Low';
  }

  critColor(crit: string): string {
    const m: Record<string,string> = {
      Critical:'#ef4444', High:'#f59e0b', Medium:'#6b7280', Low:'#374151'
    };
    return m[crit] ?? '#6b7280';
  }

  hopLabel(h: number): string {
    return {1:'Direct',2:'Indirect',3:'Transitive'}[h] ?? `Hop ${h}`;
  }

  /** Load footprint into the graph canvas and switch to Explore tab */
  viewInGraph(fp: Footprint) {
    const coreId = fp.core[0]?.id;
    if (coreId) this.gs.loadSubgraph(coreId, 'system').subscribe(() => this.gs.setMode('graph'));
  }

  bpList(fp: Footprint): AffectedProcess[] {
    return fp.affected_processes ?? [];
  }

  filteredBpList(fp: Footprint): AffectedProcess[] {
    const q = this.bpSearch().trim().toLowerCase();
    if (!q) return this.bpList(fp);
    return this.bpList(fp).filter(bp => bp.name.toLowerCase().includes(q));
  }

  filteredUpstreamList(fp: Footprint): FootprintNode[] {
    const q = this.upSearch().trim().toLowerCase();
    if (!q) return this.upstreamList(fp);
    const mode = this.upMode();
    return this.upstreamList(fp)
      .map(n => ({ n, s: this._scoreNode(n, q, mode) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s)
      .map(({ n }) => n);
  }

  filteredDownstreamList(fp: Footprint): FootprintNode[] {
    const q = this.dnSearch().trim().toLowerCase();
    if (!q) return this.downstreamList(fp);
    const mode = this.dnMode();
    return this.downstreamList(fp)
      .map(n => ({ n, s: this._scoreNode(n, q, mode) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s)
      .map(({ n }) => n);
  }

  /** Score for an upstream card — 0-100 int, shown as badge in the template. */
  upScorePct(node: FootprintNode): number {
    const q = this.upSearch().trim().toLowerCase();
    if (!q) return 0;
    return Math.round(this._scoreNode(node, q, this.upMode()) * 100);
  }

  /** Score for a downstream card — 0-100 int. */
  dnScorePct(node: FootprintNode): number {
    const q = this.dnSearch().trim().toLowerCase();
    if (!q) return 0;
    return Math.round(this._scoreNode(node, q, this.dnMode()) * 100);
  }

  /** Colour for the score badge: green ≥70 · amber ≥40 · red <40 */
  matchColor(pct: number): string {
    if (pct >= 70) return '#34d399';
    if (pct >= 40) return '#f59e0b';
    return '#f87171';
  }

  // ── Search helpers ───────────────────────────────────────────────────────────

  /** Collect all searchable text targets from a node (name + domain + flow entities). */
  private _nodeTargets(node: FootprintNode): string[] {
    const entities = node.via_flows.flatMap(f => {
      const ie = (f as any).information_entity;
      if (!ie) return [] as string[];
      return (Array.isArray(ie) ? ie : [ie]) as string[];
    });
    return [node.name, node.domain, ...entities];
  }

  /**
   * Unified score — 0.0 … 1.0.
   *
   * Exact mode (phrase):
   *   Name match  → 60 pts.
   *   Each matching flow-entity label → 10 pts, capped at 40.
   *   score = min(1, nameHit×0.6 + flowHits×0.1)
   *
   * Similar mode (token):
   *   score = matchedTokens / totalTokens
   *   (every query word is looked for independently across name+domain+flows)
   */
  private _scoreNode(node: FootprintNode, q: string, mode: 'exact' | 'similar'): number {
    if (!q) return 1;
    const targets = this._nodeTargets(node);

    if (mode === 'exact') {
      const nameHit  = node.name.toLowerCase().includes(q) ? 1 : 0;
      // targets[0]=name, [1]=domain, [2+]=flow entities
      const flowHits = targets.slice(2).filter(t => t.toLowerCase().includes(q)).length;
      return Math.min(1, nameHit * 0.6 + flowHits * 0.1);
    } else {
      const tokens   = q.split(/\s+/).filter(t => t.length >= 2);
      if (tokens.length === 0) return 1;
      const haystack = targets.join(' ').toLowerCase();
      const matched  = tokens.filter(tok => haystack.includes(tok)).length;
      return matched / tokens.length;
    }
  }

  /** Scroll the BP chip strip by a fixed amount. */
  scrollBpStrip(el: HTMLElement, dir: number) {
    el.scrollBy({ left: dir * 240, behavior: 'smooth' });
  }

  /** Colour at slot i (cycles through the BP palette). */
  bpColor(i: number) { return BP_COLORS[i % BP_COLORS.length]; }

  /** Click a BP chip → load its subgraph and switch to EXPLORE mode. */
  viewBpInGraph(bp: AffectedProcess) {
    this.gs.contextBp.set(bp.name);
    this.gs.loadSubgraph(bp.id, 'business_process').subscribe(() => this.gs.setMode('graph'));
  }

  accent(domain: string) { return ds(domain).accent; }
  domBg(domain: string)  { return ds(domain).bg; }
  domBd(domain: string)  { return ds(domain).border; }

  // ── Inspector integration ────────────────────────────────────────────────────

  /**
   * Returns the cached subgraph if it already contains `sysId`,
   * otherwise fetches via /api/graph (WITHOUT touching the canvas subgraph).
   */
  private _ensureSubgraph(sysId: string) {
    const cached = this.gs.inspectorSgCache();
    if (cached && cached.nodes.some(n => n.id === sysId)) {
      return of(cached);
    }
    return this.gs.fetchSubgraph(sysId, 'system').pipe(
      tap(sg => this.gs.inspectorSgCache.set(sg)),
    );
  }

  /** Click a system card → open the inspector panel for that system. */
  selectSystem(sysId: string) {
    this.loadingSysId.set(sysId);
    this._ensureSubgraph(sysId).subscribe(sg => {
      const simNode = sg.nodes.find(n => n.id === sysId);
      if (simNode) this.gs.selectNode(simNode);
      this.loadingSysId.set(null);
    });
  }

  /** Click a flow bullet inside a system card → open the inspector panel for that flow. */
  selectViaFlow(vf: ViaFlow, sysId: string) {
    this._ensureSubgraph(sysId).subscribe(sg => {
      const flow = sg.edges.find(e => e.id === vf.flow_id);
      if (!flow) return;
      const sourceNode = sg.nodes.find(n => n.id === flow.source_app) as SimNode | undefined;
      const targetNode = sg.nodes.find(n => n.id === flow.sinc_app) as SimNode | undefined;
      this.gs.selectEdge({
        ...flow,
        source: flow.source_app, target: flow.sinc_app,
        sourceNode, targetNode,
      });
    });
  }
}
