// search.service.ts — calls GET /api/search (step 1 of hybrid pipeline)
import { Injectable, inject }        from '@angular/core';
import { HttpClient, HttpParams }    from '@angular/common/http';
import { BehaviorSubject, of }       from 'rxjs';
import { tap, catchError }           from 'rxjs/operators';
import { SearchResponse, EntityType } from '../models/models';

@Injectable({ providedIn:'root' })
export class SearchService {
  private http = inject(HttpClient);
  private _r   = new BehaviorSubject<SearchResponse|null>(null);
  private _l   = new BehaviorSubject<boolean>(false);
  readonly results$ = this._r.asObservable();
  readonly loading$ = this._l.asObservable();

  search(query: string, entityType?: EntityType,
         inclSystems = true, inclBps = true, inclFlows = false) {
    this._l.next(true);
    let p = new HttpParams().set('q', query);
    if (entityType) p = p.set('entity_type', entityType);
    // Always send all three flags so backend never falls back to defaults
    p = p.set('include_systems', String(inclSystems))
         .set('include_bps',     String(inclBps))
         .set('include_flows',   String(inclFlows));
    return this.http.get<SearchResponse>('/api/search', {params:p}).pipe(
      tap(r => { this._r.next(r); this._l.next(false); }),
      catchError(() => {
        this._l.next(false);
        const fb:SearchResponse = {tier:'LOW', message:'Search failed — is the backend running?', candidates:[]};
        this._r.next(fb); return of(fb);
      }),
    );
  }
  clear() { this._r.next(null); }
}
