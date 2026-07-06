"""
Smoke test for the Aria cross-project memory store (mem0 + embeddinggemma + pgvector).

Run on gemma4 (where pgvector :5434 and Ollama :11434 are up):

    python3 -m venv ~/aria-mem-venv && source ~/aria-mem-venv/bin/activate
    pip install mem0ai psycopg2-binary
    PG_PASSWORD=<your-postgres-password> python test_mem0.py

Start with the store-only path (no LLM) to prove embedding + pgvector work, then
flip INFER=True (needs `ollama pull llama3.1:8b`) to exercise mem0's real
fact-extraction pipeline.
"""

import os

os.environ.setdefault("MEM0_TELEMETRY", "False")  # no phone-home; keep it local

from mem0 import Memory

EMBED_DIMS = 768
USER = "test-user"          # any fixed string until login exists
INFER = os.environ.get("INFER", "false").lower() == "true"

CONFIG = {
    "vector_store": {
        "provider": "pgvector",
        "config": {
            "dbname": os.environ.get("PG_DB", "aria_memory"),
            "user": os.environ.get("PG_USER", "aria"),
            "password": os.environ["PG_PASSWORD"],  # required; supply via env (never commit)
            "host": os.environ.get("PG_HOST", "localhost"),
            "port": int(os.environ.get("PG_PORT", "5434")),
            "collection_name": "aria_user_memory",
            "embedding_model_dims": EMBED_DIMS,
            "hnsw": True,
        },
    },
    "embedder": {
        "provider": "openai",
        "config": {
            "model": "hf.co/unsloth/embeddinggemma-300m-GGUF:BF16",
            "openai_base_url": "http://localhost:11434/v1",
            "api_key": "ollama",
            "embedding_dims": EMBED_DIMS,
        },
    },
    "llm": {
        "provider": "openai",
        "config": {
            "model": "llama3.1:8b",
            "openai_base_url": "http://localhost:11434/v1",
            "api_key": "ollama",
            "temperature": 0.1,
        },
    },
}

m = Memory.from_config(CONFIG)

print(f"--- add (infer={INFER}) ---")
res = m.add(
    "나는 생물정보학 연구자이고, 항상 한국어로 대화하는 걸 선호한다.",
    user_id=USER,
    infer=INFER,
)
print(res)

print("--- search: '이 사용자는 어떤 언어를 선호해?' ---")
for hit in m.search("이 사용자는 어떤 언어를 선호해?", filters={"user_id": USER}, limit=3).get("results", []):
    print(f"  {hit.get('score'):.3f}  {hit.get('memory')}")

print("--- all memories for", USER, "---")
for mem in m.get_all(filters={"user_id": USER}).get("results", []):
    print(f"  {mem.get('id')}  {mem.get('memory')}")
