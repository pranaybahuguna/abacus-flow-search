"""
api.py — FastAPI REST API  (LangChain + OpenAI + Chroma edition)
=================================================================
Only change from previous version:
  - Removed SentenceTransformer import and model loading
  - VectorSearch now loads the model itself (via LangChain OpenAIEmbeddings)
  - All _vsearch.search() calls no longer pass _model as first argument

Everything else — graph_store, impact, endpoints — is identical.

Install:
    pip install fastapi uvicorn langchain langchain-openai langchain-chroma chromadb openai networkx

Set key:
    export OPENAI_API_KEY=sk-...

Run:
    python graph_store.py     # once
    python embeddings.py      # once
    uvicorn api:app --reload --port 8000
"""
from __future__ import annotations
from typing import Literal, Optional
import os

from dotenv import load_dotenv
load_dotenv()  # loads OPENAI_API_KEY (and any other vars) from backend/.env

from fastapi                  import FastAPI, Query, HTTPException
from fastapi.middleware.cors  import CORSMiddleware
from fastapi.staticfiles      import StaticFiles
from fastapi.responses        import FileResponse
from pydantic                 import BaseModel

from graph_store   import GraphStore
from vector_search import VectorSearch, HIGH_THRESHOLD, MEDIUM_THRESHOLD
from impact        import analyse, to_dict

# ── Startup — loaded once, reused forever ─────────────────────────────────────
print("Loading graph store…")
_graph   = GraphStore()

print("Loading vector search (Chroma + OpenAI)…")
_vsearch = VectorSearch()                  # connects to Chroma, loads OAI embeddings

print("✅  API ready")

# ── Pydantic schemas ──────────────────────────────────────────────────────────
EntityType = Literal["system", "flow", "business_process"]

class CandidateOut(BaseModel):
    entity_id:   str
    entity_type: str
    name:        str
    score:       float
    domain:      Optional[str] = None

class SearchOut(BaseModel):
    tier:       Literal["HIGH","MEDIUM","LOW"]
    message:    str
    resolved:   Optional[CandidateOut] = None
    candidates: list[CandidateOut]     = []

class SystemOut(BaseModel):
    id:str; name:str; domain:str; description:str; owner:str; tags:list[str]
    legal_entity:Optional[str]=None; major_business_process:list[str]=[]
    ciat_computed:Optional[str]=None; active:bool=True
    confidentiality:Optional[str]=None; data_storage_territory:Optional[str]=None
    pd_sensitivity_declared:Optional[str]=None
    # Pre-computed layout coordinates — present only on full-graph responses.
    # When set, the frontend renders directly without running a D3 simulation.
    layout_x:Optional[float]=None; layout_y:Optional[float]=None

class FlowOut(BaseModel):
    id:str; source_app:str; sinc_app:str; information_entity:str
    business_process:list[str]=[]; functional_block:Optional[str]=None
    message_description:Optional[str]=None; transport_protocol:str
    criticality:str; frequency:str; exchange_nature:Optional[str]=None
    ciat_computed:Optional[str]=None; confidentiality:Optional[str]=None
    personal_data_protection:Optional[str]=None

class SubgraphOut(BaseModel):
    label:str; regulatory:Optional[str]=None
    nodes:list[SystemOut]; edges:list[FlowOut]
    truncated:bool=False; total_nodes:Optional[int]=None

# Maximum nodes the D3 canvas will receive in one subgraph response.
# Cap applied ONLY to the full-graph endpoint.
# Entity-specific queries (system, BP, flow) are never capped — a business
# process may legitimately involve hundreds of systems and truncating it would
# give a misleading picture.
FULL_GRAPH_MAX_NODES = 500

# ── Helpers ───────────────────────────────────────────────────────────────────

