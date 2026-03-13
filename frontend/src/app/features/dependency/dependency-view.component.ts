// dependency-view.component.ts
// Answers: "What does this system/process touch end-to-end?"
// Shows upstream (what it depends on) AND downstream (what it feeds)
import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule }              from '@angular/common';
import { FormsModule }               from '@angular/forms';
import { HttpClient }                from '@angular/common/http';
import { of, Subject, EMPTY }       from 'rxjs';
import { tap, debounceTime, switchMap, takeUntil, catchError } from 'rxjs/operators';
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
export class DependencyViewComponent implements OnInit, OnDestroy {
  private ds   = inject(DependencyService);
  private gs   = inject(GraphService);
  private http = inject(HttpClient);

  query        = signal('');
  maxHops      = signal(3);
  /** ID of the system currently being fetched for the inspector — drives the loading ring on cards. */
  loadingSysId = signal<string | null>(null);

  /** Search signals for BP, upstream, downstream sections */
  bpSearch = signal('');
  upSearch = signal('');
  dnSearch = signal('');

  /** Search mode: exact = substring phrase match, similar = token fuzzy match, semantic = API semantic search */
  upMode = signal<'exact'|'similar'|'semantic'>('exact');
  dnMode = signal<'exact'|'similar'|'semantic'>('exact');

  /** Semantic search: system entity IDs that matched. null = no active semantic search. */
  upSemIds     = signal<Set<string> | null>(null);
  dnSemIds     = signal<Set<string> | null>(null);
  upSemLoading = signal(false);
  dnSemLoading = signal(false);

  private destroy$       = new Subject<void>();
  private upSearchTrig$  = new Subject<string>();
  private dnSearchTrig$  = new Subject<string>();

  result$  = this.ds.result$;
  loading$ = this.ds.loading$;

  exampleGroups = EXAMPLE_GROUPS;

