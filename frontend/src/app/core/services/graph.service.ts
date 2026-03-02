// graph.service.ts — calls /api/graph, holds subgraph state + inspector selection
import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams }    from '@angular/common/http';
import { BehaviorSubject, throwError } from 'rxjs';
import { tap, catchError }           from 'rxjs/operators';
import { SubgraphResponse, EntityType, SimNode, SimEdge, Selection } from '../models/models';

export type AppMode = 'graph' | 'impact' | 'dependency';

@Injectable({ providedIn:'root' })
export class GraphService {
  private http = inject(HttpClient);
  private _sg  = new BehaviorSubject<SubgraphResponse|null>(null);
  private _l   = new BehaviorSubject<boolean>(false);
  private _sel = new BehaviorSubject<Selection|null>(null);
  readonly subgraph$  = this._sg.asObservable();
  readonly loading$   = this._l.asObservable();
  readonly selected$  = this._sel.asObservable();
  get selectionValue(){ return this._sel.value; }

  readonly mode      = signal<AppMode>('graph');
  setMode(m: AppMode) { this.mode.set(m); }

  /** Business-process name to scope the inspector panel to. null = show all flows. */
  readonly contextBp = signal<string | null>(null);

  loadSubgraph(entityId:string, entityType:EntityType) {
    this._l.next(true);
    const p = new HttpParams().set('entity_id',entityId).set('entity_type',entityType);
    return this.http.get<SubgraphResponse>('/api/graph',{params:p}).pipe(
      tap(sg => { this._sg.next(sg); this._l.next(false); this._sel.next(null); }),
      catchError(e => { this._l.next(false); return throwError(()=>e); }),
    );
  }

  loadFull() {
    this._l.next(true);
    return this.http.get<SubgraphResponse>('/api/graph/full').pipe(
      tap(sg => { this._sg.next(sg); this._l.next(false); this._sel.next(null); }),
      catchError(e => { this._l.next(false); return throwError(()=>e); }),
    );
  }

  selectNode(node:SimNode)  { this._sel.next({kind:'node',node}); }
  selectEdge(edge:SimEdge)  { this._sel.next({kind:'edge',edge}); }
  clearSelection()          { this._sel.next(null); }
}
