// inspector-panel.component.ts — click-to-inspect panel, collapsible to right
import { Component, inject, HostBinding, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule }      from '@angular/common';
import { Subject, takeUntil } from 'rxjs';
import { GraphService }      from '../../core/services/graph.service';
import { SubgraphResponse }  from '../../core/models/models';
import { ds, CRIT_STROKE }   from '../../core/models/models';

@Component({
  selector:'abacus-inspector-panel', standalone:true, imports:[CommonModule],
  templateUrl:'./inspector-panel.component.html',
  styleUrls:  ['./inspector-panel.component.scss'],
})
export class InspectorPanelComponent implements OnInit, OnDestroy {
  gs        = inject(GraphService);
  selected$ = this.gs.selected$;
  subgraph$ = this.gs.subgraph$;

  collapsed = signal(false);
  private destroy = new Subject<void>();

  /** Binds .collapsed class to :host so SCSS :host.collapsed transition fires */
  @HostBinding('class.collapsed')
  get isCollapsed() { return this.collapsed(); }

  toggle() { this.collapsed.update(v => !v); }

  ngOnInit() {
    // Auto-expand whenever the selected entity identity changes (new node / edge clicked)
    let lastId = '';
    this.gs.selected$.pipe(takeUntil(this.destroy)).subscribe(sel => {
      const id = sel?.kind === 'node' ? (sel.node?.id ?? '') : (sel?.edge?.id ?? '');
      if (sel && id !== lastId) { this.collapsed.set(false); lastId = id; }
      if (!sel) lastId = '';
    });
  }

  ngOnDestroy() { this.destroy.next(); this.destroy.complete(); }

  ds(domain: string)   { return ds(domain); }
  cs(crit:  string)    { return CRIT_STROKE[crit] ?? '#6b7280'; }

  // ── Grouped flow helpers ─────────────────────────────────────────────────
  // Groups multiple flows between the same system pair into a single card
  // showing the top criticality + a count badge when >1 flow exists.

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

  /** Unique upstream systems — each with aggregated top criticality + all flows */
  inboundGrouped(sg: SubgraphResponse, nodeId: string) {
    return this._groupFlows(sg.edges.filter(e => e.target === nodeId), 'source', sg);
  }

  /** Unique downstream systems — each with aggregated top criticality + all flows */
  outboundGrouped(sg: SubgraphResponse, nodeId: string) {
    return this._groupFlows(sg.edges.filter(e => e.source === nodeId), 'target', sg);
  }
}
