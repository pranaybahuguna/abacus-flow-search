"""
graph_store.py — File-based graph database
==========================================
Library : networkx  (pip install networkx)
Storage : data/graph.pkl  (Python pickle, auto-built on first run)

No server. No Docker. Just a file on disk.

GRAPH SCHEMA
  Nodes  → one per System       (all JSON fields as node attributes)
  Edges  → one per Flow         (all JSON fields as edge attributes)
  Graph  → bp_index stored here (business process lookup dict)

  MultiDiGraph is used because two systems can share more than one
  data flow (e.g. Payments Hub → DataWarehouse sends payment data
  AND compliance alerts via separate flows).

USAGE
  # Build once after changing enterprise_data.json:
  python graph_store.py

  # In code:
  from graph_store import GraphStore
  g = GraphStore()
  result = g.downstream_bfs("SYS_004", max_hops=3)
"""
from __future__ import annotations
import json, math, pickle
from collections import deque, defaultdict
from pathlib     import Path
import networkx as nx

DATA_PATH  = Path("data/enterprise_data.json")
GRAPH_PATH = Path("data/graph.pkl")


# ─────────────────────────────────────────────────────────────────────────────
#  LAYOUT  (pre-computed once at build time; used by the full-graph endpoint)
# ─────────────────────────────────────────────────────────────────────────────

