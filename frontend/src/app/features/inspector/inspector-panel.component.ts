// inspector-panel.component.ts — click-to-inspect panel, collapsible to right
import { Component, inject, HostBinding, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule }           from '@angular/common';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Subject, of, EMPTY, forkJoin } from 'rxjs';
import { switchMap, shareReplay, map, tap, catchError,
         debounceTime, takeUntil } from 'rxjs/operators';
import { GraphService }    from '../../core/services/graph.service';
import { ds, CRIT_STROKE, Flow, SimNode, SubgraphResponse } from '../../core/models/models';

@Component({
  selector:'abacus-inspector-panel', standalone:true, imports:[CommonModule],
  templateUrl:'./inspector-panel.component.html',
  styleUrls:  ['./inspector-panel.component.scss'],
})
export class InspectorPanelComponent implements OnInit, OnDestroy {
  gs   = inject(GraphService);
  http = inject(HttpClient);
  selected$ = this.gs.selected$;

  collapsed     = signal(false);
  expanded      = signal(false);                    // wide mode (480px vs 276px)
  flowSearch    = signal('');                       // text in the input
  /** flow_id → similarity score (0–1). null = no active search / show all. */
  flowMatchIds  = signal<Map<string, number> | null>(null);
  /** system entity_id → similarity score (0–1) from system-name semantic search. */
  sysMatchIds   = signal<Map<string, number> | null>(null);
  searching     = signal(false);
  /** EX = local exact/keyword search across system name + IE + BP tags.
   *  similar = semantic backend search (existing behaviour). */
  searchMode    = signal<'exact' | 'similar'>('similar');
  currentNodeId = signal<string>('');
  /** System selected for pairwise (bidirectional) flow view. */
  pairwiseSys   = signal<{ sysId: string; sysName: string } | null>(null);
  /** Node that was selected before the user drilled into a flow (enables ← Back).
   *  Also stores the pairwise state so it can be fully restored on back-nav. */
  prevNodeSel   = signal<{
    node: SimNode; sg: SubgraphResponse;
    pairwiseSys: { sysId: string; sysName: string } | null;
    pairwiseEdgeIds: Set<string> | null;
  } | null>(null);

  /** Prevents ngOnInit subscription from clearing pairwise during backToNode(). */
  private _restoringBack = false;

  /**
   * Inspector-specific subgraph: always the selected node's full 1-hop
   * neighbourhood, fetched independently of the canvas view.
   *
   * When a system was just picked from the left panel, the subgraph was
   * already fetched by pick() and stored in gs.inspectorSgCache. In that
   * case we use the cached value immediately (zero-latency). Otherwise we
   * fall back to a fresh HTTP request (e.g. direct graph-canvas click).
   */
  readonly inspectorSg$ = this.gs.selected$.pipe(
    map(sel => (sel?.kind === 'node' ? sel.node : null)),
    switchMap(node => {
      if (!node) return of(null);
      const cached = this.gs.inspectorSgCache();
      if (cached && cached.nodes.some(n => n.id === node.id)) {
        return of(cached);
      }
      const params = new HttpParams()
        .set('entity_id', node.id)
        .set('entity_type', 'system');
      return this.http.get<SubgraphResponse>('/api/graph', { params });
    }),
    shareReplay(1),
  );

  private destroy$     = new Subject<void>();
  private searchInput$ = new Subject<string>();

  @HostBinding('class.collapsed')
  get isCollapsed() { return this.collapsed(); }

  @HostBinding('class.expanded')
  get isExpanded() { return this.expanded(); }

  toggle()       { this.collapsed.update(v => !v); }
  toggleExpand() { this.expanded.update(v => !v); }