def _sys(n: dict) -> SystemOut:
    return SystemOut(
        id=n.get("main_id", n.get("id","")),
        name=n.get("name",""), domain=n.get("domain",""),
        description=n.get("description", n.get("purpose","")),
        owner=n.get("owner",""), tags=n.get("tags",[]),
        legal_entity=n.get("legal_entity"),
        major_business_process=n.get("major_business_process",[]),
        ciat_computed=n.get("ciat_computed"),
        active=n.get("active", True),
        confidentiality=n.get("confidentiality"),
        data_storage_territory=n.get("data_storage_territory"),
        pd_sensitivity_declared=n.get("pd_sensitivity_declared", ""),
        layout_x=n.get("layout_x"),
        layout_y=n.get("layout_y"),
    )

def _flow(e: dict) -> FlowOut:
    return FlowOut(
        id=e.get("id",""),
        source_app=e.get("source_app", e.get("source","")),
        sinc_app=e.get("sinc_app", e.get("target","")),
        information_entity=e.get("information_entity", e.get("data_entity","")),
        business_process=e.get("business_process",[]),
        functional_block=e.get("functional_block"),
        message_description=e.get("message_description", e.get("description","")),
        transport_protocol=e.get("transport_protocol", e.get("protocol","")),
        criticality=e.get("criticality",""),
        frequency=e.get("frequency",""),
        exchange_nature=e.get("exchange_nature"),
        ciat_computed=e.get("ciat_computed"),
        confidentiality=e.get("confidentiality"),
        personal_data_protection=e.get("personal_data_protection"),
    )

def _subgraph_out(sg: dict, max_nodes: int | None = None) -> SubgraphOut:
    """
    Serialise a raw graph dict into a SubgraphOut Pydantic model.

    max_nodes: when set, caps the number of nodes returned and marks the
               response as truncated so the UI can warn the user.
               Pass None (default) for entity-specific queries — business
               processes, system neighbourhoods, and flow subgraphs are
               naturally bounded and should never be silently truncated.
    """
    all_nodes = sg["nodes"]
    total     = len(all_nodes)
    truncated = max_nodes is not None and total > max_nodes
    if truncated:
        # Keep the first max_nodes nodes and only edges whose both endpoints
        # are in that kept set, so the graph stays self-consistent.
        kept_ids  = {n.get("main_id", n.get("id","")) for n in all_nodes[:max_nodes]}
        all_nodes = all_nodes[:max_nodes]
        sg_edges  = [e for e in sg["edges"]
                     if e.get("source_app","") in kept_ids
                     and e.get("sinc_app","")   in kept_ids]
    else:
        sg_edges = sg["edges"]
    return SubgraphOut(
        label       = sg["label"],
        regulatory  = sg.get("regulatory"),
        nodes       = [_sys(n) for n in all_nodes],
        edges       = [_flow(e) for e in sg_edges],
        truncated   = truncated,
        total_nodes = total,
    )

def _candidate_out(c) -> CandidateOut:
    candidate_out = CandidateOut(entity_id=c.entity_id, entity_type=c.entity_type,
                        name=c.name, score=c.score, domain=c.domain)
    return candidate_out

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="Abacus API", version="3.0.0")

