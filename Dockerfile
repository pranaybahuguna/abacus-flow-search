# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Build Angular frontend
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /frontend

# Install dependencies first (layer-cached unless package.json changes)
COPY frontend/package*.json ./
RUN npm ci --quiet

# Build production bundle  →  dist/abacus-ui/browser/
COPY frontend/ ./
RUN npm run build


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Python backend + built frontend
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim

WORKDIR /app

# Install Python dependencies
COPY afs-backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source + data
COPY afs-backend/ ./backend/

# Copy Angular build output from stage 1
COPY --from=frontend-builder /frontend/dist/abacus-ui/browser ./static/

# Copy startup script
COPY startup.sh ./
RUN chmod +x startup.sh

# ChromaDB will be created here at first boot
RUN mkdir -p ./backend/chroma_db

EXPOSE 8080

# Tell api.py where the Angular files live
ENV STATIC_DIR=/app/static
ENV PORT=8080

CMD ["./startup.sh"]
