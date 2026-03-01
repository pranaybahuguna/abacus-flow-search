// inspector-panel.component.ts — click-to-inspect panel, no custom pipes
import { Component, inject } from '@angular/core';
import { CommonModule }      from '@angular/common';
import { GraphService }      from '../../core/services/graph.service';
import { SubgraphResponse }  from '../../core/models/models';
import { ds, CRIT_STROKE }   from '../../core/models/models';

@Component({
  selector:'abacus-inspector-panel', standalone:true, imports:[CommonModule],
  templateUrl:'./inspector-panel.component.html',
  styleUrls:  ['./inspector-panel.component.scss'],
})
export class InspectorPanelComponent {
  gs        = inject(GraphService);
  selected$ = this.gs.selected$;
  subgraph$ = this.gs.subgraph$;

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
