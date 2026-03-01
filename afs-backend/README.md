# Abacus — Enterprise Graph Intelligence
Hybrid vector + graph impact analysis.  **"If I change system X, what breaks?"**

## Stack
| Layer | Technology |
|---|---|
| Embeddings | OpenAI text-embedding-3-small (via LangChain) |
| Vector DB | Chroma (file-based, `data/chroma_db/`) |
| Retrieval | LangChain Chroma retriever |
| Graph DB | NetworkX + pickle (`data/graph.pkl`) |
| REST API | FastAPI + uvicorn |
| Frontend | Angular 17 + D3 |

---

## Setup

### 1. Install
```bash
pip install fastapi uvicorn \
    langchain langchain-openai langchain-chroma chromadb openai \
    networkx
```

### 2. Set your OpenAI key
```bash
export OPENAI_API_KEY=sk-...
```

### 3. Build the graph (once — no API key needed)
```bash
cd backend
python graph_store.py
# ✅ Graph built: 10 nodes, 14 edges → data/graph.pkl
```

### 4. Build the vector store (calls OpenAI Embeddings API)
```bash
python embeddings.py
# Embeds 29 documents → data/chroma_db/
```

### 5. Start the API
```bash
uvicorn api:app --reload --port 8000
```

### 6. Start Angular
```bash
cd frontend
npm install && npm start
# → http://localhost:4200
```

---

## How the hybrid search works
```
User types: "what breaks if I change the payments router?"
                    │
              LangChain vector search
              OpenAI embeds query → Chroma similarity search
              "payments router" → Payments Hub (SYS_004)  HIGH 91%
                    │
              NetworkX BFS from SYS_004
              follows outbound data flow edges, up to 3 hops
                    │
              Impact engine scores each result
              score = criticality_weight × hop_proximity_factor
                    │
              Clean ranked report with plain-English reasons
```

## What changes if you want a different embedding model?
In `embeddings.py` and `vector_search.py`, change one line:
```python
# From:
OpenAIEmbeddings(model="text-embedding-3-small")
# To (e.g. Azure):
AzureOpenAIEmbeddings(model="text-embedding-3-large", ...)
# Or (e.g. Cohere):
CohereEmbeddings(model="embed-english-v3.0")
```
Everything else stays the same.

## API
```
GET /api/health
GET /api/search?q=payments hub
GET /api/search?q=murex&entity_type=system
GET /api/graph?entity_id=SYS_004&entity_type=system
GET /api/graph?entity_id=BP_002&entity_type=business_process
GET /api/graph/full
GET /api/impact?q=payments hub
GET /api/impact?q=murex&max_hops=2
GET /api/systems
GET /api/systems/SYS_004
```
