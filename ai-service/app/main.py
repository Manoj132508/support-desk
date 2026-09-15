"""FastAPI app. The advisory tier, and nothing more.

Read the route list and note what is missing: there is no endpoint that
changes anything. That is not because those endpoints are unwritten -- it is
ADR 0002. Express owns everything with consequences; this process answers
questions and proposes, and is not publicly routable.
"""

from __future__ import annotations

import json
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import settings, startup_problems
from app.pipeline.generator import OllamaGenerator
from app.pipeline.loader import load_kb
from app.service import plan_turn, stream_answer

state: dict = {"embedder": None, "store": None, "generator": None}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Builds the heavy objects once, at startup.

    Constructing the embedder per request would reload a transformer model
    every time. It is also where the two-gigabyte import actually happens --
    deferred to here so that importing this module (as the tests do) costs
    nothing.

    First, though, it refuses to start an unsafe production configuration
    (Phase 12): a service meant to answer only the API should not come up
    answering anyone.
    """
    problems = startup_problems(settings)
    if problems:
        raise RuntimeError("Refusing to start: " + "; ".join(problems))

    if state["embedder"] is None:
        from app.pipeline.embedder import SentenceTransformerEmbedder  # noqa: PLC0415
        from app.pipeline.vector_store import ChromaVectorStore  # noqa: PLC0415

        state["embedder"] = SentenceTransformerEmbedder()
        state["store"] = ChromaVectorStore(settings.index_path)
    if state["generator"] is None:
        state["generator"] = OllamaGenerator()
    yield


app = FastAPI(title="AI Support Desk — advisory service", lifespan=lifespan)


def require_service_token(x_service_token: str = Header(default="")) -> None:
    """Refuses calls that did not come from the API tier.

    This is defence in depth, not the boundary. The real protection is that
    this process is not publicly routable (ADR 0001). But "not routable" is a
    deployment property, and deployment properties get changed by someone in a
    hurry -- so the service also declines to answer strangers.

    It FAILS CLOSED in production (Phase 12). An unset token used to mean
    "accept everyone" in every environment. Startup now refuses that
    configuration in production; this is the second lock, for a setting changed
    underneath a running process.

    `compare_digest` rather than `==`: a naive comparison returns early on the
    first differing byte, which leaks the token a character at a time to anyone
    patient enough to measure.
    """
    if not settings.service_token:
        if settings.is_production:
            raise HTTPException(status_code=401, detail="service token required")
        return  # development only: the dev ports are localhost-only
    if not secrets.compare_digest(x_service_token, settings.service_token):
        raise HTTPException(status_code=401, detail="service token required")


@app.get("/health")
def health() -> dict:
    """Reports each dependency independently, matching the API tier's shape."""
    indexed = None
    if state["store"] is not None:
        try:
            indexed = state["store"].count(settings.collection)
        except Exception:  # noqa: BLE001 - health must never raise
            indexed = None

    return {
        "status": "ok" if state["embedder"] is not None else "starting",
        "model": settings.model,
        "collection": settings.collection,
        "indexed_chunks": indexed,
    }


class TurnRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    history: list[dict] = Field(default_factory=list)
    correlation_id: str | None = None


@app.post("/turn", dependencies=[Depends(require_service_token)])
async def turn(request: TurnRequest) -> StreamingResponse:
    """Streams one advisory turn as SSE.

    `token`, `evidence` and `done` are relayed by Express to the browser, so
    their names match the Phase 6 contract and the client's `parseFrames`.

    `proposal_request` is NOT relayed. It carries a raw proposal to Express,
    which intercepts it, runs it through the boundary and the policy engine,
    and sends the browser its own `proposal` or `policy` frame instead. This
    service never emits `proposal` itself -- that is the browser's event, and
    only Express may produce it.

    `evidence` frames carry references, never snippets (ADR 0006 amendment).
    """
    plan = plan_turn(
        question=request.question,
        history=request.history,
        embedder=state["embedder"],
        store=state["store"],
    )

    async def frames() -> AsyncIterator[str]:
        # On an action turn the citations are attached to the proposal as
        # evidence, not shown as footnotes: the assistant's words on that turn
        # are static and carry no [n] markers to hang them on.
        if plan.action is None:
            for citation in plan.citations:
                yield sse(
                    "evidence",
                    {
                        "kind": "kb_chunk",
                        "ref": citation.chunk_id,
                        "n": citation.n,
                        "documentName": citation.document_name,
                        "section": citation.section,
                        "score": round(citation.score, 4),
                    },
                )

        async for token in stream_answer(plan, state["generator"]):
            yield sse("token", token)

        if plan.action is not None and plan.action.proposal is not None:
            # A REQUEST, under its own event name. See the docstring above.
            yield sse("proposal_request", plan.action.proposal)

        yield sse(
            "done",
            {
                "grounded": plan.grounded,
                "shouldEscalate": plan.should_escalate,
                "topScore": plan.top_score,
                "action": plan.action.kind if plan.action is not None else None,
            },
        )

    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/ingest", dependencies=[Depends(require_service_token)])
def ingest() -> dict:
    """Re-indexes the help centre. Idempotent by construction.

    Chunk ids are deterministic (`{document_id}:{index}`), so re-ingesting
    unchanged content upserts the same ids over themselves rather than
    accumulating duplicates. That is the property the chunker's determinism
    exists to provide, and it is why re-indexing is safe to run on deploy.

    It reads the CONFIGURED help centre and nothing else (Phase 12). It used to
    accept a `path` in the request, so any caller could have the service read a
    directory of its choosing into the index -- from which retrieval would then
    quote it to customers. The directory is a deployment setting, not a request
    parameter.
    """
    directory = Path(settings.kb_path)
    chunks = load_kb(
        directory, chunk_size=settings.chunk_size, chunk_overlap=settings.chunk_overlap
    )
    if not chunks:
        return {"documents": 0, "chunks": 0}

    embeddings = state["embedder"].embed_documents([chunk.text for chunk in chunks])
    state["store"].upsert(settings.collection, chunks, embeddings)

    return {
        "documents": len({chunk.document_id for chunk in chunks}),
        "chunks": len(chunks),
    }


def sse(event: str, data) -> str:
    """One SSE frame. `json.dumps` even for plain strings, so a token
    containing a newline cannot forge a frame boundary -- the parser on the
    other side splits on a blank line."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"
