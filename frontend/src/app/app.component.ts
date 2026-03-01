// app.component.ts — root shell with EXPLORE / IMPACT / DEPENDENCIES mode toggle
import { Component, inject } from '@angular/core';
import { CommonModule }              from '@angular/common';
import { SearchPanelComponent }      from './features/search/search-panel.component';
import { GraphCanvasComponent }      from './features/graph/graph-canvas.component';
import { InspectorPanelComponent }   from './features/inspector/inspector-panel.component';
import { ImpactViewComponent }       from './features/impact/impact-view.component';
import { DependencyViewComponent }   from './features/dependency/dependency-view.component';
import { GraphService, AppMode }     from './core/services/graph.service';
import { NotificationService }       from './core/services/notification.service';

@Component({
  selector:    'abacus-root',
  standalone:  true,
  imports: [CommonModule, SearchPanelComponent, GraphCanvasComponent,
            InspectorPanelComponent, ImpactViewComponent, DependencyViewComponent],
  templateUrl: './app.component.html',
  styleUrls:   ['./app.component.scss'],
})
export class AppComponent {
  gs     = inject(GraphService);
  notify = inject(NotificationService);

  mode      = this.gs.mode;
  subgraph$ = this.gs.subgraph$;
  selected$ = this.gs.selected$;
  toasts    = this.notify.toasts;

  setMode(m: AppMode) { this.gs.setMode(m); }
  loadFull()          { this.gs.loadFull().subscribe(); this.gs.setMode('graph'); }
  dismiss(id:number)  { this.notify.dismiss(id); }
}
