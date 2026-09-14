"""The advisory pipeline: recognise, retrieve, decide, generate.

This module is the whole of what the AI service does, and the shape of it is
ADR 0002 in code. Read what it returns: text, citations, a signal, and at most
one proposal REQUEST. It returns no commands, holds no credentials, and has no
branch that reaches a database. Express is free to ignore all of it, and for a
proposal it does more than that: it validates it, resolves it against the
customer's own orders, records it, and decides.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass

from app.config import settings
from app.pipeline.generator import Generator
from app.pipeline.intent import (
    ASK_FOR_ORDER_NUMBER,
    CHECKING_ORDER,
    build_proposal,
    detect_action_request,
)
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
class ActionPlan:
    """A turn in which the customer asked for an action rather than an answer.

    `kind` is "propose" (a proposal request goes upstream) or
    "ask_order_number" (the request named no order, so the assistant asks
    which one -- FR-4.2).

    `text` is STATIC. On an action turn the model is not called at all: what
    happens next is a policy decision Express makes, and the words around that
    decision must not be generated. A model asked to phrase "let me check that
    order" is a model that can phrase "done, I've cancelled it".
    """

    kind: str
    text: str
    proposal: dict | None


@dataclass(frozen=True)
class TurnPlan:
    grounded: bool
    should_escalate: bool
    top_score: float | None
    citations: list[Citation]
    system: str
    messages: list[dict]
    action: ActionPlan | None = None


def plan_turn(
    *,
    question: str,
    history: list[dict],
    embedder: Embedder,
    store: VectorStore,
) -> TurnPlan:
    """Everything that happens BEFORE a token is generated.

    Split out as a pure-ish function on purpose. It makes the decisions that
    matter -- is this a request to act, is an answer grounded, what exactly will
    the model be shown -- assertable without a model in the loop, which is the
    only way they can be asserted at all while live inference is blocked here.
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

    request = detect_action_request(question)
    if request is not None:
        if request.needs_order_number:
            action = ActionPlan(kind="ask_order_number", text=ASK_FOR_ORDER_NUMBER, proposal=None)
        else:
            # Evidence is attached only when retrieval was grounded. A proposal
            # "citing" chunks that scored below the threshold would claim a
            # policy basis the help centre does not actually provide.
            refs = [citation.chunk_id for citation in citations] if result.grounded else []
            action = ActionPlan(
                kind="propose",
                text=CHECKING_ORDER.format(order_number=request.order_number),
                proposal=build_proposal(request, refs),
            )

        return TurnPlan(
            grounded=result.grounded,
            # Not a deflection. Asking which order, or handing a request to the
            # policy engine, keeps the conversation moving; if a person is
            # needed, the policy decision says so.
            should_escalate=False,
            top_score=result.top_score,
            citations=citations,
            system=SYSTEM_PROMPT,
            messages=[],
            action=action,
        )

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
    """Yields the answer, the refusal, or the action turn's static text."""
    if plan.action is not None:
        yield plan.action.text
        return

    if not plan.grounded:
        yield REFUSAL_TEXT
        return

    async for token in generator.stream(plan.system, plan.messages):
        yield token