  ngOnInit() {
    // Track current node ID; reset search state on new node selection
    let lastId = '';
    this.gs.selected$.pipe(takeUntil(this.destroy$)).subscribe(sel => {
      const id = sel?.kind === 'node' ? (sel.node?.id ?? '') : (sel?.edge?.id ?? '');
      if (sel?.kind === 'node') this.currentNodeId.set(sel.node?.id ?? '');
      else                      this.currentNodeId.set('');

      if (sel && id !== lastId) {
        this.collapsed.set(false);
        if (sel.kind === 'node') {
          this.flowSearch.set('');
          this.flowMatchIds.set(null);
          this.sysMatchIds.set(null);
          this.searching.set(false);
          if (!this._restoringBack) {
            this.pairwiseSys.set(null);
            this.gs.clearPairwiseFocus();
            this.prevNodeSel.set(null);
          }
        }
        lastId = id;
      }
      if (!sel) {
        lastId = '';
        this.flowSearch.set('');
        this.flowMatchIds.set(null);
        this.sysMatchIds.set(null);
        this.searching.set(false);
        this.pairwiseSys.set(null);
        this.gs.clearPairwiseFocus();
        this.prevNodeSel.set(null);
      }
    });

    // Debounced semantic search — fires on every non-empty query after 350 ms idle.
    // Runs TWO parallel calls: flow-level semantic search AND system-name semantic
    // search so that groups appear when EITHER the system name OR a flow matches.
    this.searchInput$.pipe(
      debounceTime(350),
      switchMap(q => {
        if (!q.trim()) {
          this.searching.set(false);
          this.flowMatchIds.set(null);
          this.sysMatchIds.set(null);
          return EMPTY;
        }
        const nodeId = this.currentNodeId();
        if (!nodeId) { this.searching.set(false); return EMPTY; }

        this.searching.set(true);
        return forkJoin({
          flows:   this.http.get<{ results: { flow_id: string; score: number }[] }>(
            '/api/inspector/flows', { params: { q, node_id: nodeId } }),
          systems: this.http.get<{ candidates: { entity_id: string; score: number }[] }>(
            '/api/search', { params: { q, entity_type: 'system', top_k: 20 } }),
        }).pipe(
          tap(({ flows, systems }) => {
            // Flow-level matches (pairwise-scoped if active)
            const fm  = new Map<string, number>();
            const pw  = this.gs.pairwiseFocusValue;
            flows.results.forEach(r => {
              if (pw && !pw.edgeIds.has(r.flow_id)) return;
              fm.set(r.flow_id, r.score);
            });
            this.flowMatchIds.set(fm);

            // System-name semantic matches (entity_id → score)
            const sm = new Map<string, number>();
            systems.candidates.forEach(c => sm.set(c.entity_id, Math.max(0, c.score)));
            this.sysMatchIds.set(sm);

            this.searching.set(false);
          }),
          catchError(() => {
            this.searching.set(false);
            this.flowMatchIds.set(null);
            this.sysMatchIds.set(null);
            return EMPTY;
          }),
        );
      }),
      takeUntil(this.destroy$),
    ).subscribe();
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  /** Called by the search input on every keystroke. */
  onSearchInput(v: string) {
    this.flowSearch.set(v);
    if (!v.trim()) {
      this.clearSearch();
      return;
    }
    if (this.searchMode() === 'exact') {
      // Local keyword search — no backend call needed
      this.flowMatchIds.set(null);
      this.sysMatchIds.set(null);
      this.searching.set(false);
      return;
    }
    this.searching.set(true); // show spinner immediately while waiting for debounce
    this.searchInput$.next(v);
  }

  /** Switch EX ↔ ~ mode and re-run the current query in the new mode. */
  setSearchMode(mode: 'exact' | 'similar') {
    this.searchMode.set(mode);
    const q = this.flowSearch().trim();
    if (mode === 'exact') {
      // Clear any pending/completed semantic results
      this.flowMatchIds.set(null);
      this.sysMatchIds.set(null);
      this.searching.set(false);
      this.searchInput$.next('');
    } else if (q) {
      // Re-trigger semantic search with current query
      this.searching.set(true);
      this.searchInput$.next(q);
    }
  }

  /** Called by the clear (×) button */
  clearSearch() {
    this.flowSearch.set('');
    this.flowMatchIds.set(null);
    this.sysMatchIds.set(null);
    this.searching.set(false);
    this.searchInput$.next('');
  }

  ds(domain: string) { return ds(domain); }
  cs(crit:  string)  { return CRIT_STROKE[crit] ?? '#6b7280'; }

  clearBpContext() {
    this.gs.contextBp.set(null);
    const sel = this.gs.selectionValue;
    if (sel?.kind === 'node' && sel.node) {
      const node = sel.node;
      // Reload the canvas with the full system subgraph (not the BP-scoped one),
      // then re-select the node so the inspector stays open.
      this.gs.loadSubgraph(node.id, 'system').subscribe(sg => {
        this.gs.inspectorSgCache.set(sg);
        this.gs.selectNode(node);
      });
    }
  }

  /** Returns the similarity score (0–1) for a flow, or null when no search is active. */
  getScore(flowId: string): number | null {
    const m = this.flowMatchIds();
    if (m === null) return null;
    return m.get(flowId) ?? null;
  }

  /** Colour-codes the confidence badge: green = EXACT/high, amber = mid, slate = low. */
  scoreColor(score: number): string {
    if (score >= 0.75) return '#4ade80';
    if (score >= 0.50) return '#fbbf24';
    return '#94a3b8';
  }

  /** Percentage confidence label for semantic search results. */
  scoreLabel(score: number): string {
    return `${Math.round(score * 100)}%`;
  }

  // ── Grouped flow helpers ─────────────────────────────────────────────────

  private _groupFlows(
    edges: SubgraphResponse['edges'],
    sysKey: 'source_app' | 'sinc_app',
    sg: SubgraphResponse,
  ) {
    const W: Record<string, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 };
    const map = new Map<string, { sysId: string; sysName: string; topCrit: string; flows: typeof edges }>();
    edges.forEach(f => {
      const sysId = f[sysKey];
      if (!map.has(sysId)) {
        map.set(sysId, {
          sysId,
          sysName: sg.nodes.find(n => n.id === sysId)?.name ?? sysId,
          topCrit: f.criticality,
          flows: [],
        });
      }
      const grp = map.get(sysId)!;
      grp.flows.push(f);
      if ((W[f.criticality] ?? 0) > (W[grp.topCrit] ?? 0)) grp.topCrit = f.criticality;
    });
    return Array.from(map.values());
  }

