"""
Aria cross-project memory service — a thin FastAPI wrapper around mem0.

This is the "mem0" half of Aria's memory system (the cross-project / user-wide
layer; the per-project half is the local LLM wiki in the extension). It runs on
the shared server (gemma4) so no per-user machine needs Postgres or an embedding
model — Aria clients just call this HTTP API with the user's user_id.

Everything is mem0's standard implementation; only the models are swapped to
local ones:
  - embedder     -> embeddinggemma via Ollama's OpenAI-compatible endpoint
  - llm          -> a local Ollama chat model (for mem0's fact extraction)
  - vector_store -> pgvector (table `aria_user_memory`, separate from aria_logic)

Per-user isolation is by `user_id` (mem0's native multi-tenancy): every add/
search is scoped to one user_id, exactly like mem0's own implementation. The
caller (Aria, after ORCID/Google login) is responsible for passing the correct
user_id — mem0 itself has no auth. For testing before login exists, pass a
fixed id like "test-user".

Config is entirely env-driven (see .env.example); defaults target the local
gemma4 setup.
"""

import os

os.environ.setdefault("MEM0_TELEMETRY", "False")  # no phone-home; keep it local

from fastapi import FastAPI
from pydantic import BaseModel
from mem0 import Memory

# ---------------------------------------------------------------------------
# mem0 configuration — mem0-standard, only the model/store backends swapped.
# ---------------------------------------------------------------------------

EMBED_DIMS = int(os.environ.get("EMBED_DIMS", "768"))  # embeddinggemma-300m

MEM0_CONFIG = {
    "vector_store": {
        "provider": "pgvector",
        "config": {
            "dbname": os.environ.get("PG_DB", "aria_memory"),
            "user": os.environ.get("PG_USER", "aria"),
            "password": os.environ["PG_PASSWORD"],  # required; supply via env / .env (never commit)
            "host": os.environ.get("PG_HOST", "localhost"),
            "port": int(os.environ.get("PG_PORT", "5434")),
            "collection_name": os.environ.get("PG_COLLECTION", "aria_user_memory"),
            "embedding_model_dims": EMBED_DIMS,
            "hnsw": True,  # HNSW index for cosine similarity search
        },
    },
    "embedder": {
        "provider": "openai",  # OpenAI-compatible client, pointed at Ollama
        "config": {
            "model": os.environ.get(
                "EMBED_MODEL", "hf.co/unsloth/embeddinggemma-300m-GGUF:BF16"
            ),
            "openai_base_url": os.environ.get(
                "EMBED_BASE_URL", "http://localhost:11434/v1"
            ),
            "api_key": os.environ.get("EMBED_API_KEY", "ollama"),  # ignored by Ollama
            "embedding_dims": EMBED_DIMS,
        },
    },
    "llm": {
        # mem0 uses the LLM to EXTRACT salient facts from the conversation and to
        # reconcile them (ADD/UPDATE/DELETE) against existing memories. Kept local
        # here so testing needs no external keys. Later this can be switched to
        # the user's chosen provider (Claude / Codex) per request — see NOTE below.
        "provider": "openai",
        "config": {
            "model": os.environ.get("LLM_MODEL", "llama3.1:8b"),
            "openai_base_url": os.environ.get("LLM_BASE_URL", "http://localhost:11434/v1"),
            "api_key": os.environ.get("LLM_API_KEY", "ollama"),
            "temperature": 0.1,
        },
    },
}

memory = Memory.from_config(MEM0_CONFIG)

app = FastAPI(title="Aria Memory (mem0)")


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

class AddRequest(BaseModel):
    # mem0 accepts either a plain string or a list of {role, content} messages.
    messages: object
    user_id: str
    metadata: dict | None = None
    # infer=True (default) runs mem0's LLM fact-extraction pipeline (the standard
    # behaviour). infer=False stores the text verbatim (embed + pgvector only) —
    # handy for smoke-testing the store/search path without the LLM.
    infer: bool = True
    # Reserved for later: the user's active provider ("claude" | "codex"), so the
    # server can route extraction to a matching LLM. Ignored for now.
    provider: str | None = None


class SearchRequest(BaseModel):
    query: str
    user_id: str
    limit: int = 5


@app.get("/health")
def health():
    return {"ok": True, "embedding_dims": EMBED_DIMS}


@app.post("/add")
def add(req: AddRequest):
    # NOTE (per-provider extraction, future): to make mem0's extraction LLM match
    # the user's provider, build one Memory per provider (cache them) and select
    # by req.provider here. Requires the server to hold that provider's key.
    return memory.add(
        req.messages,
        user_id=req.user_id,
        metadata=req.metadata,
        infer=req.infer,
    )


@app.post("/search")
def search(req: SearchRequest):
    # mem0's newer API requires entity scope via `filters`, not a top-level kwarg.
    return memory.search(req.query, filters={"user_id": req.user_id}, limit=req.limit)


@app.get("/memories")
def get_all(user_id: str):
    return memory.get_all(filters={"user_id": user_id})


class DeleteRequest(BaseModel):
    memory_id: str


@app.post("/delete")
def delete(req: DeleteRequest):
    memory.delete(memory_id=req.memory_id)
    return {"deleted": req.memory_id}
