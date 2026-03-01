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

  /** Flows from subgraph where target === nodeId */
  inbound(sg: SubgraphResponse, nodeId: string) {
    return sg.edges.filter(e => e.target === nodeId);
  }

  /** Flows from subgraph where source === nodeId */
  outbound(sg: SubgraphResponse, nodeId: string) {
    return sg.edges.filter(e => e.source === nodeId);
  }

  /** Resolve system name from subgraph nodes */
  sysName(sg: SubgraphResponse, id: string): string {
    return sg.nodes.find(n => n.id === id)?.name ?? id;
  }
}
