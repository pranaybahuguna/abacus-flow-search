// impact-view.component.ts — IMPACT mode: "what breaks if I change X?"
import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule }  from '@angular/common';
import { FormsModule }   from '@angular/forms';
import { ImpactService } from '../../core/services/impact.service';
import { GraphService }  from '../../core/services/graph.service';
import {
  ImpactData, AffectedSystem,
  SEVERITY_COLOR, ds,
} from '../../core/models/models';

const EXAMPLES = [
  'Payments Hub', 'Murex trading system', 'Actimize',
  'SWIFT Gateway', 'Temenos T24', 'RiskEngine',
];

@Component({
  selector:'abacus-impact-view', standalone:true, imports:[CommonModule, FormsModule],
  templateUrl:'./impact-view.component.html',
  styleUrls:  ['./impact-view.component.scss'],
})
export class ImpactViewComponent {
  private is = inject(ImpactService);
  private gs = inject(GraphService);

  query    = signal('');
  maxHops  = signal(3);
  expanded = signal<Set<string>>(new Set());

  result$  = this.is.result$;
  loading$ = this.is.loading$;

  examples = EXAMPLES;

  SEV = {
    CRITICAL: { color:'#ef4444', bg:'rgba(28,5,5,.8)',   border:'#7f1d1d20' },
    HIGH:     { color:'#f59e0b', bg:'rgba(28,17,5,.8)',  border:'#78350f20' },
    MEDIUM:   { color:'#6b7280', bg:'rgba(15,20,40,.8)', border:'#1e3a5f20' },
  };

  run(q?: string) {
    const query = q ?? this.query();
    if (!query.trim()) return;
    this.query.set(query);
    this.expanded.set(new Set());
    this.is.analyse(query, 0.20, this.maxHops()).subscribe();
  }

  pick(c: { entity_id: string; name: string }) {
    this.query.set(c.name);
    this.expanded.set(new Set());
    this.is.analyse(c.name, 0.20, this.maxHops(), c.entity_id).subscribe();
  }

  toggle(id: string) {
    const s = new Set(this.expanded());
    s.has(id) ? s.delete(id) : s.add(id);
    this.expanded.set(s);
  }

  isOpen(id: string) { return this.expanded().has(id); }

  /** Jump to explore mode with this system loaded in the graph */
  explore(id: string) {
    this.gs.loadSubgraph(id, 'system').subscribe(() => this.gs.setMode('graph'));
  }

  /** Group affected systems by hop distance */
  byHop(systems: AffectedSystem[]) {
    const m = new Map<number, AffectedSystem[]>();
    for (const s of systems) m.set(s.hops, [...(m.get(s.hops) ?? []), s]);
    const HOP_LABEL: Record<number,string> = {1:'Direct',2:'Indirect',3:'Transitive'};
    return Array.from(m.entries()).sort(([a],[b])=>a-b)
      .map(([hop, items]) => ({ hop, label: HOP_LABEL[hop] ?? `Hop ${hop}`, items }));
  }

  sev(s: string)      { return (this.SEV as any)[s] ?? this.SEV.MEDIUM; }
  accent(domain: string) { return ds(domain).accent; }
  domBg(domain:string)   { return ds(domain).bg; }
  domBorder(domain:string){return ds(domain).border; }
  scoreW(n: number)   { return `${Math.round(n*100)}%`; }
  sevColor(s: string) { return (SEVERITY_COLOR as any)[s] ?? '#6b7280'; }
}
