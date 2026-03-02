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
  flowMatchIds  = signal<Set<string> | null>(null); // null = no filter active
  searching     = signal(false);
  currentNodeId = signal<string>('');

  /**
   * Inspector-specific subgraph: always the selected node's full 1-hop
   * neighbourhood, fetched independently of the canvas view.
   * Works correctly whether the canvas is showing a business-process
   * subgraph, a full map, an impact view, etc.
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

    // Debounced semantic similarity search via ChromaDB embeddings
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
        this.searching.set(true);
        return this.http.get<{ flow_ids: string[] }>('/api/inspector/flows', {
          params: { q, node_id: nodeId },
        }).pipe(
          tap(res => {
            this.flowMatchIds.set(new Set(res.flow_ids));
            this.searching.set(false);
          }),
          catchError(() => {
            // On error fall back to showing everything
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

  /** Called by the search input — updates display text AND triggers API call */
  onSearchInput(v: string) {
    this.flowSearch.set(v);
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

  /** Upstream systems — filtered by semantic match IDs when a search is active */
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

  /** Downstream systems — filtered by semantic match IDs when a search is active */
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
