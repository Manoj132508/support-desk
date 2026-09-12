"""The advisory pipeline: retrieve, decide, generate.

This module is the whole of what the AI service does, and the shape of it is
ADR 0002 in code. Read what it returns: text, citations, and a signal. It
returns no commands, holds no credentials, and has no branch that reaches a
database. Express is free to ignore everything here.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass

from app.config import settings
from app.pipeline.generator import Generator
from app.pipeline.prompt import (
    REFUSAL_TEXT,
    SYSTEM_PROMPT,
    build_history_messages,
    build_user_message,
)
from app.pipeline.retrieval import Embedder, VectorStore, retrieve


@dataclass(frozen=True)
class Citation:
    """What crosses the boundary is a REFERENCE, never a snippet.

    ADR 0006's amendment: a copied-in excerpt would be free text inside the
    immutable audit row Express writes downstream, and free text in a row that
    can never be edited is unscrubbable by construction. So the citation
    carries enough to render a footnote and resolve the chunk, and no prose.
    """

    n: int
    chunk_id: str
    document_id: str
    document_name: str
    section: str | None
    score: float


@dataclass(frozen=True)
class TurnPlan:
    grounded: bool
    should_escalate: bool
    top_score: float | None
    citations: list[Citation]
    system: str
    messages: list[dict]


def plan_turn(
    *,
    question: str,
    history: list[dict],
    embedder: Embedder,
    store: VectorStore,
) -> TurnPlan:
    """Everything that happens BEFORE a token is generated.

    Split out as a pure-ish function on purpose. It makes the two decisions
    that matter -- is this grounded, and what exactly will the model be shown --
    assertable without a model in the loop, which is the only way they can be
    asserted at all while live inference is blocked here.
    """
    result = retrieve(
        query=question,
        collection=settings.collection,
        embedder=embedder,
        store=store,
        top_k=settings.top_k,
        score_threshold=settings.score_threshold,
    )

    citations = [
        Citation(
            n=position,
            chunk_id=chunk.chunk_id,
            document_id=chunk.document_id,
            document_name=chunk.document_name,
            section=chunk.section,
            score=chunk.score,
        )
        for position, chunk in enumerate(result.chunks, start=1)
    ]

    if not result.grounded:
        # INV-C. The model is not called at all -- not asked to refuse
        # politely, not given the chunks with a warning. Refusing here is both
        # the honest answer and the cheapest possible request.
        #
        # Citations are still returned, ungrounded, so Express can persist what
        # WAS found alongside the top score. A threshold that is too high fails
        # silently, showing a polite refusal rather than an error, so nothing
        # else would ever record that it happened.
        return TurnPlan(
            grounded=False,
            should_escalate=result.should_escalate,
            top_score=result.top_score,
            citations=citations,
            system=SYSTEM_PROMPT,
            messages=[],
        )

    messages = [
        *build_history_messages(history),
        {"role": "user", "content": build_user_message(question, result.chunks)},
    ]

    return TurnPlan(
        grounded=True,
        should_escalate=False,
        top_score=result.top_score,
        citations=citations,
        system=SYSTEM_PROMPT,
        messages=messages,
    )


async def stream_answer(plan: TurnPlan, generator: Generator) -> AsyncIterator[str]:
    """Yields the answer, or the refusal, one token at a time."""
    if not plan.grounded:
        yield REFUSAL_TEXT
        return

    async for token in generator.stream(plan.system, plan.messages):
        yield token
