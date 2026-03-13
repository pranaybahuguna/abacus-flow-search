// graph.service.ts — calls /api/graph, holds subgraph state + inspector selection
import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient, HttpParams }               from '@angular/common/http';
import { BehaviorSubject, throwError }          from 'rxjs';
import { tap, catchError }                      from 'rxjs/operators';

export interface PairwiseFocus {
  nodeA:   string;       // currently-selected node id
  nodeB:   string;       // peer system id
  edgeIds: Set<string>;  // all edge ids between the two
}
import {
  SubgraphResponse, EntityType, SimNode, SimEdge, Selection, SearchCandidate,
} from '../models/models';

export type AppMode = 'graph' | 'dependency';

/** Colours assigned to each pinned entity — up to 15 distinct hues */
export const PIN_COLORS = [
  '#f59e0b', '#a855f7', '#22d3ee',
  '#22c55e', '#ef4444', '#3b82f6',
  '#ec4899', '#f97316', '#14b8a6',
  '#a3e635', '#e879f9', '#fb923c',
  '#38bdf8', '#4ade80', '#fb7185',
];

export interface PinnedEntity {
  candidate: SearchCandidate;
  color:     string;
  sg:        SubgraphResponse;
}

@Injectable({ providedIn:'root' })
export class GraphService {
  private http = inject(HttpClient);
  private _sg  = new BehaviorSubject<SubgraphResponse|null>(null);
  private _l   = new BehaviorSubject<boolean>(false);
  private _sel = new BehaviorSubject<Selection|null>(null);
  private _pw  = new BehaviorSubject<PairwiseFocus|null>(null);

  readonly subgraph$      = this._sg.asObservable();
  readonly loading$       = this._l.asObservable();
  readonly selected$      = this._sel.asObservable();
  readonly pairwiseFocus$ = this._pw.asObservable();

  get selectionValue()       { return this._sel.value; }
  get currentSubgraphValue() { return this._sg.value;  }
  get pairwiseFocusValue()   { return this._pw.value;  }

  readonly mode = signal<AppMode>('graph');
  setMode(m: AppMode) { this.mode.set(m); }

  /** Business-process name to scope the inspector panel to. null = show all flows. */
  readonly contextBp = signal<string | null>(null);

  /**
   * Cached subgraph from the most recent pick() call.
   * Lets the inspector panel skip its own HTTP request when the canvas
   * subgraph was already fetched for the selected system node.
   */
  readonly inspectorSgCache = signal<SubgraphResponse | null>(null);

  // ── Pin state ─────────────────────────────────────────────────────────────

  /** entity_id → PinnedEntity (max 15) */
  readonly pins = signal<Map<string, PinnedEntity>>(new Map());

  /** Stable array of pinned entities for *ngFor — recomputes only when pins change */
  readonly pinnedList = computed(() => Array.from(this.pins().values()));

  /** True when any entity is pinned */
  readonly hasPins = computed(() => this.pins().size > 0);

  /**
   * Set of all edge IDs that belong to any pinned subgraph.
   * Used by the inspector to restrict visible flows to only those
   * relevant to the currently pinned entities.
   */
  readonly pinnedEdgeIds = computed(() => {
    const ids = new Set<string>();
    this.pins().forEach(p => p.sg.edges.forEach(e => ids.add(e.id)));
    return ids;
  });

  /** edge_id → pin colour — set before _sg is updated so canvas reads fresh colours */
  readonly edgePinColors = signal<Map<string, string>>(new Map());

  /** Returns the pin colour for an entity, or null if it is not pinned */
  pinColor(entityId: string): string | null {
    return this.pins().get(entityId)?.color ?? null;
  }

  /** Add an entity to the pinned set and push merged subgraph to canvas */
  pinEntity(candidate: SearchCandidate, sg: SubgraphResponse) {
    const current = this.pins();
    if (current.has(candidate.entity_id) || current.size >= 15) return;

    const usedColors = new Set(Array.from(current.values()).map(p => p.color));
    const color = PIN_COLORS.find(c => !usedColors.has(c)) ?? PIN_COLORS[0];

    const next = new Map(current);
    next.set(candidate.entity_id, { candidate, color, sg });
    this.pins.set(next);
    this._emitMerged(next);
  }

  /** Remove a pinned entity; restores empty canvas when no pins remain */
  unpinEntity(entityId: string) {
    const current = this.pins();
    if (!current.has(entityId)) return;

    const next = new Map(current);
    next.delete(entityId);
    this.pins.set(next);

    if (next.size === 0) {
      this.edgePinColors.set(new Map());
      this._sg.next(null);
      this._sel.next(null);
    } else {
      this._emitMerged(next);
    }
  }

  /** Remove all pins without touching the canvas (used before loadFull) */
  clearAllPins() {
    this.pins.set(new Map());
    this.edgePinColors.set(new Map());
  }

  /** Fetch a subgraph for pinning — does NOT push to canvas or show loader */
  fetchSubgraph(entityId: string, entityType: EntityType) {
    const p = new HttpParams().set('entity_id', entityId).set('entity_type', entityType);
    return this.http.get<SubgraphResponse>('/api/graph', { params: p });
  }

  // ── Normal (non-pin) subgraph loading ─────────────────────────────────────

  loadSubgraph(entityId: string, entityType: EntityType) {
    this._l.next(true);
    const p = new HttpParams().set('entity_id', entityId).set('entity_type', entityType);
    return this.http.get<SubgraphResponse>('/api/graph', { params: p }).pipe(
      tap(sg => { this._sg.next(sg); this._l.next(false); this._sel.next(null); this._pw.next(null); }),
      catchError(e => { this._l.next(false); return throwError(() => e); }),
    );
  }

  loadFull() {
    this._l.next(true);
    return this.http.get<SubgraphResponse>('/api/graph/full').pipe(
      tap(sg => { this._sg.next(sg); this._l.next(false); this._sel.next(null); this._pw.next(null); }),
      catchError(e => { this._l.next(false); return throwError(() => e); }),
    );
  }

  selectNode(node: SimNode) { this._sel.next({ kind:'node', node }); }
  selectEdge(edge: SimEdge) { this._sel.next({ kind:'edge', edge }); }
  clearSelection()          { this._sel.next(null); this.inspectorSgCache.set(null); this.clearPairwiseFocus(); }

  /** Activate pairwise canvas focus — dims everything except the two nodes and their edges. */
  setPairwiseFocus(nodeA: string, nodeB: string, edgeIds: Set<string>) {
    this._pw.next({ nodeA, nodeB, edgeIds });
  }
  clearPairwiseFocus() { this._pw.next(null); }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Merge all pinned subgraphs, assign edge colours, emit on subgraph$ */
  private _emitMerged(pins: Map<string, PinnedEntity>) {
    const nodeMap  = new Map<string, SubgraphResponse['nodes'][0]>();
    const edgeMap  = new Map<string, SubgraphResponse['edges'][0]>();
    const colorMap = new Map<string, string>();

    pins.forEach(({ sg, color }) => {
      sg.nodes.forEach(n => { if (!nodeMap.has(n.id)) nodeMap.set(n.id, n); });
      sg.edges.forEach(e => {
        if (!edgeMap.has(e.id)) {
          edgeMap.set(e.id, e);
          colorMap.set(e.id, color);
        }
      });
    });

    // Set colours BEFORE emitting so canvas reads them on the same tick
    this.edgePinColors.set(colorMap);
    this._sg.next({
      label: `${pins.size} pinned`,
      nodes: Array.from(nodeMap.values()),
      edges: Array.from(edgeMap.values()),
    });
  }
}
