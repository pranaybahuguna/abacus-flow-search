// models.ts — single source of truth for all TypeScript types
// Mirrors Python Pydantic schemas in api.py exactly.
// ONE file. No duplication across multiple model files.

export type EntityType  = 'system' | 'flow' | 'business_process';
export type Criticality = 'Critical' | 'High' | 'Medium' | 'Low';
export type Tier        = 'HIGH' | 'MEDIUM' | 'LOW';
export type Severity    = 'CRITICAL' | 'HIGH' | 'MEDIUM';
export type Mode        = 'graph' | 'impact';

// ── Graph entities ────────────────────────────────────────────────────────────
export interface System {
  id: string; name: string; domain: string;
  description: string; owner: string; tags: string[];
  legal_entity?: string;
  major_business_process?: string[];
  ciat_computed?: string;
  active?: boolean;
  confidentiality?: string;
  data_storage_territory?: string;
  pd_sensitivity_declared?: boolean;
}

export interface Flow {
  id: string; source_app: string; sinc_app: string;
  information_entity: string; business_process: string;
  functional_block?: string;
  message_description?: string;
  transport_protocol: string; criticality: Criticality; frequency: string;
  exchange_nature?: string;
  ciat_computed?: string;
  confidentiality?: string;
  personal_data_protection?: string;
}

// ── Search ────────────────────────────────────────────────────────────────────
export interface SearchCandidate {
  entity_id: string; entity_type: EntityType;
  name: string; score: number; domain?: string;
}

export interface SearchResponse {
  tier: Tier; message: string;
  resolved?: SearchCandidate; candidates: SearchCandidate[];
}

// ── Graph / subgraph ──────────────────────────────────────────────────────────
export interface SubgraphResponse {
  label: string; regulatory?: string;
  nodes: System[]; edges: Flow[];
}

// D3 augments nodes with position data at runtime
export interface SimNode extends System {
  x?: number; y?: number;
  fx?: number | null; fy?: number | null;
  vx?: number; vy?: number;
  index?: number;
}

export interface SimEdge extends Flow {
  source: any;  // D3 replaces string with SimNode reference
  target: any;
  sourceNode?: SimNode;
  targetNode?: SimNode;
  index?: number;
}

// ── Impact ────────────────────────────────────────────────────────────────────
export interface ViaFlow {
  information_entity: string; criticality: string;
  business_process: string; flow_id: string;
}

export interface AffectedSystem {
  id: string; name: string; domain: string;
  hops: number; impact_score: number;
  severity: Severity; reason: string; via_flows: ViaFlow[];
}

export interface ImpactSummary {
  total_affected: number; critical_count: number;
  high_count: number; medium_count: number; regulatory_risk: boolean;
}

export interface CriticalPath {
  to_system: string; to_id: string;
  information_entity: string; process: string; flow_id: string;
}

export interface ProcessAtRisk {
  id: string; name: string; regulatory: string;
}

export interface ImpactData {
  source:            { id: string; name: string; domain: string };
  summary:           ImpactSummary;
  critical_paths:    CriticalPath[];
  processes_at_risk: ProcessAtRisk[];
  affected_systems:  AffectedSystem[];
}

export interface ImpactResponse {
  resolution:  'RESOLVED' | 'AMBIGUOUS';
  message?:    string;
  candidates?: SearchCandidate[];
  search?:     any;
  impact?:     ImpactData;
}

// ── Dependency footprint ───────────────────────────────────────────────────────
export interface FootprintNode {
  id: string; name: string; domain: string;
  hops: number; via_flows: ViaFlow[];
}

export interface FootprintSummary {
  core_count?: number; upstream_count: number;
  downstream_count: number; total_footprint: number;
}

export interface Footprint {
  label: string; regulatory?: string;
  core:       Array<{ id:string; name:string; domain:string; role?:string }>;
  upstream:   Record<string, FootprintNode>;
  downstream: Record<string, FootprintNode>;
  summary:    FootprintSummary;
  nodes:      System[];
  edges:      Flow[];
}

export interface DependencyResponse {
  resolution:    'RESOLVED' | 'AMBIGUOUS';
  resolved_type?: 'system' | 'business_process';
  resolved_name?: string;
  score?:         number;
  message?:       string;
  candidates?:    SearchCandidate[];
  footprint?:     Footprint;
}

// ── Inspector selection ───────────────────────────────────────────────────────
export interface Selection {
  kind: 'node' | 'edge';
  node?: SimNode;
  edge?: SimEdge;
}

// ── Visual styles ─────────────────────────────────────────────────────────────
export interface DomainStyle { bg:string; border:string; accent:string; text:string; }

export const DOMAIN_STYLES: Record<string, DomainStyle> = {
  'Trading':      { bg:'#071829', border:'#1e5799', accent:'#4a9eff', text:'#93c5fd' },
  'Core Banking': { bg:'#071f18', border:'#1e7744', accent:'#34d399', text:'#6ee7b7' },
  'Payments':     { bg:'#071a10', border:'#226633', accent:'#4ade80', text:'#86efac' },
  'Treasury':     { bg:'#1c1207', border:'#996622', accent:'#fbbf24', text:'#fcd34d' },
  'Post-Trade':   { bg:'#101a07', border:'#557722', accent:'#a3e635', text:'#bef264' },
  'Compliance':   { bg:'#12071c', border:'#7733bb', accent:'#c084fc', text:'#d8b4fe' },
  'Reporting':    { bg:'#1c1807', border:'#997722', accent:'#facc15', text:'#fde68a' },
  'Risk':         { bg:'#1c0707', border:'#991122', accent:'#f87171', text:'#fca5a5' },
  'Trade Finance':{ bg:'#071c1c', border:'#229988', accent:'#22d3ee', text:'#67e8f9' },
  'DEFAULT':      { bg:'#0d1117', border:'#30363d', accent:'#8b949e', text:'#c9d1d9' },
};

export const CRIT_STROKE: Record<string, string> = {
  Critical:'#ef4444', High:'#60a5fa', Medium:'#6b7280', Low:'#374151',
};
export const CRIT_WIDTH: Record<string, number>  = {
  Critical:3, High:2, Medium:1.5, Low:1,
};
export const CRIT_DASH: Record<string, string|null> = {
  Critical:null, High:null, Medium:null, Low:'3,6',
};

export const SEVERITY_COLOR: Record<Severity,string> = {
  CRITICAL:'#ef4444', HIGH:'#f59e0b', MEDIUM:'#6b7280',
};

export function ds(domain: string): DomainStyle {
  return DOMAIN_STYLES[domain] ?? DOMAIN_STYLES['DEFAULT'];
}
