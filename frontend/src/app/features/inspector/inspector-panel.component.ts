// inspector-panel.component.ts — click-to-inspect panel, collapsible to right
import { Component, inject, HostBinding, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule }           from '@angular/common';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Subject, of, EMPTY }     from 'rxjs';
import { switchMap, shareReplay, map, tap, catchError,
         debounceTime, takeUntil } from 'rxjs/operators';
import { GraphService }    from '../../core/services/graph.service';
import { SubgraphResponse } from '../../core/models/models';
import { ds, CRIT_STROKE, Flow, SimNode } from '../../core/models/models';

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
  flowSearch    = signal('');                       // text in the input
  /** flow_id → similarity score (0–1). null = no active search / show all. */
  flowMatchIds  = signal<Map<string, number> | null>(null);
  searching     = signal(false);
  currentNodeId = signal<string>('');

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

  toggle() { this.collapsed.update(v => !v); }

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
          this.searching.set(false);
        }
        lastId = id;
      }
      if (!sel) {
        lastId = '';
        this.flowSearch.set('');
        this.flowMatchIds.set(null);
        this.searching.set(false);
      }
    });

    // Debounced semantic search — fires on every non-empty query after 350 ms idle
    this.searchInput$.pipe(
      debounceTime(350),
      switchMap(q => {
        if (!q.trim()) {
          this.searching.set(false);
          this.flowMatchIds.set(null);
          return EMPTY;
        }
        const nodeId = this.currentNodeId();
        if (!nodeId) { this.searching.set(false); return EMPTY; }

        this.searching.set(true);
        return this.http.get<{ results: { flow_id: string; score: number }[] }>('/api/inspector/flows', {
          params: { q, node_id: nodeId },
        }).pipe(
          tap(res => {
            const m = new Map<string, number>();
            res.results.forEach(r => m.set(r.flow_id, r.score));
            this.flowMatchIds.set(m);
            this.searching.set(false);
          }),
          catchError(() => {
            this.searching.set(false);
            this.flowMatchIds.set(null);
            return EMPTY;
          }),
        );
      }),
      takeUntil(this.destroy$),
    ).subscribe();
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  /** Called by the search input on every keystroke — pushes to debounced semantic pipeline. */
  onSearchInput(v: string) {
    this.flowSearch.set(v);
    if (!v.trim()) {
      this.clearSearch();
      return;
    }
    this.searching.set(true); // show spinner immediately while waiting for debounce
    this.searchInput$.next(v);
  }

  /** Called by the clear (×) button */
  clearSearch() {
    this.flowSearch.set('');
    this.flowMatchIds.set(null);
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
    sysKey: 'source' | 'target',
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
    const matchIds = this.flowMatchIds();
    const bpFilter = this.gs.contextBp();
    const groups = this._groupFlows(
      sg.edges.filter(e => {
        if (e.target !== nodeId) return false;
        // In BP/flow context: only show flows whose primary business_process matches.
        if (bpFilter !== null && e.business_process !== bpFilter) return false;
        if (matchIds === null) return true;
        return matchIds.has(e.id);
      }),
      'source', sg,
    );
    return matchIds !== null ? this._sortByScore(groups, matchIds) : groups;
  }

  outboundGrouped(sg: SubgraphResponse, nodeId: string) {
    const matchIds = this.flowMatchIds();
    const bpFilter = this.gs.contextBp();
    const groups = this._groupFlows(
      sg.edges.filter(e => {
        if (e.source !== nodeId) return false;
        if (bpFilter !== null && e.business_process !== bpFilter) return false;
        if (matchIds === null) return true;
        return matchIds.has(e.id);
      }),
      'target', sg,
    );
    return matchIds !== null ? this._sortByScore(groups, matchIds) : groups;
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
    const sourceNode = sg.nodes.find(n => n.id === flow.source) as SimNode | undefined;
    const targetNode = sg.nodes.find(n => n.id === flow.target) as SimNode | undefined;
    this.gs.selectEdge({ ...flow, sourceNode, targetNode });
  }

  trackGroup(_: number, grp: { sysId: string }): string { return grp.sysId; }
  trackFlow(_: number, f: Flow): string { return f.id; }
}
