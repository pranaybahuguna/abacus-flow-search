"""
embeddings.py — Build vector store with LangChain + OpenAI + Chroma
=====================================================================
Reads enterprise_data.json, embeds every entity using OpenAI's
text-embedding-3-small model via LangChain, and persists everything
into a Chroma vector database stored on disk at data/chroma_db/.

Chroma is a file-based vector database — no server, no Docker, just
a folder on disk that persists across restarts.

LangChain wraps OpenAI embeddings and Chroma so the code is clean
and swappable — want to switch to a different embedding model later?
Change one line.

Install:
    pip install langchain langchain-openai langchain-chroma chromadb openai

Set your key:
    export OPENAI_API_KEY=sk-...

Run once (or after changing enterprise_data.json):
    python embeddings.py
"""
import json, os
from pathlib import Path
from dotenv import load_dotenv
load_dotenv()

from langchain_openai          import OpenAIEmbeddings
from langchain_chroma          import Chroma
from langchain_core.documents  import Document

DATA_PATH   = Path("data/enterprise_data.json")
CHROMA_PATH = Path("data/chroma_db")

# ── Load data ──────────────────────────────────────────────────────────────────
with open(DATA_PATH) as f:
    raw = json.load(f)

snames = {s["main_id"]: s["name"] for s in raw["systems"]}

# ── Build LangChain Documents ──────────────────────────────────────────────────
# Each Document has:
#   page_content  → the rich text that gets embedded
#   metadata      → structured fields used for filtering and display
#
# Metadata is what vector_search.py reads back after retrieval.
# It must contain everything needed to render a search result:
#   entity_id, entity_type, name, domain (for systems)

documents: list[Document] = []

# Systems
for s in raw["systems"]:
    text = s.get("embed_text") or (
        f"{s['name']} is a {s['domain']} system. {s.get('description', '')} "
        f"Tags: {', '.join(s.get('tags', []))}"
    )
    documents.append(Document(
        page_content = text,
        metadata     = {
            "entity_id":   s["main_id"],
            "entity_type": "system",
            "name":        s["name"],
            "domain":      s["domain"],
        },
    ))

# Flows — embed_text includes source/target names so fuzzy queries work
for f in raw["flows"]:
    src, tgt = snames.get(f["source_app"], ""), snames.get(f["sinc_app"], "")
    text = f.get("embed_text") or (
        f"Data flow from {src} to {tgt}. "
        f"Sends {f['information_entity']} as part of {f['business_process']}. "
        f"Protocol {f['transport_protocol']}. Criticality {f['criticality']}."
    )
    documents.append(Document(
        page_content = text,
        metadata     = {
            "entity_id":   f["id"],
            "entity_type": "flow",
            "name":        f"{src} → {tgt}",
            "domain":      "",           # flows don't have a domain
        },
    ))

# Business processes
# Explicitly anchor "business process" in the embed text so queries like
# "payments business process" or "FX trade lifecycle process" score high.
# Also include human-readable system names so the embedding picks up
# domain context (e.g. "payments" from Payments Hub, "risk" from RiskEngine).
for bp in raw["business_processes"]:
    sys_names = ", ".join(
        snames.get(sid, sid) for sid in bp.get("systems_involved", [])
    )
    text = (
        f"{bp['name']} is an enterprise business process. "
        f"{bp.get('description', '')} "
        f"This business process spans the following systems: {sys_names}. "
        f"Regulatory requirements for this business process: "
        f"{bp.get('regulatory_relevance', '')}."
    )
    documents.append(Document(
        page_content = text,
        metadata     = {
            "entity_id":   bp["id"],
            "entity_type": "business_process",
            "name":        bp["name"],
            "domain":      "",
        },
    ))

# ── Embed and persist into Chroma ──────────────────────────────────────────────
print(f"Embedding {len(documents)} documents with OpenAI text-embedding-3-large…")

embeddings = OpenAIEmbeddings(
    model      = "text-embedding-3-large",
    dimensions = 1024,   # Matryoshka truncation — best quality/cost balance
    # api_key is read from OPENAI_API_KEY env var automatically
)

# Chroma.from_documents() embeds everything and persists to disk in one call.
# If the directory already exists it will be overwritten.
CHROMA_PATH.parent.mkdir(parents=True, exist_ok=True)

vectorstore = Chroma.from_documents(
    documents        = documents,
    embedding        = embeddings,
    persist_directory= str(CHROMA_PATH),
    collection_name  = "abacus_entities",
)

print(f"✅  {len(documents)} documents embedded and saved → {CHROMA_PATH}/")
print(f"    Systems:   {sum(1 for d in documents if d.metadata['entity_type']=='system')}")
print(f"    Flows:     {sum(1 for d in documents if d.metadata['entity_type']=='flow')}")
print(f"    Processes: {sum(1 for d in documents if d.metadata['entity_type']=='business_process')}")
