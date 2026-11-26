from pydantic import BaseModel, Field
from typing import Optional


# ── Index endpoint ───────────────────────────────────────────────────────────

class IndexRequest(BaseModel):
    repo_url: str = Field(..., description="Full GitHub repository URL")
    extensions: list[str] = Field(
        default=[
            ".py", ".js", ".ts", ".md", ".txt", ".json", ".yaml", ".yml", ".java", ".go", ".rs",
            ".cpp", ".c", ".h", ".cs", ".php", ".swift", ".kt", ".scala",
            ".html", ".css", ".scss", ".less", ".ini", ".cfg", ".toml", ".xml"
        ],
        description="File extensions to embed",
    )
    chunk_size: int = Field(default=1200, ge=200, le=4000)
    chunk_overlap: int = Field(default=200, ge=0, le=800)
    top_k: int = Field(default=4, ge=1, le=15)


class IndexResponse(BaseModel):
    success: bool
    repo: str
    branch: str
    file_count: int
    chunk_count: int
    message: str


# ── Status endpoint ───────────────────────────────────────────────────────────

class StatusResponse(BaseModel):
    indexed: bool
    repo: Optional[str] = None
    branch: Optional[str] = None
    chunk_count: Optional[int] = None


# ── Chat endpoint ────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    repo_url: str
    question: str
    model: str = Field(default="gpt-4o-mini", description="OpenAI model name")


class SourceDoc(BaseModel):
    source: str
    url: Optional[str] = None
    chunk: int = 0


class ChatResponse(BaseModel):
    answer: str
    sources: list[SourceDoc]
