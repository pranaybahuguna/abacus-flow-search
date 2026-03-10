// search-panel.component.ts — left sidebar (explore mode only)
import { Component, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule }  from '@angular/forms';
import { Subject, debounceTime, distinctUntilChanged, takeUntil } from 'rxjs';
import { SearchService }             from '../../core/services/search.service';
import { GraphService }              from '../../core/services/graph.service';
import { SearchResponse, SearchCandidate, SimNode } from '../../core/models/models';

const EXAMPLE_GROUPS = [
  { label: 'PROCESSES', items: [
      'cross border payment', 'trade settlement', 'customer onboarding',
      'trade finance', 'AML sanctions', 'market risk management',
  ]},
  { label: 'SYSTEMS', items: [
      'Murex trading system', 'Payments Hub', 'RiskEngine',
  ]},
  { label: 'FLOWS', items: [
      'SWIFT wire transfer', 'nostro reconciliation',
  ]},
];

@Component({
  selector:'abacus-search-panel', standalone:true, imports:[CommonModule,FormsModule],
  templateUrl:'./search-panel.component.html',
  styleUrls:  ['./search-panel.component.scss'],
})
export class SearchPanelComponent implements OnInit, OnDestroy {
  private ss      = inject(SearchService);
  gs              = inject(GraphService);        // public — template reads gs.hasPins() etc.
  private destroy = new Subject<void>();
  private typed$  = new Subject<string>();

  query          = signal('');
  response       = signal<SearchResponse|null>(null);
  loading        = signal(false);
  activeId       = signal<string|null>(null);
  tierDismissed  = signal(false);
  quickCollapsed = signal(false);
  /** Set of entity_ids currently being fetched for pinning */
  pinLoading     = signal<Set<string>>(new Set());
  exampleGroups  = EXAMPLE_GROUPS;

  TIER = {
    HIGH:   {color:'#22c55e', bg:'rgba(5,46,22,.85)',  icon:'✓', label:'AUTO-RESOLVED'  },
    MEDIUM: {color:'#f59e0b', bg:'rgba(28,17,7,.85)',  icon:'⚡', label:'DISAMBIGUATION' },
    LOW:    {color:'#ef4444', bg:'rgba(28,5,5,.85)',   icon:'?', label:'LOW CONFIDENCE'  },
  };
  tier = computed(() => this.response()?.tier ?? null);
  tc   = computed(() => this.tier() ? this.TIER[this.tier()!] : null);

  ngOnInit() {
    this.typed$.pipe(debounceTime(350), distinctUntilChanged(), takeUntil(this.destroy))
               .subscribe(q => { if (q.trim()) this._run(q); });
    this.ss.loading$.pipe(takeUntil(this.destroy)).subscribe(l => this.loading.set(l));
    this.ss.results$.pipe(takeUntil(this.destroy)).subscribe(r => this.response.set(r));
  }
  ngOnDestroy() { this.destroy.next(); this.destroy.complete(); }

  onInput(v:string)      { this.query.set(v); this.typed$.next(v); }
  onEnter()              { if (this.query().trim()) this._run(this.query()); }
  useExample(ex:string)  { this.query.set(ex); this._run(ex); }

  private _run(q:string) {
    this.tierDismissed.set(false);
    this.ss.search(q).subscribe(res => {
      if (res.tier==='HIGH' && res.resolved) this.pick(res.resolved);
    });
  }

  dismissTier()        { this.tierDismissed.set(true); }
  toggleQuickQueries() { this.quickCollapsed.update(v => !v); }

  pick(c: SearchCandidate) {
    this.activeId.set(c.entity_id);

    // ── Pin mode: don't reload canvas; just focus node if visible ──────────
    if (this.gs.hasPins()) {
      if (c.entity_type === 'system') {
        const node = this.gs.currentSubgraphValue?.nodes.find(n => n.id === c.entity_id);
        if (node) this.gs.selectNode(node as SimNode);
      }
      return;
    }

    // ── Normal (single-entity) mode ────────────────────────────────────────
    if (c.entity_type === 'system') {
      this.gs.contextBp.set(null);
      this.gs.loadSubgraph(c.entity_id, c.entity_type).subscribe(sg => {
        this.gs.inspectorSgCache.set(sg);
        const node = sg.nodes.find(n => n.id === c.entity_id);
        if (node) this.gs.selectNode(node as SimNode);
      });
    } else {
      this.gs.loadSubgraph(c.entity_id, c.entity_type).subscribe(sg => {
        if (c.entity_type === 'business_process') {
          this.gs.contextBp.set(c.name);
        } else if (c.entity_type === 'flow') {
          const edge = sg.edges.find(e => e.id === c.entity_id);
          const bp = edge?.business_process;
          this.gs.contextBp.set(bp?.length ? bp[0] : null);
        }
      });
    }
  }

  /** Pin or unpin a result card. Fetches the subgraph silently on first pin. */
  togglePin(c: SearchCandidate) {
    // Already pinned → unpin
    if (this.gs.pinColor(c.entity_id)) {
      this.gs.unpinEntity(c.entity_id);
      return;
    }
    if (this.gs.pins().size >= 15) return;

    // Mark as loading
    const loading = new Set(this.pinLoading());
    loading.add(c.entity_id);
    this.pinLoading.set(loading);

    this.gs.fetchSubgraph(c.entity_id, c.entity_type).subscribe({
      next: sg => {
        this.gs.pinEntity(c, sg);
        const done = new Set(this.pinLoading());
        done.delete(c.entity_id);
        this.pinLoading.set(done);
      },
      error: () => {
        const done = new Set(this.pinLoading());
        done.delete(c.entity_id);
        this.pinLoading.set(done);
      },
    });
  }

  isPinLoading(id: string): boolean { return this.pinLoading().has(id); }

  /** Returns true if this candidate can be pinned (not at cap, or already pinned) */
  canPin(c: SearchCandidate): boolean {
    return !!this.gs.pinColor(c.entity_id) || this.gs.pins().size < 15;
  }

  loadFull() {
    this.activeId.set('__full__');
    this.gs.contextBp.set(null);
    this.gs.clearAllPins();          // full map replaces pinned view
    this.gs.loadFull().subscribe();
  }

  scoreColor(s:number) { return s>=0.82?'#22c55e':s>=0.65?'#f59e0b':'#ef4444'; }
  track(_:number, c:SearchCandidate)         { return c.entity_id; }
  trackPin(_:number, p:{ candidate: SearchCandidate }) { return p.candidate.entity_id; }
}
