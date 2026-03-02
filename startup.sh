#!/bin/bash
# startup.sh — build graph/embeddings on first boot, then start the API
set -e

cd /app/backend

# ── Step 1: Build NetworkX graph (fast, ~1s) ─────────────────────────────────
if [ ! -f "graph.pkl" ]; then
    echo "🔨  Building graph store from enterprise_data.json..."
    python graph_store.py
    echo "✅  Graph built."
fi

# ── Step 2: Build ChromaDB vector embeddings (calls OpenAI, ~30-60s) ─────────
CHROMA_COUNT=$(python3 -c "
import os, sys
try:
    import chromadb
    client = chromadb.PersistentClient(path='chroma_db')
    col = client.get_collection('abacus_entities')
    print(col.count())
except Exception:
    print(0)
" 2>/dev/null || echo "0")

if [ "$CHROMA_COUNT" = "0" ]; then
    echo "🔨  Building vector embeddings (OpenAI API — may take ~30-60s)..."
    python embeddings.py
    echo "✅  Embeddings built."
else
    echo "✅  ChromaDB already indexed ($CHROMA_COUNT documents). Skipping."
fi

# ── Step 3: Start API server ──────────────────────────────────────────────────
echo "🚀  Starting Abacus Flow Search on port ${PORT:-8080}..."
exec uvicorn api:app --host 0.0.0.0 --port "${PORT:-8080}"
