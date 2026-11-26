"""
main.py — FastAPI application for GitHub Repo Chat (RAG with OpenAI)
"""
import asyncio
import os
from concurrent.futures import ThreadPoolExecutor

from dotenv import load_dotenv, find_dotenv
load_dotenv(find_dotenv())

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.models import (
    ChatRequest,
    ChatResponse,
    IndexRequest,
    IndexResponse,
    SourceDoc,
    StatusResponse,
)
from app.rag import answer_question, get_repo_key, index_repo, load_session_from_disk, parse_github_url

# ─── Validate env ─────────────────────────────────────────────────────────────
if not os.getenv("OPENAI_API_KEY"):
    print("[WARNING] OPENAI_API_KEY is not set. Add it to your .env file.")

# ─── In-memory session store  key → session dict ──────────────────────────────
_sessions: dict[str, dict] = {}

# Thread pool for sync-heavy work (git clone + embedding)
_executor = ThreadPoolExecutor(max_workers=4)


# ─── App setup ────────────────────────────────────────────────────────────────
app = FastAPI(
    title="GitHub Repo Chat API",
    description="RAG-powered chat over GitHub repositories using OpenAI",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/", tags=["Health"])
def health():
    return {"status": "ok", "message": "GitHub Repo Chat API is running "}


@app.get("/status/{owner}/{repo}", response_model=StatusResponse, tags=["Index"])
def status(owner: str, repo: str):
    """Check if a repo is already indexed (in memory or on disk)."""
    key = f"{owner}/{repo}".lower()
    session = _sessions.get(key)

    # Not in memory — try to restore from disk (survives server restarts)
    if not session:
        session = load_session_from_disk(owner, repo)
        if session:
            _sessions[key] = session  # cache back in memory

    if session:
        return StatusResponse(
            indexed=True,
            repo=session["repo"],
            branch=session["branch"],
            chunk_count=session["chunk_count"],
        )
    return StatusResponse(indexed=False)


@app.post("/index", response_model=IndexResponse, tags=["Index"])
async def index(req: IndexRequest):
    """
    Clone the GitHub repo, embed matching files, store session in memory.
    Heavy work runs in a thread pool so the event loop is not blocked.
    """
    try:
        loop = asyncio.get_event_loop()
        session = await loop.run_in_executor(
            _executor,
            lambda: index_repo(
                req.repo_url,
                req.extensions,
                req.chunk_size,
                req.chunk_overlap,
                req.top_k,
            ),
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Indexing failed: {e}")

    key = get_repo_key(req.repo_url)
    _sessions[key] = session

    return IndexResponse(
        success=True,
        repo=session["repo"],
        branch=session["branch"],
        file_count=session["file_count"],
        chunk_count=session["chunk_count"],
        message=f"Indexed {session['chunk_count']} chunks from {session['file_count']} files.",
    )


@app.post("/chat", response_model=ChatResponse, tags=["Chat"])
async def chat(req: ChatRequest):
    """
    Answer a question about a previously indexed repo using OpenAI RAG.
    """
    key = get_repo_key(req.repo_url)
    session = _sessions.get(key)

    # Not in memory — try to restore from disk automatically
    if not session:
        try:
            owner, repo_name = parse_github_url(req.repo_url)
            session = load_session_from_disk(owner, repo_name, top_k=5)
            if session:
                _sessions[key] = session
        except Exception:
            pass

    if not session:
        raise HTTPException(
            status_code=404,
            detail="Repository not indexed yet. POST to /index first.",
        )

    try:
        loop = asyncio.get_event_loop()
        answer_text, docs = await loop.run_in_executor(
            _executor,
            lambda: answer_question(req.question, session, req.model),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Chat failed: {e}")

    sources = []
    seen = set()
    for doc in docs:
        src = doc.metadata.get("source")
        if src and src not in seen:
            seen.add(src)
            sources.append(
                SourceDoc(
                    source=src,
                    url=doc.metadata.get("url"),
                    chunk=doc.metadata.get("chunk", 0),
                )
            )

    return ChatResponse(answer=answer_text, sources=sources)