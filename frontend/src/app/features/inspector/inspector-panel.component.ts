// inspector-panel.component.ts — click-to-inspect panel, collapsible to right
import { Component, inject, HostBinding, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule }           from '@angular/common';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Subject, of, EMPTY }     from 'rxjs';
import { switchMap, shareReplay, map, tap, catchError,
         debounceTime, distinctUntilChanged, takeUntil } from 'rxjs/operators';
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
   */
  readonly inspectorSg$ = this.gs.selected$.pipe(
    map(sel => (sel?.kind === 'node' ? sel.node : null)),
    switchMap(node => {
      if (!node) return of(null);
      const params = new HttpParams()
        .set('entity_id', node.id)
        .set('entity_type', 'system');
      return this.http.get<SubgraphResponse>('/api/graph', { params });
    }),
    shareReplay(1),
  );

  /** Latest emitted value of inspectorSg$ — kept in sync for synchronous substring checks. */
  private _currentSg: SubgraphResponse | null = null;

  private destroy$     = new Subject<void>();
  private searchInput$ = new Subject<string>();

  @HostBinding('class.collapsed')
  get isCollapsed() { return this.collapsed(); }

  toggle() { this.collapsed.update(v => !v); }

  ngOnInit() {
    // Keep _currentSg in sync so substring matching is always up to date
    this.inspectorSg$.pipe(takeUntil(this.destroy$)).subscribe(sg => {
      this._currentSg = sg;
    });

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

    // Debounced semantic fallback — only fires when no substring matches exist
    this.searchInput$.pipe(
      debounceTime(350),
      distinctUntilChanged(),
      switchMap(q => {
        if (!q.trim()) {
          this.searching.set(false);
          this.flowMatchIds.set(null);
          return EMPTY;
        }
        const nodeId = this.currentNodeId();
        if (!nodeId) { this.searching.set(false); return EMPTY; }

        // Re-check at debounce-fire time: exact match may have appeared while waiting
        if (this._substringMatches(q, nodeId) !== null) {
          this.searching.set(false);
          return EMPTY; // Already showing exact results — skip HTTP call
        }

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

  /**
   * Synchronous substring scan of the current node's flows.
   * Returns a Map<flowId, 1.0> if any flows match, or null if none do.
   *
   * Two-pass matching so multi-word queries like "trade related" still hit:
   *   Pass 1 — full phrase ("trade related" as a substring)
   *   Pass 2 — any individual word ≥ 3 chars ("trade" OR "related")
   * Both passes use score = 1.0 ("EXACT") since they are literal keyword hits.
   */
  private _substringMatches(q: string, nodeId: string): Map<string, number> | null {
    if (!this._currentSg || !nodeId) return null;
    const lq = q.toLowerCase().trim();
    if (!lq) return null;

    const result = new Map<string, number>();
    const words  = lq.split(/\s+/).filter(w => w.length >= 3); // skip tiny words

    this._currentSg.edges.forEach(e => {
      if (e.source !== nodeId && e.target !== nodeId) return;
      const haystack = `${e.data_entity ?? ''} ${e.business_process ?? ''} ${e.protocol ?? ''} ${e.criticality ?? ''}`.toLowerCase();

      if (haystack.includes(lq)) {
        // Full phrase match
        result.set(e.id, 1.0);
      } else if (words.length > 1 && words.some(w => haystack.includes(w))) {
        // At least one meaningful word matches — still a keyword hit
        result.set(e.id, 1.0);
      }
    });
    return result.size > 0 ? result : null;
  }

  /**
   * Called by the search input on every keystroke.
   *
   * Strategy:
   *  1. Instant substring scan — if any flow literally contains the query,
   *     show those results immediately (score = 1.0 / "EXACT"), no API wait.
   *  2. If zero exact matches, push to searchInput$ → debounced semantic
   *     search via ChromaDB embeddings fires after 350 ms.
   *
   * The debounced pipeline re-checks for exact matches at fire-time, so
   * it never overwrites an already-displayed exact result with semantic scores.
   */
  onSearchInput(v: string) {
    this.flowSearch.set(v);

    if (!v.trim()) {
      this.clearSearch();
      return;
    }

    const nodeId = this.currentNodeId();
    const exact  = this._substringMatches(v, nodeId);

    if (exact !== null) {
      // Exact/literal match found — show instantly, no spinner
      this.flowMatchIds.set(exact);
      this.searching.set(false);
    }
    // Always push to the debounced pipeline:
    //   • If exact !== null  → the pipeline will re-check and bail (EMPTY)
    //   • If exact === null  → the pipeline will fire the semantic HTTP call
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

  /** "EXACT" for substring hits (score = 1.0), percentage label otherwise. */
  scoreLabel(score: number): string {
    return score === 1.0 ? 'EXACT' : `${Math.round(score * 100)}%`;
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
    return this._groupFlows(
      sg.edges.filter(e => {
        if (e.target !== nodeId) return false;
        if (matchIds === null)   return true;
        return matchIds.has(e.id);
      }),
      'source', sg,
    );
  }

  outboundGrouped(sg: SubgraphResponse, nodeId: string) {
    const matchIds = this.flowMatchIds();
    return this._groupFlows(
      sg.edges.filter(e => {
        if (e.source !== nodeId) return false;
        if (matchIds === null)   return true;
        return matchIds.has(e.id);
      }),
      'target', sg,
    );
  }

  selectFlow(flow: Flow, sg: SubgraphResponse) {
    const sourceNode = sg.nodes.find(n => n.id === flow.source) as SimNode | undefined;
    const targetNode = sg.nodes.find(n => n.id === flow.target) as SimNode | undefined;
    this.gs.selectEdge({ ...flow, sourceNode, targetNode });
  }
}
