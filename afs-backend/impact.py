"""
impact.py — Impact scoring engine
===================================
Answers: "If I change system X, what breaks and how badly?"

SCORING FORMULA
  score = criticality_weight × hop_factor

  criticality_weight : Critical=1.0  High=0.6  Medium=0.3  Low=0.1
  hop_factor         : hop-1=1.0     hop-2=0.65  hop-3=0.35

  score ≥ 0.65 → CRITICAL
  score ≥ 0.35 → HIGH
  score < 0.35 → MEDIUM
  score < min_score → suppressed (noise)

Default min_score=0.20 filters Low-criticality at all hops and
Medium-criticality beyond hop-2. This keeps output clean.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing      import Any

CRIT_WEIGHT = {"Critical":1.0, "High":0.6, "Medium":0.3, "Low":0.1}
HOP_FACTOR  = {1:1.0, 2:0.65, 3:0.35}


@dataclass
class AffectedSystem:
    id:           str
    name:         str
    domain:       str
    hops:         int
    impact_score: float
    severity:     str       # CRITICAL | HIGH | MEDIUM
    reason:       str       # one plain-English sentence
    via_flows:    list[dict]


@dataclass
class ImpactReport:
    source_id:     str
    source_name:   str
    source_domain: str
    affected:          list[AffectedSystem] = field(default_factory=list)
    processes_at_risk: list[dict]           = field(default_factory=list)
    critical_paths:    list[dict]           = field(default_factory=list)
    total_affected:    int  = 0
    critical_count:    int  = 0
    high_count:        int  = 0
    medium_count:      int  = 0
    regulatory_risk:   bool = False


def analyse(system_id: str, graph: Any,
            min_score: float = 0.20,
            max_hops:  int   = 3) -> ImpactReport:
    src    = graph.get_system(system_id) or {}
    report = ImpactReport(
        source_id     = system_id,
        source_name   = src.get("name",   system_id),
        source_domain = src.get("domain", ""),
    )

    # 1. Graph traversal
    bfs = graph.downstream_bfs(system_id, max_hops=max_hops)

    # 2. Score, filter, label
    affected: list[AffectedSystem] = []
    for node in bfs.values():
        top_crit   = max(node["via_flows"],
                         key=lambda f: CRIT_WEIGHT.get(f["criticality"], 0),
                         default={"criticality": "Low"})["criticality"]
        score      = round(HOP_FACTOR.get(node["hops"], 0.2)
                           * CRIT_WEIGHT.get(top_crit, 0.1), 3)
        if score < min_score:
            continue
        affected.append(AffectedSystem(
            id           = node["id"],
            name         = node["name"],
            domain       = node["domain"],
            hops         = node["hops"],
            impact_score = score,
            severity     = _severity(score),
            reason       = _reason(node, report.source_name),
            via_flows    = _dedupe(node["via_flows"]),
        ))

    affected.sort(key=lambda a: (-a.impact_score, a.hops))
    report.affected = affected

    # 3. Business context
    report.critical_paths    = graph.direct_critical_flows(system_id)
    report.processes_at_risk = graph.affected_processes(system_id,
                                                         {a.id for a in affected})
    # 4. Summary
    report.total_affected  = len(affected)
    report.critical_count  = sum(1 for a in affected if a.severity == "CRITICAL")
    report.high_count      = sum(1 for a in affected if a.severity == "HIGH")
    report.medium_count    = sum(1 for a in affected if a.severity == "MEDIUM")
    report.regulatory_risk = any(p.get("regulatory") for p in report.processes_at_risk)
    return report


def to_dict(r: ImpactReport) -> dict:
    return {
        "source":   {"id":r.source_id,"name":r.source_name,"domain":r.source_domain},
        "summary":  {"total_affected":r.total_affected,"critical_count":r.critical_count,
                     "high_count":r.high_count,"medium_count":r.medium_count,
                     "regulatory_risk":r.regulatory_risk},
        "critical_paths":    r.critical_paths,
        "processes_at_risk": r.processes_at_risk,
        "affected_systems": [
            {"id":a.id,"name":a.name,"domain":a.domain,"hops":a.hops,
             "impact_score":a.impact_score,"severity":a.severity,
             "reason":a.reason,"via_flows":a.via_flows}
            for a in r.affected
        ],
    }


def _severity(score: float) -> str:
    if score >= 0.65: return "CRITICAL"
    if score >= 0.35: return "HIGH"
    return "MEDIUM"

def _reason(node: dict, source_name: str) -> str:
    flows = node["via_flows"]
    if not flows:
        return f"Connected to {source_name} through the data graph."
    top  = max(flows, key=lambda f: CRIT_WEIGHT.get(f["criticality"],0))
    verb = {1:"directly receives",2:"indirectly receives",3:"transitively receives"}.get(node["hops"],"receives")
    bp_val = top.get("business_process", [])
    proc = ", ".join(bp_val) if isinstance(bp_val, list) else bp_val
    s    = f"{verb} {top['information_entity']} from {source_name} ({top['criticality']} criticality)"
    return s + (f" as part of {proc}." if proc else ".")

def _dedupe(flows: list[dict]) -> list[dict]:
    seen, out = set(), []
    for f in flows:
        k = (f["information_entity"], f["criticality"])
        if k not in seen:
            seen.add(k); out.append(f)
    return out
