// api.interceptor.ts
// Runs on every HTTP call. Adds /api prefix + JSON headers. Catches errors → toasts.
import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject }                               from '@angular/core';
import { catchError, throwError }               from 'rxjs';
import { NotificationService }                  from '../services/notification.service';

export const apiInterceptor: HttpInterceptorFn = (req, next) => {
  const notify = inject(NotificationService);
  const r = req.clone({
    url:        req.url.startsWith('/api') ? req.url : `/api${req.url}`,
    setHeaders: { 'Content-Type':'application/json', 'Accept':'application/json' },
  });
  return next(r).pipe(
    catchError((e: HttpErrorResponse) => {
      notify.error(`${e.status}: ${e.error?.detail ?? e.message}`);
      return throwError(() => e);
    }),
  );
};
