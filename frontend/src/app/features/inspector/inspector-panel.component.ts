// inspector-panel.component.ts — click-to-inspect panel, collapsible to right
import { Component, inject, HostBinding, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule }      from '@angular/common';
import { FormsModule }       from '@angular/forms';
import { Subject, takeUntil } from 'rxjs';
import { GraphService }      from '../../core/services/graph.service';
import { SubgraphResponse }  from '../../core/models/models';
import { ds, CRIT_STROKE, Flow, SimNode } from '../../core/models/models';

@Component({
  selector:'abacus-inspector-panel', standalone:true, imports:[CommonModule, FormsModule],
  templateUrl:'./inspector-panel.component.html',
  styleUrls:  ['./inspector-panel.component.scss'],
})
export class InspectorPanelComponent implements OnInit, OnDestroy {
  gs        = inject(GraphService);
  selected$ = this.gs.selected$;
  subgraph$ = this.gs.subgraph$;

  collapsed   = signal(false);
  flowSearch  = signal('');        // live filter for upstream/downstream flows
  private destroy = new Subject<void>();

  /** Binds .collapsed class to :host so SCSS :host.collapsed transition fires */
  @HostBinding('class.collapsed')
  get isCollapsed() { return this.collapsed(); }

  toggle() { this.collapsed.update(v => !v); }

  ngOnInit() {
    // Auto-expand and reset flow search whenever a new node/edge is selected
    let lastId = '';
    this.gs.selected$.pipe(takeUntil(this.destroy)).subscribe(sel => {
      const id = sel?.kind === 'node' ? (sel.node?.id ?? '') : (sel?.edge?.id ?? '');
      if (sel && id !== lastId) {
        this.collapsed.set(false);
        if (sel.kind === 'node') this.flowSearch.set(''); // reset search on new node
        lastId = id;
      }
      if (!sel) { lastId = ''; this.flowSearch.set(''); }
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

  /** Match a flow against the current flowSearch signal — searches data_entity,
   *  business_process, protocol and criticality (case-insensitive substring). */
  private _matchFlow(f: Flow, q: string): boolean {
    if (!q) return true;
    const lq = q.toLowerCase();
    return `${f.data_entity} ${f.business_process} ${f.protocol} ${f.criticality}`
      .toLowerCase().includes(lq);
  }

  /** Unique upstream systems filtered by current flowSearch */
  inboundGrouped(sg: SubgraphResponse, nodeId: string) {
    const q = this.flowSearch();
    return this._groupFlows(
      sg.edges.filter(e => e.target === nodeId && this._matchFlow(e, q)),
      'source', sg,
    );
  }

  /** Unique downstream systems filtered by current flowSearch */
  outboundGrouped(sg: SubgraphResponse, nodeId: string) {
    const q = this.flowSearch();
    return this._groupFlows(
      sg.edges.filter(e => e.source === nodeId && this._matchFlow(e, q)),
      'target', sg,
    );
  }

  /** Select a flow from the panel — triggers graph edge highlight + pan-to */
  selectFlow(flow: Flow, sg: SubgraphResponse) {
    const sourceNode = sg.nodes.find(n => n.id === flow.source) as SimNode | undefined;
    const targetNode = sg.nodes.find(n => n.id === flow.target) as SimNode | undefined;
    this.gs.selectEdge({ ...flow, sourceNode, targetNode });
  }
}
