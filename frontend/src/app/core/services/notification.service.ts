// notification.service.ts — signal-based toast system
import { Injectable, signal } from '@angular/core';
export interface Toast { id:number; kind:'error'|'info'|'success'; message:string; }

@Injectable({ providedIn:'root' })
export class NotificationService {
  private _n = 0;
  readonly toasts = signal<Toast[]>([]);
  error(m:string)   { this._push('error',  m); }
  info(m:string)    { this._push('info',   m); }
  success(m:string) { this._push('success',m); }
  dismiss(id:number){ this.toasts.update(t=>t.filter(x=>x.id!==id)); }
  private _push(kind:Toast['kind'], message:string) {
    const id = ++this._n;
    this.toasts.update(t=>[...t,{id,kind,message}]);
    setTimeout(()=>this.dismiss(id), 4500);
  }
}