  inboundGrouped(sg: SubgraphResponse, nodeId: string) {
    const matchIds    = this.flowMatchIds();
    const hasPins     = this.gs.hasPins();
    const pinnedEdges = this.gs.pinnedEdgeIds();
    const bpFilter    = hasPins ? null : this.gs.contextBp();
    const pw          = this.pairwiseSys();
    const mode        = this.searchMode();
    const effectiveMatchIds = pw ? null : matchIds; // pairwise: no search scoping on groups

    // If the inspected node ITSELF matches the semantic query (e.g. searching
    // "data mart system" while looking at DAR APAC which IS a data mart system),
    // the global /api/search returns the selected node's id in sysMatchIds.
    // In that case the user is asking about this system's PURPOSE — show all flows
    // unfiltered rather than zero results (the neighbour filter never fires on the
    // selected node's own id since source_app/sinc_app are always neighbour ids).
    const selfMatches = this.sysMatchIds()?.has(nodeId) ?? false;

    const baseEdges = sg.edges.filter(e => {
      if (e.sinc_app !== nodeId) return false;
      if (hasPins && !pinnedEdges.has(e.id)) return false;
      if (bpFilter !== null && !e.business_process.includes(bpFilter)) return false;
      // ~ mode: include edge if (a) selected node itself matches the query,
      //         (b) the flow matches the query, or (c) the source system matches.
      if (mode === 'similar' && effectiveMatchIds !== null) {
        if (selfMatches) return true;                              // (a)
        const sysMatch = this.sysMatchIds()?.has(e.source_app) ?? false;
        return effectiveMatchIds.has(e.id) || sysMatch;           // (b) or (c)
      }
      return true;
    });
    const groups = this._groupFlows(baseEdges, 'source_app', sg);
    if (pw) return groups.filter(g => g.sysId !== pw.sysId);

    // EX mode: filter groups by system name OR flow IE/BP content
    if (mode === 'exact' && this.flowSearch().trim()) {
      const q = this.flowSearch().trim().toLowerCase();
      const filtered = groups.filter(g =>
        g.sysName.toLowerCase().includes(q) ||
        g.flows.some(f => this._flowTextsInspector(f).some(t => t.toLowerCase().includes(q)))
      );
      return filtered.sort((a, b) => this.groupScoreEX(b) - this.groupScoreEX(a));
    }
    return effectiveMatchIds !== null ? this._sortByScore(groups, effectiveMatchIds) : groups;
  }

  outboundGrouped(sg: SubgraphResponse, nodeId: string) {
    const matchIds    = this.flowMatchIds();
    const hasPins     = this.gs.hasPins();
    const pinnedEdges = this.gs.pinnedEdgeIds();
    const bpFilter    = hasPins ? null : this.gs.contextBp();
    const pw          = this.pairwiseSys();
    const mode        = this.searchMode();
    const effectiveMatchIds = pw ? null : matchIds;

    const selfMatchesOut = this.sysMatchIds()?.has(nodeId) ?? false;

    const baseEdges = sg.edges.filter(e => {
      if (e.source_app !== nodeId) return false;
      if (hasPins && !pinnedEdges.has(e.id)) return false;
      if (bpFilter !== null && !e.business_process.includes(bpFilter)) return false;
      if (mode === 'similar' && effectiveMatchIds !== null) {
        if (selfMatchesOut) return true;
        const sysMatch = this.sysMatchIds()?.has(e.sinc_app) ?? false;
        return effectiveMatchIds.has(e.id) || sysMatch;
      }
      return true;
    });
    const groups = this._groupFlows(baseEdges, 'sinc_app', sg);
    if (pw) return groups.filter(g => g.sysId !== pw.sysId);

    if (mode === 'exact' && this.flowSearch().trim()) {
      const q = this.flowSearch().trim().toLowerCase();
      const filtered = groups.filter(g =>
        g.sysName.toLowerCase().includes(q) ||
        g.flows.some(f => this._flowTextsInspector(f).some(t => t.toLowerCase().includes(q)))
      );
      return filtered.sort((a, b) => this.groupScoreEX(b) - this.groupScoreEX(a));
    }
    return effectiveMatchIds !== null ? this._sortByScore(groups, effectiveMatchIds) : groups;
  }

