// dependency-view.component.ts
// Answers: "What does this system/process touch end-to-end?"
// Shows upstream (what it depends on) AND downstream (what it feeds)
import { Component, inject, signal } from '@angular/core';
import { CommonModule }              from '@angular/common';
import { FormsModule }               from '@angular/forms';
import { DependencyService }         from '../../core/services/dependency.service';
import { GraphService }              from '../../core/services/graph.service';
import {
  Footprint, FootprintNode, DependencyResponse,
  ds, SEVERITY_COLOR,
} from '../../core/models/models';

const EXAMPLES = [
  'Cross-Border Payment',
  'Trade Settlement',
  'Payments Hub',
  'AML and Sanctions Screening',
  'Regulatory Reporting',
  'Murex trading system',
  'DataWarehouse',
];

@Component({
  selector:    'abacus-dependency-view',
  standalone:  true,
  imports:     [CommonModule, FormsModule],
  templateUrl: './dependency-view.component.html',
  styleUrls:   ['./dependency-view.component.scss'],
})
export class DependencyViewComponent {
  private ds = inject(DependencyService);
  private gs = inject(GraphService);

  query    = signal('');
  maxHops  = signal(3);

  result$  = this.ds.result$;
  loading$ = this.ds.loading$;

  examples = EXAMPLES;

  run(q?: string) {
    const query = q ?? this.query();
    if (!query.trim()) return;
    this.query.set(query);
    this.ds.analyse(query, this.maxHops()).subscribe();
  }

  pick(c: { entity_id: string; entity_type: string; name: string }) {
    this.query.set(c.name);
    this.ds.analyse(c.name, this.maxHops(), c.entity_id, c.entity_type).subscribe();
  }

  // ── Data helpers ─────────────────────────────────────────────────────────────

  upstreamList(fp: Footprint): FootprintNode[] {
    return Object.values(fp.upstream).sort((a, b) => a.hops - b.hops);
  }

  downstreamList(fp: Footprint): FootprintNode[] {
    return Object.values(fp.downstream).sort((a, b) => a.hops - b.hops);
  }

  topCrit(node: FootprintNode): string {
    const W: Record<string,number> = {Critical:4, High:3, Medium:2, Low:1};
    return node.via_flows.sort((a,b) => (W[b.criticality]??0) - (W[a.criticality]??0))[0]
      ?.criticality ?? 'Low';
  }

  critColor(crit: string): string {
    const m: Record<string,string> = {
      Critical:'#ef4444', High:'#f59e0b', Medium:'#6b7280', Low:'#374151'
    };
    return m[crit] ?? '#6b7280';
  }

  hopLabel(h: number): string {
    return {1:'Direct',2:'Indirect',3:'Transitive'}[h] ?? `Hop ${h}`;
  }

  /** Load footprint into the graph canvas and switch to Explore tab */
  viewInGraph(fp: Footprint) {
    const coreId = fp.core[0]?.id;
    if (coreId) this.gs.loadSubgraph(coreId, 'system').subscribe(() => this.gs.setMode('graph'));
  }

  accent(domain: string) { return ds(domain).accent; }
  domBg(domain: string)  { return ds(domain).bg; }
  domBd(domain: string)  { return ds(domain).border; }
}
