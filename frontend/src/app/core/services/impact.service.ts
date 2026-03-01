// impact.service.ts — calls GET /api/impact (hybrid vector+graph)
import { Injectable, inject }        from '@angular/core';
import { HttpClient, HttpParams }    from '@angular/common/http';
import { BehaviorSubject, of }       from 'rxjs';
import { tap, catchError }           from 'rxjs/operators';
import { ImpactResponse }            from '../models/models';

@Injectable({ providedIn:'root' })
export class ImpactService {
  private http = inject(HttpClient);
  private _r   = new BehaviorSubject<ImpactResponse|null>(null);
  private _l   = new BehaviorSubject<boolean>(false);
  readonly result$  = this._r.asObservable();
  readonly loading$ = this._l.asObservable();

  analyse(query:string, minScore=0.20, maxHops=3, entityId?: string) {
    this._l.next(true); this._r.next(null);
    let p = new HttpParams()
      .set('min_score', minScore)
      .set('max_hops',  maxHops);
    if (entityId) {
      p = p.set('entity_id', entityId);
    } else {
      p = p.set('q', query);
    }
    return this.http.get<ImpactResponse>('/api/impact',{params:p}).pipe(
      tap(r => { this._r.next(r); this._l.next(false); }),
      catchError(() => {
        this._l.next(false);
        const fb:ImpactResponse = {resolution:'AMBIGUOUS', message:'Analysis failed.', candidates:[]};
        return of(fb);
      }),
    );
  }
  clear() { this._r.next(null); }
}