  // ── EX-mode helpers (called from template) ──────────────────────────────────

  /** IE + BP labels from a single flow — for EX mode matching. */
  private _flowTextsInspector(f: Flow): string[] {
    const ie = (f as any).information_entity;
    const bp = (f as any).business_process;
    const ieArr = !ie ? [] : (Array.isArray(ie) ? ie : [ie]) as string[];
    const bpArr = !bp ? [] : (Array.isArray(bp) ? bp : [bp]) as string[];
    return [...ieArr, ...bpArr];
  }

  /** 0-100 match score for a system group in EX mode. */
  groupScoreEX(grp: { sysName: string; flows: Flow[] }): number {
    const q = this.flowSearch().trim().toLowerCase();
    if (!q) return 0;
    const nameHit  = grp.sysName.toLowerCase().includes(q) ? 1 : 0;
    const total    = Math.max(1, grp.flows.length);
    const ieHits   = grp.flows.filter(f => {
      const ie = (f as any).information_entity;
      const arr = !ie ? [] : (Array.isArray(ie) ? ie : [ie]) as string[];
      return arr.some(t => t.toLowerCase().includes(q));
    }).length;
    const bpHits   = grp.flows.filter(f => {
      const bp = (f as any).business_process;
      const arr = !bp ? [] : (Array.isArray(bp) ? bp : [bp]) as string[];
      return arr.some(t => t.toLowerCase().includes(q));
    }).length;
    return Math.round(Math.min(1, nameHit * 0.4 + (ieHits / total) * 0.35 + (bpHits / total) * 0.25) * 100);
  }

  /** Top semantic score (0-100) for a group in ~ mode — used as group-level badge.
   *  Takes the max of: (a) system-name semantic score, (b) best flow score in the group. */
  groupTopScore(grp: { sysId: string; flows: Flow[] }): number | null {
    const m  = this.flowMatchIds();
    const sm = this.sysMatchIds();
    if ((m === null && sm === null) || !this.flowSearch().trim()) return null;
    // Seed with system-level name match score (may be -1 if system wasn't matched)
    let max = sm?.get(grp.sysId) ?? -1;
    // Then take the best flow-level score within this group
    if (m !== null) {
      grp.flows.forEach(f => { const s = m.get(f.id) ?? -1; if (s > max) max = s; });
    }
    return max >= 0 ? Math.round(max * 100) : null;
  }

  /** True when a specific flow's IE or BP matches the EX-mode query. */
  isFlowMatchEX(f: Flow): boolean {
    if (this.searchMode() !== 'exact' || !this.flowSearch().trim()) return false;
    const q = this.flowSearch().trim().toLowerCase();
    return this._flowTextsInspector(f).some(t => t.toLowerCase().includes(q));
  }

  /** Colour for score badges — consistent with dependency page. */
  matchColor(pct: number): string {
    if (pct >= 70) return '#34d399';
    if (pct >= 40) return '#f59e0b';
    return '#f87171';
  }

  /** When a search is active, sort groups by their best-matching flow score (desc),
   *  and sort the flows within each group by score (desc). */
  private _sortByScore(
    groups: { sysId: string; sysName: string; topCrit: string; flows: SubgraphResponse['edges'] }[],
    matchIds: Map<string, number>,
  ) {
    // Sort flows within each group highest-score first
    groups.forEach(grp => {
      grp.flows = [...grp.flows].sort(
        (a, b) => (matchIds.get(b.id) ?? 0) - (matchIds.get(a.id) ?? 0),
      );
    });
    // Sort groups by the score of their top-ranked flow
    return groups.sort((a, b) => {
      const aMax = a.flows.length ? (matchIds.get(a.flows[0].id) ?? 0) : 0;
      const bMax = b.flows.length ? (matchIds.get(b.flows[0].id) ?? 0) : 0;
      return bMax - aMax;
    });
  }