# In production (STATIC_DIR set) the app is same-origin — no CORS needed.
# In dev, allow the ng serve port.
_cors_origins = os.environ.get("CORS_ORIGINS", "http://localhost:4200").split(",")
app.add_middleware(CORSMiddleware,
                   allow_origins=_cors_origins,
                   allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {
        "status":  "ok",
        "graph":   f"{_graph._G.number_of_nodes()} nodes, {_graph._G.number_of_edges()} edges",
        "vectors": f"Chroma ({_vsearch._store._collection.count()} docs)",
    }


@app.get("/api/search", response_model=SearchOut)
def search(
    q:               str                  = Query(..., min_length=1),
    entity_type:     Optional[EntityType] = Query(None),
    include_systems: bool                 = Query(True,  description="Include system results"),
    include_bps:     bool                 = Query(True,  description="Include business-process results"),
    include_flows:   bool                 = Query(False, description="Include flow results"),
    top_k:           int                  = Query(20, ge=1, le=50, description="Max candidates to return"),
):
    """
    STEP 1 — LangChain vector search via Chroma + OpenAI embeddings.
    Returns candidates with confidence tier (HIGH/MEDIUM/LOW).
    Angular auto-triggers /api/graph if tier == HIGH.

    WHY per-type search (not a flat mixed search):
    With 44k flows vs ~100 systems, a flat top_k=20 query fills all slots
    with flows — the system the user typed by name never appears.
    Searching each enabled type separately guarantees proportional slots
    and matches how the DEPENDENCIES page finds systems reliably.
    """
    # ── Explicit entity_type: single-type search, no filtering needed ──────────
    if entity_type is not None:
        r = _vsearch.search(q, entity_type=entity_type, top_k=top_k)
        return SearchOut(
            tier=r.tier, message=r.message,
            resolved=_candidate_out(r.resolved) if r.resolved else None,
            candidates=[_candidate_out(c) for c in r.candidates],
        )

    # ── Multi-type search: one Chroma query per enabled type ───────────────────
    enabled: list[str] = []
    if include_systems: enabled.append("system")
    if include_bps:     enabled.append("business_process")
    if include_flows:   enabled.append("flow")

    if not enabled:
        return SearchOut(tier="LOW", message="No entity types selected.", candidates=[])

    # Each type gets an equal quota; minimum 5 per type so small corpora
    # (e.g. only 15 systems) are fully represented.
    per_k = max(5, (top_k + len(enabled) - 1) // len(enabled))

    combined = []
    for etype in enabled:
        sub = _vsearch.search(q, entity_type=etype, top_k=per_k)
        combined.extend(sub.candidates)

    combined.sort(key=lambda c: -c.score)
    combined = combined[:top_k]

    if not combined:
        return SearchOut(
            tier="LOW",
            message=f"No entities matched '{q}'.",
            candidates=[],
        )

    best = combined[0]
    if best.score >= HIGH_THRESHOLD:
        tier     = "HIGH"
        resolved = best
        message  = f"Resolved to '{best.name}' (confidence {best.score:.0%})"
    elif best.score >= MEDIUM_THRESHOLD:
        tier     = "MEDIUM"
        resolved = None
        close    = [c for c in combined if c.score >= MEDIUM_THRESHOLD]
        names    = ", ".join(f"'{c.name}'" for c in close[:3])
        message  = f"Multiple matches: {names}. Which did you mean?"
    else:
        tier     = "LOW"
        resolved = None
        message  = f"Low confidence ({best.score:.0%}) for '{q}'. Try a more specific term."

    return SearchOut(
        tier=tier, message=message,
        resolved=_candidate_out(resolved) if resolved else None,
        candidates=[_candidate_out(c) for c in combined],
    )


@app.get("/api/graph", response_model=SubgraphOut)
def get_subgraph(
    entity_id:   str        = Query(...),
    entity_type: EntityType = Query(...),
):
    """STEP 2 — Graph DB subgraph for D3 rendering."""
    if entity_type == "business_process":
        sg = _graph.subgraph_for_process(entity_id)
    elif entity_type == "system":
        sg = _graph.subgraph_for_system(entity_id)
    elif entity_type == "flow":
        sg = _graph.subgraph_for_flow(entity_id)
    else:
        raise HTTPException(400, f"Unknown entity_type: {entity_type}")
    if not sg["nodes"]:
        raise HTTPException(404, f"{entity_type} '{entity_id}' not found")
    return _subgraph_out(sg)


@app.get("/api/graph/full", response_model=SubgraphOut)
def get_full_graph():
    # Full graph can be enormous — cap it so the browser stays responsive.
    # Entity-specific queries (/api/graph) are never capped.
    return _subgraph_out(_graph.full_graph(), max_nodes=FULL_GRAPH_MAX_NODES)


@app.get("/api/impact")
def get_impact(
    q:         Optional[str] = Query(None),
    entity_id: Optional[str] = Query(None, description="Direct system ID — bypasses disambiguation"),
    min_score: float = Query(0.20, ge=0.0, le=1.0),
    max_hops:  int   = Query(3,    ge=1,   le=3),
):
    """
    THE MAIN ENDPOINT — Hybrid LangChain vector search + NetworkX graph traversal.

    1. LangChain/Chroma resolves query → system ID (OpenAI embeddings)
    2. NetworkX BFS traverses outbound data flows up to max_hops
    3. Impact engine scores each affected system by criticality × proximity
    4. Returns ranked report with plain-English reasons
    """
    # ── Direct entity_id bypass (user picked from disambiguation list) ──────────
    if entity_id:
        report = analyse(entity_id, _graph, min_score=min_score, max_hops=max_hops)
        return {
            "resolution": "RESOLVED",
            "search":     {"tier": "HIGH", "message": "Resolved via direct selection", "resolved": {"entity_id": entity_id}},
            "impact":     to_dict(report),
        }

    if not q:
        raise HTTPException(400, "Either 'q' or 'entity_id' must be provided")

    r = _vsearch.search_systems_only(q)   # no model arg

    if r.tier != "HIGH" or not r.resolved:
        return {
            "resolution": "AMBIGUOUS",
            "message":    r.message,
            "candidates": [vars(c) for c in r.candidates],
            "impact":     None,
        }

    report = analyse(r.resolved.entity_id, _graph,
                     min_score=min_score, max_hops=max_hops)
    return {
        "resolution": "RESOLVED",
        "search":     {"tier":r.tier, "message":r.message, "resolved":vars(r.resolved)},
        "impact":     to_dict(report),
    }


@app.get("/api/flows")
def get_flows_subgraph(
    q:       str = Query(..., description="Describe the flows you're looking for"),
    top_k:   int = Query(6, ge=1, le=14, description="Max number of matching flows to include"),
    min_score: float = Query(0.60, ge=0.0, le=1.0, description="Minimum similarity score"),
):
    """
    FLOW SEARCH — 'What are all the payment-related flows and what do they touch?'

    Step 1: Vector search restricted to entity_type=flow
            Returns the top-k semantically similar flows to the query.
            Only flows above min_score threshold are included.

    Step 2: Multi-flow subgraph
            Takes all matched flow IDs together, finds every system
            those flows touch, and returns a unified graph.
            Also includes context edges — other flows between the
            same systems — so the graph is complete.

    The response includes:
      - matched_flows: the flows that matched your query, with scores
      - subgraph: nodes + edges for D3 rendering
        - edges have a 'highlighted' flag: true = matched your query
                                           false = context edge
      - summary: counts of matched flows, systems touched, context edges

    Example queries:
      'payment flows'          → FLOW_003,004,005,006,010
      'SWIFT messages'         → FLOW_003, FLOW_013
      'settlement instructions'→ FLOW_002, FLOW_006
      'compliance screening'   → FLOW_004, FLOW_014
      'risk positions'         → FLOW_007, FLOW_008
    """
    # Step 1: vector search — flows only
    r = _vsearch.search(q, entity_type="flow", top_k=top_k)

    # Filter to only candidates above min_score
    matched = [c for c in r.candidates if c.score >= min_score]

    if not matched:
        return {
            "resolution":    "NO_MATCH",
            "message":       f"No flows matched '{q}' above {min_score:.0%} confidence.",
            "tier":          r.tier,
            "all_candidates": [vars(c) for c in r.candidates[:5]],
            "matched_flows": [],
            "subgraph":      None,
            "summary":       None,
        }

    flow_ids = [c.entity_id for c in matched]

    # Step 2: unified multi-flow subgraph
    sg = _graph.subgraph_for_flows(flow_ids)

    return {
        "resolution": "RESOLVED",
        "query":      q,
        "matched_flows": [
            {
                "flow_id":    c.entity_id,
                "name":       c.name,
                "score":      c.score,
                "confidence": "HIGH" if c.score >= 0.82 else "MEDIUM",
            }
            for c in matched
        ],
        "subgraph": {
            "label":               sg["label"],
            "nodes":               [_sys(n).dict() for n in sg["nodes"]],
            "edges":               [
                {**_flow(e).dict(), "highlighted": e.get("highlighted", False)}
                for e in sg["edges"]
            ],
        },
        "summary": {
            "matched_flow_count":  sg.get("matched_flow_count", len(flow_ids)),
            "context_edge_count":  sg.get("context_edge_count", 0),
            "systems_touched":     len(sg["nodes"]),
            "total_edges_in_view": len(sg["edges"]),
        },
    }


@app.get("/api/inspector/flows")
def inspector_flow_search(
    q:       str = Query(..., description="Business process or flow description to search"),
    node_id: str = Query(..., description="System node ID to scope results to"),
    top_k:   int = Query(50, ge=1, le=50),
):
    """
    Pure semantic flow search scoped to a node's direct connections.

    Embeds the query, runs vector similarity across all flows in ChromaDB,
    then keeps only the flows that belong to this node's 1-hop neighbourhood.
    Results are returned ranked by similarity score (highest first) with no
    hard cutoff — the UI shows the % confidence so the user can judge.

    Works well for:
      - Business process names  ("Cross Border Payment", "Trade Settlement")
      - Flow descriptions       ("FX confirmation", "derivatives lifecycle")
      - Protocol / criticality  ("SWIFT", "Critical")
    """
    # 1. Get all flow IDs that belong to this node
    node_sg      = _graph.subgraph_for_system(node_id)
    node_flow_ids = {e["id"] for e in node_sg.get("edges", []) if e.get("id")}
    if not node_flow_ids:
        return {"results": []}

    # 2. Semantic similarity search across ALL flows in the vector store
    r = _vsearch.search(q, entity_type="flow", top_k=top_k)

    # 3. Keep only flows that belong to this node, preserve ranking order
    # Clamp scores to [0, 1] — ChromaDB L2→relevance can produce negative values
    # for dissimilar embeddings; negative % labels are confusing in the UI.
    results = [
        {"flow_id": c.entity_id, "score": max(0.0, round(c.score, 3))}
        for c in r.candidates          # already sorted best-first by ChromaDB
        if c.entity_id in node_flow_ids
    ]
    return {"results": results}


@app.get("/api/dependencies")
def get_dependencies(
    q:           Optional[str] = Query(None, description="System or business process name"),
    entity_id:   Optional[str] = Query(None, description="Direct entity ID — bypasses disambiguation"),
    entity_type: Optional[str] = Query(None, description="Entity type: system or business_process"),
    max_hops: int = Query(3, ge=1, le=3),
):
    """
    FULL DEPENDENCY MAP — both upstream and downstream, from any starting point.

    Resolves the query to a system OR a business process, then returns:

    If resolved to a SYSTEM:
      upstream   — everything X ultimately depends on (recursive inbound BFS)
      downstream — everything X sends data to (recursive outbound BFS)
      core       — just [the system itself]

    If resolved to a BUSINESS PROCESS:
      core       — the systems explicitly named in that process
      upstream   — what feeds INTO those systems (the process's input dependencies)
      downstream — what those systems send data OUT TO (the process's output effects)

    Use this to answer:
      "What does the Cross-Border Payment process touch end-to-end?"
      "What does Payments Hub depend on, and what does it affect?"

    The response includes a nodes+edges subgraph for D3 rendering,
    plus structured upstream/downstream dicts with hop distances.
    """
    # ── Direct entity_id bypass (user picked from disambiguation list) ──────────
    if entity_id and entity_type:
        resolved_id    = entity_id
        resolved_type  = entity_type
        resolved_name  = entity_id   # will be overwritten below if found in graph
        resolved_score = 1.0

        if entity_type == "system":
            sys_info      = _graph.get_system(entity_id) or {}
            resolved_name = sys_info.get("name", entity_id)
            upstream      = _graph.upstream_bfs(entity_id, max_hops=max_hops)
            downstream    = _graph.downstream_bfs(entity_id, max_hops=max_hops)
            all_ids = set(upstream) | set(downstream) | {entity_id}
            sub     = _graph._G.subgraph(all_ids)
            nodes   = [_sys({"id": n, **dict(a)}) for n, a in sub.nodes(data=True)]
            edges   = [_flow({"source_app": s, "sinc_app": t, **d}) for s, t, d in sub.edges(data=True)]
            sys_res = {
                "resolution": "RESOLVED",
                "resolved_type": "system",
                "resolved_name": resolved_name,
                "score": resolved_score,
                "footprint": {
                    "label": resolved_name + " — full dependency map",
                    "regulatory": None,
                    "core": [{"id": entity_id, "name": resolved_name,
                              "domain": sys_info.get("domain", ""), "role": "origin"}],
                    "upstream": upstream,
                    "downstream": downstream,
                    "summary": {
                        "upstream_count": len(upstream),
                        "downstream_count": len(downstream),
                        "total_footprint": len(all_ids),
                    },
                    "nodes": [n.dict() for n in nodes],
                    "edges": [e.dict() for e in edges],
                },
            }
            return sys_res

        if entity_type == "business_process":
            fp = _graph.process_footprint(entity_id, max_hops=max_hops)
            if not fp["found"]:
                raise HTTPException(404, f"Business process '{entity_id}' not found in graph")
            resolved_name = fp.get("label", entity_id)
            nodes = [_sys(n) for n in fp["nodes"]]
            edges = [_flow(e) for e in fp["edges"]]
            bp_res = {
                "resolution":    "RESOLVED",
                "resolved_type": "business_process",
                "resolved_name": resolved_name,
                "score":         resolved_score,
                "footprint": {
                    "label":      fp["label"] + " — full dependency map",
                    "regulatory": fp.get("regulatory"),
                    "core":       fp["core"],
                    "upstream":   fp["upstream"],
                    "downstream": fp["downstream"],
                    "summary": {
                        "core_count":       len(fp["core"]),
                        "upstream_count":   len(fp["upstream"]),
                        "downstream_count": len(fp["downstream"]),
                        "total_footprint":  len(fp["upstream"]) + len(fp["downstream"]) + len(fp["core"]),
                    },
                    "nodes": [n.dict() for n in nodes],
                    "edges": [e.dict() for e in edges],
                },
            }
            return bp_res

        raise HTTPException(400, f"Unknown entity_type: {entity_type}")

    if not q:
        raise HTTPException(400, "Either 'q' or 'entity_id'+'entity_type' must be provided")

    # Try system first, then business process
    r_sys = _vsearch.search(q, entity_type="system", top_k=1)
    r_bp  = _vsearch.search(q, entity_type="business_process", top_k=1)

    # Pick whichever resolved with higher confidence
    resolved_type  = None
    resolved_id    = None
    resolved_name  = None
    resolved_score = 0.0

    if r_sys.resolved and r_sys.resolved.score > resolved_score:
        resolved_type  = "system"
        resolved_id    = r_sys.resolved.entity_id
        resolved_name  = r_sys.resolved.name
        resolved_score = r_sys.resolved.score

    if r_bp.resolved and r_bp.resolved.score > resolved_score:
        resolved_type  = "business_process"
        resolved_id    = r_bp.resolved.entity_id
        resolved_name  = r_bp.resolved.name
        resolved_score = r_bp.resolved.score

    if not resolved_id or resolved_score < 0.65:
        # Neither resolved confidently — return candidates from both
        all_candidates = (r_sys.candidates or []) + (r_bp.candidates or [])
        all_candidates.sort(key=lambda c: -c.score)
        return {
            "resolution": "AMBIGUOUS",
            "message":    f"Could not confidently resolve '{q}'. Pick from candidates.",
            "candidates": [vars(c) for c in all_candidates[:8]],
            "footprint":  None,
        }

    # ── System resolved ───────────────────────────────────────────────────────
    if resolved_type == "system":
        sys_info   = _graph.get_system(resolved_id) or {}
        upstream   = _graph.upstream_bfs(resolved_id, max_hops=max_hops)
        downstream = _graph.downstream_bfs(resolved_id, max_hops=max_hops)

        # Build subgraph of all involved nodes for rendering
        all_ids = set(upstream) | set(downstream) | {resolved_id}
        sub     = _graph._G.subgraph(all_ids)
        nodes   = [_sys({"id": n, **dict(a)}) for n, a in sub.nodes(data=True)]
        edges   = [_flow({"source_app": s, "sinc_app": t, **d})
                   for s, t, d in sub.edges(data=True)]

        sys_res = {
            "resolution": "RESOLVED",
            "resolved_type": "system",
            "resolved_name": resolved_name,
            "score": resolved_score,
            "footprint": {
                "label": resolved_name + " — full dependency map",
                "regulatory": None,
                "core": [{"id": resolved_id,
                          "name": sys_info.get("name", resolved_id),
                          "domain": sys_info.get("domain", ""),
                          "role": "origin"}],
                "upstream": upstream,
                "downstream": downstream,
                "summary": {
                    "upstream_count": len(upstream),
                    "downstream_count": len(downstream),
                    "total_footprint": len(all_ids),
                },
                "nodes": [n.dict() for n in nodes],
                "edges": [e.dict() for e in edges],
            },
        }
        return sys_res

    # ── Business process resolved ─────────────────────────────────────────────
    fp = _graph.process_footprint(resolved_id, max_hops=max_hops)
    if not fp["found"]:
        raise HTTPException(404, f"Business process '{resolved_id}' not found in graph")

    nodes = [_sys(n) for n in fp["nodes"]]
    edges = [_flow(e) for e in fp["edges"]]

    return {
        "resolution":    "RESOLVED",
        "resolved_type": "business_process",
        "resolved_name": resolved_name,
        "score":         resolved_score,
        "footprint": {
            "label":      fp["label"] + " — full dependency map",
            "regulatory": fp.get("regulatory"),
            "core":       fp["core"],
            "upstream":   fp["upstream"],
            "downstream": fp["downstream"],
            "summary": {
                "core_count":       len(fp["core"]),
                "upstream_count":   len(fp["upstream"]),
                "downstream_count": len(fp["downstream"]),
                "total_footprint":  len(fp["nodes"]),
            },
            "nodes": [n.dict() for n in nodes],
            "edges": [e.dict() for e in edges],
        },
    }


@app.get("/api/systems", response_model=list[SystemOut])
def list_systems():
    return [_sys(s) for s in _graph.all_systems()]

@app.get("/api/systems/{sid}", response_model=SystemOut)
def get_system(sid: str):
    s = _graph.get_system(sid)
    if not s:
        raise HTTPException(404, f"System '{sid}' not found")
    return _sys(s)


# ── Static SPA serving (production only) ─────────────────────────────────────
# When STATIC_DIR is set (Docker/cloud), serve Angular build and fall back to
# index.html for all non-API paths so Angular routing works correctly.
_static_dir = os.environ.get("STATIC_DIR", "")
if _static_dir and os.path.isdir(_static_dir):
    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        file_path = os.path.join(_static_dir, full_path)
        if full_path and os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(_static_dir, "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
