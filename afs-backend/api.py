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

from dotenv import load_dotenv
load_dotenv()  # loads OPENAI_API_KEY (and any other vars) from backend/.env

from fastapi             import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic            import BaseModel

from graph_store   import GraphStore
from vector_search import VectorSearch     # self-contained — no model arg needed
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
    id:str; name:str; domain:str; purpose:str; owner:str; tags:list[str]

class FlowOut(BaseModel):
    id:str; source:str; target:str; data_entity:str
    business_process:str; protocol:str; criticality:str; frequency:str

class SubgraphOut(BaseModel):
    label:str; regulatory:Optional[str]=None
    nodes:list[SystemOut]; edges:list[FlowOut]

# ── Helpers ───────────────────────────────────────────────────────────────────

def _sys(n: dict) -> SystemOut:
    return SystemOut(id=n["id"], name=n.get("name",""),
                     domain=n.get("domain",""), purpose=n.get("purpose",""),
                     owner=n.get("owner",""), tags=n.get("tags",[]))

def _flow(e: dict) -> FlowOut:
    return FlowOut(id=e.get("id",""), source=e.get("source",""),
                   target=e.get("target",""), data_entity=e.get("data_entity",""),
                   business_process=e.get("business_process",""),
                   protocol=e.get("protocol",""), criticality=e.get("criticality",""),
                   frequency=e.get("frequency",""))

def _subgraph_out(sg: dict) -> SubgraphOut:
    return SubgraphOut(label=sg["label"], regulatory=sg.get("regulatory"),
                       nodes=[_sys(n) for n in sg["nodes"]],
                       edges=[_flow(e) for e in sg["edges"]])

def _candidate_out(c) -> CandidateOut:
    return CandidateOut(entity_id=c.entity_id, entity_type=c.entity_type,
                        name=c.name, score=c.score, domain=c.domain)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="Abacus API", version="3.0.0")
app.add_middleware(CORSMiddleware,
                   allow_origins=["http://localhost:4200"],
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
    q:           str                  = Query(..., min_length=1),
    entity_type: Optional[EntityType] = Query(None),
):
    """
    STEP 1 — LangChain vector search via Chroma + OpenAI embeddings.
    Returns candidates with confidence tier (HIGH/MEDIUM/LOW).
    Angular auto-triggers /api/graph if tier == HIGH.
    """
    r = _vsearch.search(q, entity_type=entity_type)   # no model arg
    return SearchOut(
        tier       = r.tier,
        message    = r.message,
        resolved   = _candidate_out(r.resolved) if r.resolved else None,
        candidates = [_candidate_out(c) for c in r.candidates],
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
    return _subgraph_out(_graph.full_graph())


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
    results = [
        {"flow_id": c.entity_id, "score": round(c.score, 3)}
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
            edges   = [_flow({"source": s, "target": t, **d}) for s, t, d in sub.edges(data=True)]
            return {
                "resolution":    "RESOLVED",
                "resolved_type": "system",
                "resolved_name": resolved_name,
                "score":         resolved_score,
                "footprint": {
                    "label":      resolved_name + " — full dependency map",
                    "regulatory": None,
                    "core": [{"id": entity_id, "name": resolved_name,
                              "domain": sys_info.get("domain", ""), "role": "origin"}],
                    "upstream":   upstream,
                    "downstream": downstream,
                    "summary": {
                        "upstream_count":   len(upstream),
                        "downstream_count": len(downstream),
                        "total_footprint":  len(all_ids),
                    },
                    "nodes": [n.dict() for n in nodes],
                    "edges": [e.dict() for e in edges],
                },
            }

        if entity_type == "business_process":
            fp = _graph.process_footprint(entity_id, max_hops=max_hops)
            if not fp["found"]:
                raise HTTPException(404, f"Business process '{entity_id}' not found in graph")
            resolved_name = fp.get("label", entity_id)
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
                        "total_footprint":  len(fp["upstream"]) + len(fp["downstream"]) + len(fp["core"]),
                    },
                    "nodes": [n.dict() for n in nodes],
                    "edges": [e.dict() for e in edges],
                },
            }

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
        edges   = [_flow({"source": s, "target": t, **d})
                   for s, t, d in sub.edges(data=True)]

        return {
            "resolution":    "RESOLVED",
            "resolved_type": "system",
            "resolved_name": resolved_name,
            "score":         resolved_score,
            "footprint": {
                "label":      resolved_name + " — full dependency map",
                "regulatory": None,
                "core": [{"id": resolved_id,
                          "name": sys_info.get("name", resolved_id),
                          "domain": sys_info.get("domain", ""),
                          "role": "origin"}],
                "upstream":   upstream,
                "downstream": downstream,
                "summary": {
                    "upstream_count":   len(upstream),
                    "downstream_count": len(downstream),
                    "total_footprint":  len(all_ids),
                },
                "nodes": [n.dict() for n in nodes],
                "edges": [e.dict() for e in edges],
            },
        }

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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
