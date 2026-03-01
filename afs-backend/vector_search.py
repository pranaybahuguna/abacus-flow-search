"""
vector_search.py — Vector similarity search via LangChain + Chroma
===================================================================
Loads the Chroma vector store built by embeddings.py and answers:
"When a user types X, which entity do they most likely mean?"

LangChain's Chroma retriever does the heavy lifting:
  - similarity_search_with_relevance_scores() returns results with
    cosine similarity scores already computed
  - Filtering by entity_type is done via Chroma's metadata `where` clause
    (no post-filter loop needed)

Confidence tiers:
  HIGH   ≥ 0.82  → auto-resolve
  MEDIUM ≥ 0.65  → show disambiguation list
  LOW    < 0.65  → ask user to rephrase

Install:
    pip install langchain langchain-openai langchain-chroma chromadb openai
"""
from __future__ import annotations
from dataclasses import dataclass
from pathlib     import Path
from typing      import Optional, Literal
from dotenv      import load_dotenv
load_dotenv()

from langchain_openai  import OpenAIEmbeddings
from langchain_chroma  import Chroma

CHROMA_PATH      = Path("data/chroma_db")
HIGH_THRESHOLD   = 0.82
MEDIUM_THRESHOLD = 0.65


# ── Output data classes (same shape as before — api.py is unchanged) ──────────

@dataclass
class Candidate:
    entity_id:   str
    entity_type: str
    name:        str
    score:       float
    domain:      Optional[str] = None


@dataclass
class SearchResult:
    tier:       Literal["HIGH", "MEDIUM", "LOW"]
    message:    str
    resolved:   Optional[Candidate]
    candidates: list[Candidate]


# ── VectorSearch ──────────────────────────────────────────────────────────────

class VectorSearch:
    """
    Wraps a LangChain Chroma vectorstore.
    Loaded once at API startup, reused for every query.

    The OpenAI embedding model is initialised here (not injected)
    because LangChain's Chroma needs it at load time to embed queries.
    api.py no longer needs to load or pass around a model object.
    """

    def __init__(self):
        self._embeddings = OpenAIEmbeddings(
            model = "text-embedding-3-small",
            # OPENAI_API_KEY read from environment automatically
        )
        self._store = Chroma(
            persist_directory = str(CHROMA_PATH),
            embedding_function= self._embeddings,
            collection_name   = "abacus_entities",
        )
        count = self._store._collection.count()
        print(f"✅  VectorSearch: Chroma loaded — {count} embeddings")

    def search(
        self,
        query:       str,
        entity_type: Optional[str] = None,
        top_k:       int = 8,
    ) -> SearchResult:
        """
        Run similarity search against Chroma.

        If entity_type is given, Chroma filters at the database level
        using a metadata `where` clause — efficient, no Python looping.

        Returns SearchResult with HIGH/MEDIUM/LOW confidence tier.
        """
        # Build optional Chroma metadata filter
        where = {"entity_type": entity_type} if entity_type else None

        # similarity_search_with_relevance_scores returns:
        #   [(Document, score), ...]  sorted by score desc
        # Chroma relevance scores are already cosine similarity (0..1)
        results = self._store.similarity_search_with_relevance_scores(
            query  = query,
            k      = top_k,
            filter = where,
        )

        if not results:
            return SearchResult(
                tier       = "LOW",
                message    = f"No entities matched '{query}'.",
                resolved   = None,
                candidates = [],
            )

        candidates = [
            Candidate(
                entity_id   = doc.metadata["entity_id"],
                entity_type = doc.metadata["entity_type"],
                name        = doc.metadata["name"],
                score       = round(float(score), 4),
                domain      = doc.metadata.get("domain") or None,
            )
            for doc, score in results
        ]

        top = candidates[0]

        if top.score >= HIGH_THRESHOLD:
            return SearchResult(
                tier       = "HIGH",
                message    = f"Resolved to '{top.name}' (confidence {top.score:.0%})",
                resolved   = top,
                candidates = candidates,
            )

        if top.score >= MEDIUM_THRESHOLD:
            close = [c for c in candidates if c.score >= MEDIUM_THRESHOLD]
            names = ", ".join(f"'{c.name}'" for c in close[:3])
            return SearchResult(
                tier       = "MEDIUM",
                message    = f"Multiple matches: {names}. Which did you mean?",
                resolved   = None,
                candidates = candidates,
            )

        return SearchResult(
            tier       = "LOW",
            message    = f"Low confidence ({top.score:.0%}) for '{query}'. Try a more specific term.",
            resolved   = None,
            candidates = candidates,
        )

    def search_systems_only(self, query: str) -> SearchResult:
        """Convenience wrapper — restricts to system entities only."""
        return self.search(query, entity_type="system")
