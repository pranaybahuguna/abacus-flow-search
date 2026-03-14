// dependency.service.ts — calls GET /api/dependencies
// Returns full upstream + downstream footprint for a system or business process
import { Injectable, inject }        from '@angular/core';
import { HttpClient, HttpParams }    from '@angular/common/http';
import { BehaviorSubject, of }       from 'rxjs';
import { tap, catchError }           from 'rxjs/operators';
import { DependencyResponse }        from '../models/models';

@Injectable({ providedIn: 'root' })
export class DependencyService {
  private http = inject(HttpClient);
  private _r   = new BehaviorSubject<DependencyResponse | null>(null);
  private _l   = new BehaviorSubject<boolean>(false);

  readonly result$  = this._r.asObservable();
  readonly loading$ = this._l.asObservable();

  /**
   * @param filterType  Optional entity type filter for text searches ('system' | 'business_process').
   *                    Ignored when entityId+entityType are provided (direct picks always use those).
   */
  analyse(query: string, maxHops = 3, entityId?: string, entityType?: string, filterType?: string) {
    this._l.next(true);
    this._r.next(null);
    let p = new HttpParams().set('max_hops', maxHops);
    if (entityId && entityType) {
      p = p.set('entity_id', entityId).set('entity_type', entityType);
    } else {
      p = p.set('q', query);
      if (filterType && filterType !== 'all') p = p.set('entity_type', filterType);
    }
    return this.http.get<DependencyResponse>('/api/dependencies', { params: p }).pipe(
      tap(r  => { this._r.next(r); this._l.next(false); }),
      catchError(() => {
        this._l.next(false);
        const fb: DependencyResponse = {
          resolution: 'AMBIGUOUS',
          message:    'Dependency analysis failed — is the backend running?',
        };
        this._r.next(fb);
        return of(fb);
      }),
    );
  }

  clear() { this._r.next(null); }
}
