"""
rag.py — Core RAG logic (repo cloning, embedding, retrieval, answering)
Embeddings : OpenAI text-embedding-3-small  (dimensions=256 — fast & compact)
Chat       : OpenAI GPT models
"""
import os
import re
import shutil
import tempfile
from pathlib import Path

# Persistent storage directory for Chroma vector stores
PERSIST_BASE = Path(os.getenv("CHROMA_PERSIST_DIR", "./chroma_store"))

# Max files to embed — prevents timeout on giant repos
MAX_FILES = int(os.getenv("RAG_MAX_FILES", "300"))

from git import Repo
from langchain_chroma import Chroma
from langchain_core.documents import Document
from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

# ─── Prompt ──────────────────────────────────────────────────────────────────

PROMPT_TEMPLATE = ChatPromptTemplate.from_template(
    "You are an expert code assistant. Use the repository README and retrieved code snippets "
    "to answer the question accurately. If you don't know, say so. "
    "Always cite file paths when relevant.\n\n"
    "README (truncated):\n{readme}\n\n"
    "Relevant snippets:\n{context}\n\n"
    "Question: {question}\n\nAnswer:"
)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def truncate_text(text: str, max_tokens: int = 2000, ratio: int = 4) -> str:
    limit = max_tokens * ratio
    return text if len(text) <= limit else text[:limit] + "\n\n[...truncated...]"


def parse_github_url(url: str) -> tuple[str, str]:
    match = re.match(
        r"https?://(?:www\.)?github\.com/(?P<owner>[a-zA-Z0-9-]+)/(?P<repo>[a-zA-Z0-9._-]+)",
        url or "",
    )
    if not match:
        raise ValueError("Enter a valid GitHub URL like https://github.com/owner/repo")
    return match.group("owner"), match.group("repo").removesuffix(".git")


def get_repo_key(url: str) -> str:
    owner, repo = parse_github_url(url)
    return f"{owner}/{repo}".lower()


# ─── Git helpers ──────────────────────────────────────────────────────────────

def clone_repo(url: str) -> tuple[Repo, str]:
    temp_dir = tempfile.mkdtemp(prefix="git_rag_")
    repo = Repo.clone_from(url, temp_dir, depth=1)   # shallow clone = much faster
    return repo, temp_dir


def get_default_branch(repo: Repo) -> str:
    try:
        return repo.active_branch.name
    except Exception:
        return "main"


def find_readme_blob(repo: Repo):
    common_names = {"README.md", "README.MD", "Readme.md", "readme.md", "README", "README.txt", "README.rst"}
    head_tree = repo.head.commit.tree
    names_in_root = {e.name: e for e in head_tree}
    for name in common_names:
        entry = names_in_root.get(name)
        if entry and entry.type == "blob":
            return entry
    for entry in head_tree.traverse():
        if entry.type == "blob":
            lower = entry.name.lower()
            if lower == "readme" or lower.startswith("readme."):
                return entry
    return None


def read_blob_text(blob, max_bytes: int = 300_000) -> str:
    data = blob.data_stream.read(max_bytes + 1)
    return data.decode("utf-8", errors="replace")


def fetch_readme(repo: Repo) -> str:
    blob = find_readme_blob(repo)
    if not blob:
        return "README not found or empty."
    return read_blob_text(blob) or "README not found or empty."


def iter_matching_blobs(repo: Repo, exts: set[str]):
    for entry in repo.head.commit.tree.traverse():
        if entry.type == "blob" and any(entry.path.lower().endswith(e) for e in exts):
            yield entry.path, entry


def format_docs(docs: list) -> str:
    if not docs:
        return "(no relevant snippets)"
    return "\n\n-----\n\n".join(
        f"Source: {d.metadata.get('source', 'unknown')}\n{d.page_content}" for d in docs
    )


# ─── Main indexing function ───────────────────────────────────────────────────

def index_repo(
    url: str,
    exts: list[str],
    chunk_size: int,
    chunk_overlap: int,
    top_k: int,
) -> dict:
    """
    Clone (shallow) → embed (dimensions=256) → persist to Chroma.
    Returns a session dict.
    """
    owner, repo_name = parse_github_url(url)
    repo, _ = clone_repo(url)
    branch = get_default_branch(repo)
    readme = truncate_text(fetch_readme(repo))

    splitter = RecursiveCharacterTextSplitter(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    ext_set = {e.lower() for e in exts}
    docs: list[Document] = []
    file_count = 0

    for rel_path, blob in iter_matching_blobs(repo, ext_set):
        if file_count >= MAX_FILES:
            break                              # safety cap for huge repos
        text = read_blob_text(blob)
        if not text.strip():
            continue
        file_count += 1
        for j, chunk in enumerate(splitter.split_text(text)):
            docs.append(
                Document(
                    page_content=chunk,
                    metadata={
                        "source": rel_path,
                        "repo": f"{owner}/{repo_name}",
                        "branch": branch,
                        "chunk": j,
                        "url": f"https://github.com/{owner}/{repo_name}/blob/{branch}/{rel_path}",
                    },
                )
            )

    # dimensions=256 matches the working Streamlit config — 6× faster than default 1536
    embeddings = OpenAIEmbeddings(model="text-embedding-3-small", dimensions=256)

    # Wipe stale store before re-indexing so we start fresh
    persist_dir = str(PERSIST_BASE / owner / repo_name)
    if Path(persist_dir).exists():
        shutil.rmtree(persist_dir, ignore_errors=True)

    vector_store = Chroma(
        embedding_function=embeddings,
        persist_directory=persist_dir,
    )
    if docs:
        vector_store.add_documents(docs)

    retriever = vector_store.as_retriever(search_kwargs={"k": int(top_k)})

    return {
        "retriever": retriever,
        "readme": readme,
        "repo": f"{owner}/{repo_name}",
        "branch": branch,
        "file_count": file_count,
        "chunk_count": len(docs),
        "persist_dir": persist_dir,
    }


# ─── Reload session from disk ────────────────────────────────────────────────

def load_session_from_disk(owner: str, repo_name: str, top_k: int = 5) -> dict | None:
    persist_dir = PERSIST_BASE / owner / repo_name
    if not persist_dir.exists():
        return None

    embeddings = OpenAIEmbeddings(model="text-embedding-3-small", dimensions=256)
    vector_store = Chroma(
        embedding_function=embeddings,
        persist_directory=str(persist_dir),
    )
    try:
        chunk_count = vector_store._collection.count()
    except Exception:
        chunk_count = 0

    if chunk_count == 0:
        return None

    retriever = vector_store.as_retriever(search_kwargs={"k": int(top_k)})
    return {
        "retriever": retriever,
        "readme": "(README not cached — re-index to restore full context)",
        "repo": f"{owner}/{repo_name}",
        "branch": "unknown",
        "file_count": 0,
        "chunk_count": chunk_count,
        "persist_dir": str(persist_dir),
    }


# ─── Answering ────────────────────────────────────────────────────────────────

def answer_question(question: str, session: dict, model: str) -> tuple[str, list[Document]]:
    retriever = session["retriever"]
    readme = session.get("readme") or "(no README found)"

    docs = retriever.invoke(question)
    prompt = PROMPT_TEMPLATE.format_messages(
        readme=readme,
        context=format_docs(docs),
        question=question,
    )
    llm = ChatOpenAI(model=model, temperature=0.2)
    response = llm.invoke(prompt)
    return response.content, docs