  ngOnInit() {
    // Debounced semantic search for upstream
    this.upSearchTrig$.pipe(
      debounceTime(350),
      switchMap(q => {
        if (!q.trim() || this.upMode() !== 'semantic') {
          this.upSemIds.set(null); this.upSemLoading.set(false); return EMPTY;
        }
        this.upSemLoading.set(true);
        return this.http.get<{ candidates: { entity_id: string; score: number }[] }>(
          '/api/search', { params: { q: q.trim(), entity_type: 'system', top_k: 50 } },
        ).pipe(
          tap(res => {
            this.upSemIds.set(new Set(res.candidates.map(c => c.entity_id)));
            this.upSemLoading.set(false);
          }),
          catchError(() => { this.upSemLoading.set(false); this.upSemIds.set(null); return EMPTY; }),
        );
      }),
      takeUntil(this.destroy$),
    ).subscribe();

    // Debounced semantic search for downstream
    this.dnSearchTrig$.pipe(
      debounceTime(350),
      switchMap(q => {
        if (!q.trim() || this.dnMode() !== 'semantic') {
          this.dnSemIds.set(null); this.dnSemLoading.set(false); return EMPTY;
        }
        this.dnSemLoading.set(true);
        return this.http.get<{ candidates: { entity_id: string; score: number }[] }>(
          '/api/search', { params: { q: q.trim(), entity_type: 'system', top_k: 50 } },
        ).pipe(
          tap(res => {
            this.dnSemIds.set(new Set(res.candidates.map(c => c.entity_id)));
            this.dnSemLoading.set(false);
          }),
          catchError(() => { this.dnSemLoading.set(false); this.dnSemIds.set(null); return EMPTY; }),
        );
      }),
      takeUntil(this.destroy$),
    ).subscribe();
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  run(q?: string) {
    const query = q ?? this.query();
    if (!query.trim()) return;
    this.query.set(query);
    this.bpSearch.set('');
    this.upSearch.set('');
    this.dnSearch.set('');
    this._clearSemantic();
    this.ds.analyse(query, this.maxHops()).subscribe();
  }

  pick(c: { entity_id: string; entity_type: string; name: string }) {
    this.query.set(c.name);
    this.bpSearch.set('');
    this.upSearch.set('');
    this.dnSearch.set('');
    this._clearSemantic();
    this.ds.analyse(c.name, this.maxHops(), c.entity_id, c.entity_type).subscribe();
  }

  private _clearSemantic() {
    this.upSemIds.set(null); this.upSemLoading.set(false);
    this.dnSemIds.set(null); this.dnSemLoading.set(false);
  }

  // ── Search input handlers ────────────────────────────────────────────────────

  onUpSearchChange(q: string) {
    this.upSearch.set(q);
    if (!q.trim()) { this.upSemIds.set(null); this.upSemLoading.set(false); return; }
    if (this.upMode() === 'semantic') { this.upSemLoading.set(true); this.upSearchTrig$.next(q); }
  }

  onDnSearchChange(q: string) {
    this.dnSearch.set(q);
    if (!q.trim()) { this.dnSemIds.set(null); this.dnSemLoading.set(false); return; }
    if (this.dnMode() === 'semantic') { this.dnSemLoading.set(true); this.dnSearchTrig$.next(q); }
  }

  setUpMode(m: 'exact' | 'similar' | 'semantic') {
    this.upMode.set(m);
    this.upSemIds.set(null);
    const q = this.upSearch().trim();
    if (m === 'semantic' && q) { this.upSemLoading.set(true); this.upSearchTrig$.next(q); }
    else { this.upSemLoading.set(false); }
  }

  setDnMode(m: 'exact' | 'similar' | 'semantic') {
    this.dnMode.set(m);
    this.dnSemIds.set(null);
    const q = this.dnSearch().trim();
    if (m === 'semantic' && q) { this.dnSemLoading.set(true); this.dnSearchTrig$.next(q); }
    else { this.dnSemLoading.set(false); }
  }

  clearUpSearch() {
    this.upSearch.set(''); this.upSemIds.set(null); this.upSemLoading.set(false);
    this.upSearchTrig$.next('');
  }

  clearDnSearch() {
    this.dnSearch.set(''); this.dnSemIds.set(null); this.dnSemLoading.set(false);
    this.dnSearchTrig$.next('');
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
    if (mode === 'semantic') {
      if (this.upSemLoading()) return [];          // still fetching — show spinner
      const ids = this.upSemIds();
      if (ids === null) return this.upstreamList(fp); // no query yet
      return this.upstreamList(fp).filter(n => ids.has(n.id));
    }
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
    if (mode === 'semantic') {
      if (this.dnSemLoading()) return [];
      const ids = this.dnSemIds();
      if (ids === null) return this.downstreamList(fp);
      return this.downstreamList(fp).filter(n => ids.has(n.id));
    }
    return this.downstreamList(fp)
      .map(n => ({ n, s: this._scoreNode(n, q, mode) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s)
      .map(({ n }) => n);
  }

  /** Score for an upstream card — 0-100 int, shown as badge in the template. */
  upScorePct(node: FootprintNode): number {
    const q = this.upSearch().trim().toLowerCase();
    if (!q || this.upMode() === 'semantic') return 0;
    return Math.round(this._scoreNode(node, q, this.upMode() as 'exact' | 'similar') * 100);
  }

  /** Score for a downstream card — 0-100 int. */
  dnScorePct(node: FootprintNode): number {
    const q = this.dnSearch().trim().toLowerCase();
    if (!q || this.dnMode() === 'semantic') return 0;
    return Math.round(this._scoreNode(node, q, this.dnMode() as 'exact' | 'similar') * 100);
  }

  /** Colour for the score badge: green ≥70 · amber ≥40 · red <40 */
  matchColor(pct: number): string {
    if (pct >= 70) return '#34d399';
    if (pct >= 40) return '#f59e0b';
    return '#f87171';
  }

  // ── Search helpers ───────────────────────────────────────────────────────────

  /**
   * Extracts text strings from a single flow for search/matching.
   * Includes both information_entity labels AND business_process tags.
   */
  private _flowTexts(f: any): string[] {
    const ie = f.information_entity;
    const bp = f.business_process;
    const ieArr = !ie ? [] : (Array.isArray(ie) ? ie : [ie]) as string[];
    const bpArr = !bp ? [] : (Array.isArray(bp) ? bp : [bp]) as string[];
    return [...ieArr, ...bpArr];
  }

  /**
   * All searchable text for a node:
   *   [0] system name
   *   [1] domain
   *   [2+] every information_entity + business_process label across all via_flows
   */
  private _nodeTargets(node: FootprintNode): string[] {
    const flowTexts = node.via_flows.flatMap(f => this._flowTexts(f));
    return [node.name, node.domain, ...flowTexts];
  }

  /**
   * Unified score — 0.0 … 1.0.
   *
   * Exact mode (phrase search):
   *   Name match         → 40 pts
   *   IE-matching flows  → up to 35 pts  (flowIeHits / totalFlows × 0.35)
   *   BP-matching flows  → up to 25 pts  (flowBpHits / totalFlows × 0.25)
   *   → pure IE/BP hits still surface the system even if name doesn't match
   *
   * Similar mode (token search):
   *   score = matchedTokens / totalTokens
   *   tokens are checked across name + domain + every IE + every BP tag
   */
  private _scoreNode(node: FootprintNode, q: string, mode: 'exact' | 'similar' | 'semantic'): number {
    if (mode === 'semantic') return 1; // semantic mode filters externally; score unused
    if (!q) return 1;

    if (mode === 'exact') {
      const nameHit = node.name.toLowerCase().includes(q) ? 1 : 0;
      const totalFlows = Math.max(1, node.via_flows.length);
      const ieHits = node.via_flows.filter(f => {
        const ie = (f as any).information_entity;
        const arr = !ie ? [] : (Array.isArray(ie) ? ie : [ie]) as string[];
        return arr.some(t => t.toLowerCase().includes(q));
      }).length;
      const bpHits = node.via_flows.filter(f => {
        const bp = (f as any).business_process;
        const arr = !bp ? [] : (Array.isArray(bp) ? bp : [bp]) as string[];
        return arr.some(t => t.toLowerCase().includes(q));
      }).length;
      return Math.min(1, nameHit * 0.4 + (ieHits / totalFlows) * 0.35 + (bpHits / totalFlows) * 0.25);
    } else {
      const tokens   = q.split(/\s+/).filter(t => t.length >= 2);
      if (tokens.length === 0) return 1;
      const haystack = this._nodeTargets(node).join(' ').toLowerCase();
      const matched  = tokens.filter(tok => haystack.includes(tok)).length;
      return matched / tokens.length;
    }
  }

  /**
   * Returns true when a specific via_flow matches the current search query.
   * Used to highlight individual matched flow rows in the template.
   */
  isFlowMatch(f: any, query: string, mode: 'exact' | 'similar' | 'semantic'): boolean {
    if (!query || mode === 'semantic') return false;
    const q = query.trim().toLowerCase();
    if (!q) return false;
    const texts = this._flowTexts(f).map(t => t.toLowerCase());
    if (mode === 'exact') {
      return texts.some(t => t.includes(q));
    } else {
      const tokens = q.split(/\s+/).filter(t => t.length >= 2);
      return tokens.some(tok => texts.some(t => t.includes(tok)));
    }
  }

  /** Count of via_flows that match the search — shown as a badge on the card.
   *  Returns 0 in semantic mode (system-level filter only, no per-flow highlighting). */
  upFlowMatchCount(node: FootprintNode): number {
    const q = this.upSearch().trim();
    if (!q || this.upMode() === 'semantic') return 0;
    return node.via_flows.filter(f => this.isFlowMatch(f, q, this.upMode())).length;
  }

  dnFlowMatchCount(node: FootprintNode): number {
    const q = this.dnSearch().trim();
    if (!q || this.dnMode() === 'semantic') return 0;
    return node.via_flows.filter(f => this.isFlowMatch(f, q, this.dnMode())).length;
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