  selectFlow(flow: Flow, sg: SubgraphResponse) {
    // Capture node + pairwise state so ← Back can fully restore the view
    const sel = this.gs.selectionValue;
    if (sel?.kind === 'node' && sel.node) {
      this.prevNodeSel.set({
        node: sel.node,
        sg,
        pairwiseSys:     this.pairwiseSys(),
        pairwiseEdgeIds: this.gs.pairwiseFocusValue?.edgeIds ?? null,
      });
    }
    const sourceNode = sg.nodes.find(n => n.id === flow.source_app) as SimNode | undefined;
    const targetNode = sg.nodes.find(n => n.id === flow.sinc_app) as SimNode | undefined;
    this.gs.selectEdge({ ...flow, source: flow.source_app, target: flow.sinc_app, sourceNode, targetNode });
  }

  /** Return to the node + pairwise state that were active before the user clicked into a flow. */
  backToNode() {
    const prev = this.prevNodeSel();
    if (!prev) return;
    // Flag prevents ngOnInit subscription from wiping pairwise state during selectNode()
    this._restoringBack = true;
    this.gs.inspectorSgCache.set(prev.sg);
    this.gs.selectNode(prev.node);          // subscription fires synchronously → respects flag
    // Restore pairwise focus after node selection
    if (prev.pairwiseSys) {
      this.pairwiseSys.set(prev.pairwiseSys);
      if (prev.pairwiseEdgeIds) {
        this.gs.setPairwiseFocus(prev.node.id, prev.pairwiseSys.sysId, prev.pairwiseEdgeIds);
      }
    }
    this.prevNodeSel.set(null);
    this._restoringBack = false;
  }

  /** Join information_entity array to a readable string — handles both string and string[]. */
  ieLabel(ie: string | string[] | undefined | null): string {
    if (!ie) return '—';
    return Array.isArray(ie) ? (ie.length ? ie.join(' · ') : '—') : ie;
  }

  trackGroup(_: number, grp: { sysId: string }): string { return grp.sysId; }
  trackFlow(_: number, f: Flow): string { return f.id; }
  trackPairFlow(_: number, f: Flow): string { return f.id; }

  // ── Pairwise (bidirectional) flow helpers ─────────────────────────────────

  /**
   * Toggle pairwise view for a system group. Activates canvas focus (dims everything
   * except the two nodes + their edges). Click same system again to dismiss.
   */
  togglePairwise(grp: { sysId: string; sysName: string }, sg: SubgraphResponse, nodeId: string) {
    const cur = this.pairwiseSys();
    if (cur?.sysId === grp.sysId) {
      this.pairwiseSys.set(null);
      this.gs.clearPairwiseFocus();
    } else {
      this.pairwiseSys.set({ sysId: grp.sysId, sysName: grp.sysName });
      const flows   = this._pairwiseFlows(sg, nodeId, grp.sysId);
      const edgeIds = new Set(flows.map(f => f.id));
      this.gs.setPairwiseFocus(nodeId, grp.sysId, edgeIds);
    }
  }

  /** Close pairwise — clears both the inspector signal and canvas focus. */
  closePairwise() {
    this.pairwiseSys.set(null);
    this.gs.clearPairwiseFocus();
  }

  /** All edges (both directions) between nodeId and the selected pairwise system.
   *  When a search is active, filtered to only the matching flows so results
   *  appear exclusively inside the pw-bar panel. */
  pairwiseFlows(sg: SubgraphResponse, nodeId: string) {
    const pw = this.pairwiseSys();
    if (!pw) return [];
    const flows     = this._pairwiseFlows(sg, nodeId, pw.sysId);
    const matchIds  = this.flowMatchIds();
    if (matchIds === null) return flows;
    return flows.filter(f => matchIds.has(f.id));
  }

  private _pairwiseFlows(sg: SubgraphResponse, nodeId: string, peerId: string) {
    const W: Record<string, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 };
    return sg.edges
      .filter(e =>
        (e.source_app === nodeId && e.sinc_app === peerId) ||
        (e.source_app === peerId && e.sinc_app === nodeId),
      )
      .sort((a, b) => (W[b.criticality] ?? 0) - (W[a.criticality] ?? 0));
  }

  /** Direction arrow relative to nodeId: → = outbound, ← = inbound. */
  flowDir(f: Flow, nodeId: string): string {
    return f.source_app === nodeId ? '→' : '←';
  }
}