def _compute_layout(G: nx.MultiDiGraph,
                    W: float = 10_000, H: float = 7_000) -> dict[str, tuple[float, float]]:
    """
    Domain-based phyllotaxis layout — runs once during build_graph().

    Strategy
    --------
    1. Group all systems by domain.
    2. Arrange domain clusters in a rectangular grid inside a W×H canvas.
    3. Within each cluster place nodes using the golden-angle (phyllotaxis)
       spiral, which distributes points uniformly inside a disc with no
       empty rings or overcrowded centres.

    Result: every node gets a deterministic (x, y) that clusters systems
    by business domain while spacing clusters far enough apart to avoid
    edge crossings at the inter-domain level.  The frontend can render
    4-5 k nodes at a glance (dots at low zoom → full cards when zoomed in)
    without ever running a force simulation.
    """
    GOLDEN = 2.39996323          # golden angle ≈ 137.508° in radians

    domain_nodes: dict[str, list[str]] = defaultdict(list)
    for nid, attrs in G.nodes(data=True):
        domain_nodes[attrs.get("domain", "DEFAULT")].append(nid)

    domains = sorted(domain_nodes.keys())
    nd      = len(domains)
    cols    = math.ceil(math.sqrt(nd * 1.4))   # slightly wider than square
    rows    = math.ceil(nd / cols)
    cw, ch  = W / cols, H / rows               # cell size per domain cluster

    positions: dict[str, tuple[float, float]] = {}

    for di, domain in enumerate(domains):
        nodes  = domain_nodes[domain]
        n      = len(nodes)
        cx     = (di % cols + 0.5) * cw
        cy     = (di // cols + 0.5) * ch

        if n == 1:
            positions[nodes[0]] = (cx, cy)
            continue

        # Phyllotaxis: radius grows as sqrt(i) so area density stays constant
        max_r   = min(cw, ch) * 0.42
        spacing = (max_r / math.sqrt(n)) * 1.8
        for i, nid in enumerate(nodes):
            r     = spacing * math.sqrt(i + 0.5)
            theta = GOLDEN * i
            positions[nid] = (cx + r * math.cos(theta),
                              cy + r * math.sin(theta))

    return positions


# ─────────────────────────────────────────────────────────────────────────────
#  BUILD
# ─────────────────────────────────────────────────────────────────────────────

def build_graph() -> nx.MultiDiGraph:
    """Read JSON, build NetworkX graph, save to disk."""
    with open(DATA_PATH) as f:
        raw = json.load(f)

    G = nx.MultiDiGraph()

    # Systems → nodes
    for s in raw["systems"]:
        attrs = {k: v for k, v in s.items() if k != "embed_text"}
        attrs["business_processes"] = set()
        G.add_node(s["main_id"], **attrs)

    # Business processes → annotate nodes + store index on graph
    bp_index: dict[str, dict] = {}
    for bp in raw["business_processes"]:
        bp_index[bp["id"]] = bp
        for sid in bp["systems_involved"]:
            if G.has_node(sid):
                G.nodes[sid]["business_processes"].add(bp["id"])
    G.graph["bp_index"] = bp_index

    # Flows → directed edges

    for flow in raw["flows"]:
        attrs = {k: v for k, v in flow.items()
                 if k not in ("source_app", "sinc_app", "embed_text")}
        G.add_edge(flow["source_app"], flow["sinc_app"], **attrs)

    # Pre-compute full-graph layout (domain phyllotaxis) — used by /api/graph/full
    # so the browser never has to run a force simulation on thousands of nodes.
    G.graph["layout"] = _compute_layout(G)

    GRAPH_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(GRAPH_PATH, "wb") as f:
        pickle.dump(G, f, protocol=pickle.HIGHEST_PROTOCOL)

    print(f"✅  Graph built: {G.number_of_nodes()} nodes, "
          f"{G.number_of_edges()} edges → {GRAPH_PATH}")
    return G


# ─────────────────────────────────────────────────────────────────────────────
#  GraphStore
# ─────────────────────────────────────────────────────────────────────────────

class GraphStore:
    """Loads graph.pkl and exposes graph query methods.
    All return plain Python dicts — no networkx objects leak out."""

    def __init__(self):
        if not GRAPH_PATH.exists():
            print("graph.pkl missing — building now…")
            self._G = build_graph()
        else:
            with open(GRAPH_PATH, "rb") as f:
                self._G = pickle.load(f)
            print(f"✅  Graph loaded: {self._G.number_of_nodes()} nodes, "
                  f"{self._G.number_of_edges()} edges")

    # ── Basic lookups ─────────────────────────────────────────────────────────

    def get_system(self, sid: str) -> dict | None:
        if not self._G.has_node(sid):
            return None
        return dict(self._G.nodes[sid])

    def all_systems(self) -> list[dict]:
        return [{"id": n, **dict(a)} for n, a in self._G.nodes(data=True)]

    def all_flows(self) -> list[dict]:
        return [{"source": s, "target": t, **d}
                for s, t, d in self._G.edges(data=True)]

    # ── Subgraph queries (for D3 graph rendering) ─────────────────────────────

    def subgraph_for_system(self, sid: str) -> dict:
        """1-hop neighbourhood: everything directly connected to sid."""
        if not self._G.has_node(sid):
            return _empty("System not found")
        neighbours = (set(self._G.successors(sid))
                    | set(self._G.predecessors(sid))
                    | {sid})
        label = self._G.nodes[sid].get("name", sid) + " — all connections"
        return _export(self._G.subgraph(neighbours), label)

    def subgraph_for_process(self, bp_id: str) -> dict:
        """Systems and flows that belong to a specific business process."""
        bp = self._G.graph.get("bp_index", {}).get(bp_id)
        if not bp:
            return _empty("Business process not found")
        sys_ids  = set(bp["systems_involved"])
        flow_ids = set(bp["flows_involved"])
        sub      = self._G.subgraph(sys_ids)
        nodes    = [{"id": n, **dict(a)} for n, a in sub.nodes(data=True)]
        edges    = [{"source_app": s, "sinc_app": t, **d}
                    for s, t, d in sub.edges(data=True)
                    if d.get("id") in flow_ids]
        return {"label": bp["name"],
                "regulatory": bp.get("regulatory_relevance"),
                "nodes": nodes, "edges": edges}

    def subgraph_for_flow(self, flow_id: str) -> dict:
        """Just the two endpoints of a single named flow."""
        for s, t, d in self._G.edges(data=True):
            if d.get("id") == flow_id:
                nodes = [
                    {"id": s, **dict(self._G.nodes[s])},
                    {"id": t, **dict(self._G.nodes[t])},
                ]
                edges = [{"source_app": s, "sinc_app": t, **d}]
                bp = d.get("business_process", [])
                label = bp[0] if isinstance(bp, list) and bp else (bp or flow_id)
                return {
                    "label": label,
                    "regulatory": None,
                    "nodes": nodes,
                    "edges": edges,
                }
        return _empty("Flow not found")

    def subgraph_for_flows(self, flow_ids: list[str]) -> dict:
        """
        Unified subgraph for MULTIPLE flows — used when a search query
        returns several semantically related flows (e.g. 'payment flows').

        Returns:
          - All systems touched by any of the flows (nodes)
          - ALL edges between those systems, not just the queried flows
            (so the graph is contextually complete)
          - highlighted_flows: set of the queried flow IDs, so the UI
            can visually distinguish the matched flows from context edges
          - label built from the common theme across matched flows
        """
        matched_edges = []
        for s, t, d in self._G.edges(data=True):
            if d.get("id") in flow_ids:
                matched_edges.append((s, t, d))

        if not matched_edges:
            return _empty("No matching flows found")

        # Collect all systems touched by any matched flow
        touched = set()
        for s, t, _ in matched_edges:
            touched.add(s)
            touched.add(t)

        # Export the full subgraph across those systems
        # (includes context edges — other flows between the same systems)
        sg = _export(self._G.subgraph(touched), f"{len(flow_ids)} matching flows")

        # Tag which edges are the actual matched flows vs context
        for edge in sg["edges"]:
            edge["highlighted"] = edge.get("id") in flow_ids

        sg["highlighted_flows"] = list(flow_ids)
        sg["matched_flow_count"] = len(matched_edges)
        sg["context_edge_count"] = len(sg["edges"]) - len(matched_edges)
        return sg

    def full_graph(self) -> dict:
        """
        Returns the complete enterprise graph with pre-computed layout positions
        (layout_x, layout_y) attached to every node.  The frontend uses these
        to render all nodes immediately without running a D3 force simulation.
        """
        layout = self._G.graph.get("layout", {})
        nodes  = []
        for nid, attrs in self._G.nodes(data=True):
            d = {"id": nid, **dict(attrs)}
            if nid in layout:
                d["layout_x"], d["layout_y"] = layout[nid]
            nodes.append(d)
        edges = [{"source_app": s, "sinc_app": t, **d}
                 for s, t, d in self._G.edges(data=True)]
        return {"label": "Full Enterprise Map", "regulatory": None,
                "nodes": nodes, "edges": edges}

    # ── Impact traversal ──────────────────────────────────────────────────────

    def downstream_bfs(self, sid: str, max_hops: int = 3) -> dict[str, dict]:
        """
        BFS from sid following outbound edges up to max_hops deep.

        Returns a dict keyed by node_id:
          { "id", "name", "domain", "hops", "via_flows": [...] }

        Manual BFS (not nx.descendants) so we capture:
          - exact hop distance
          - which flows create the dependency
          - multiple via_flows when reachable by different paths
        """
        if not self._G.has_node(sid):
            return {}

        visited: dict[str, dict] = {}
        q = deque([(sid, 0)])

        while q:
            cur, hops = q.popleft()
            if hops >= max_hops:
                continue
            for _, tgt, edata in self._G.out_edges(cur, data=True):
                if tgt == sid:
                    continue
                flow = {
                    "information_entity": edata.get("information_entity", ""),
                    "criticality":      edata.get("criticality", "Low"),
                    "business_process": edata.get("business_process", []),
                    "flow_id":          edata.get("id", ""),
                }
                if tgt not in visited:
                    na = self._G.nodes[tgt]
                    visited[tgt] = {
                        "id":        tgt,
                        "name":      na.get("name", tgt),
                        "domain":    na.get("domain", ""),
                        "hops":      hops + 1,
                        "via_flows": [flow],
                    }
                    q.append((tgt, hops + 1))
                else:
                    # Add extra via_flow if not already recorded
                    seen = {(f["information_entity"], f["criticality"])
                            for f in visited[tgt]["via_flows"]}
                    if (flow["information_entity"], flow["criticality"]) not in seen:
                        visited[tgt]["via_flows"].append(flow)

        return visited

    def direct_critical_flows(self, sid: str) -> list[dict]:
        """Critical-criticality flows leaving sid — the highest-risk connections."""
        return [
            {"to_system":   self._G.nodes[tgt].get("name", tgt),
             "to_id":       tgt,
             "information_entity": d.get("information_entity", ""),
             "process":     ", ".join(d.get("business_process", [])),
             "flow_id":     d.get("id", "")}
            for _, tgt, d in self._G.out_edges(sid, data=True)
            if d.get("criticality") == "Critical"
        ]

    def affected_processes(self, sid: str, downstream_ids: set[str]) -> list[dict]:
        """Business processes that involve sid or any downstream system."""
        all_ids  = downstream_ids | {sid}
        bp_index = self._G.graph.get("bp_index", {})
        return [
            {"id": bid, "name": bp["name"],
             "regulatory": bp.get("regulatory_relevance", "")}
            for bid, bp in bp_index.items()
            if all_ids & set(bp.get("systems_involved", []))
        ]

    def upstream_of(self, sid: str) -> list[dict]:
        """Systems that send data INTO sid — one hop only."""
        return [
            {"id":          src,
             "name":        self._G.nodes[src].get("name", src),
             "domain":      self._G.nodes[src].get("domain", ""),
             "information_entity": d.get("information_entity", ""),
             "criticality": d.get("criticality", ""),
             "flow_id":     d.get("id", "")}
            for src, _, d in self._G.in_edges(sid, data=True)
        ]

    def upstream_bfs(self, sid: str, max_hops: int = 3) -> dict[str, dict]:
        """
        BFS following INBOUND edges — the mirror of downstream_bfs.

        Answers: "What does system X ultimately depend on?"
        i.e. if X went down, which upstream systems would be the root cause?

        Returns {node_id: {id, name, domain, hops, via_flows}}
        via_flows here means the flows that CREATE the dependency
        (i.e. the flow from the upstream system into the path toward sid).
        """
        if not self._G.has_node(sid):
            return {}

        visited: dict[str, dict] = {}
        q = deque([(sid, 0)])

        while q:
            cur, hops = q.popleft()
            if hops >= max_hops:
                continue
            for src, _, edata in self._G.in_edges(cur, data=True):
                if src == sid:
                    continue
                flow = {
                    "information_entity": edata.get("information_entity", ""),
                    "criticality":      edata.get("criticality", "Low"),
                    "business_process": edata.get("business_process", []),
                    "flow_id":          edata.get("id", ""),
                }
                if src not in visited:
                    na = self._G.nodes[src]
                    visited[src] = {
                        "id":        src,
                        "name":      na.get("name", src),
                        "domain":    na.get("domain", ""),
                        "hops":      hops + 1,
                        "via_flows": [flow],
                    }
                    q.append((src, hops + 1))
                else:
                    seen = {(f["information_entity"], f["criticality"])
                            for f in visited[src]["via_flows"]}
                    if (flow["information_entity"], flow["criticality"]) not in seen:
                        visited[src]["via_flows"].append(flow)

        return visited

    def process_footprint(self, bp_id: str, max_hops: int = 3) -> dict:
        """
        Full transitive dependency footprint of a business process.

        Answers: "Everything this process touches — directly and indirectly."

        Three categories are returned:
          core      — systems explicitly listed in systems_involved
          upstream  — systems that feed INTO the core (what the process depends on)
          downstream — systems the core sends data OUT TO (what the process affects)

        Each system in upstream/downstream includes hop distance and via_flows.
        The subgraph returned for rendering includes ALL edges between any
        node in the full footprint — not just the process-specific flows.
        """
        bp = self._G.graph.get("bp_index", {}).get(bp_id)
        if not bp:
            return {
                "found": False, "label": "Business process not found",
                "core": [], "upstream": {}, "downstream": {},
                "nodes": [], "edges": [],
            }

        core_ids = set(bp["systems_involved"])

        # Aggregate upstream BFS from every core system
        all_upstream: dict[str, dict] = {}
        for sid in core_ids:
            for nid, ndata in self.upstream_bfs(sid, max_hops=max_hops).items():
                if nid in core_ids:
                    continue
                if nid not in all_upstream:
                    all_upstream[nid] = ndata
                else:
                    # Keep the shorter hop distance
                    if ndata["hops"] < all_upstream[nid]["hops"]:
                        all_upstream[nid] = ndata

        # Aggregate downstream BFS from every core system
        all_downstream: dict[str, dict] = {}
        for sid in core_ids:
            for nid, ndata in self.downstream_bfs(sid, max_hops=max_hops).items():
                if nid in core_ids:
                    continue
                if nid not in all_downstream:
                    all_downstream[nid] = ndata
                else:
                    if ndata["hops"] < all_downstream[nid]["hops"]:
                        all_downstream[nid] = ndata

        # Full set of nodes for rendering
        all_ids = core_ids | set(all_upstream) | set(all_downstream)
        sub     = self._G.subgraph(all_ids)
        nodes   = [{"id": n, **dict(a)} for n, a in sub.nodes(data=True)]
        edges   = [{"source_app": s, "sinc_app": t, **d}
                   for s, t, d in sub.edges(data=True)]

        return {
            "found":      True,
            "label":      bp["name"],
            "regulatory": bp.get("regulatory_relevance"),
            "core":       [{"id": sid, **dict(self._G.nodes[sid])}
                           for sid in core_ids if self._G.has_node(sid)],
            "upstream":   all_upstream,
            "downstream": all_downstream,
            "nodes":      nodes,
            "edges":      edges,
        }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _export(sub: nx.MultiDiGraph, label: str) -> dict:
    nodes = [{"id": n, **dict(a)} for n, a in sub.nodes(data=True)]
    edges = [{"source_app": s, "sinc_app": t, **d} for s, t, d in sub.edges(data=True)]
    return {"label": label, "regulatory": None, "nodes": nodes, "edges": edges}

def _empty(label: str) -> dict:
    return {"label": label, "regulatory": None, "nodes": [], "edges": []}


if __name__ == "__main__":
    build_graph()
