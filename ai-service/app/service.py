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
from app.pipeline.generator import Generator, MetricsCallback
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
    build_question_message,
    build_user_message,
    build_whole_help_centre_system,
    canonical_order,
)
from app.pipeline.retrieval import Embedder, RetrievedChunk, VectorStore, retrieve

# What a prompt was built from: the whole help centre (ADR 0011), or the
# retrieved chunks because the help centre is too large to send whole.
WHOLE_HELP_CENTRE = "whole"
RETRIEVED = "retrieved"


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
    # Set only when the model will be called. For the timing log.
    context: str | None = None


def _citations(chunks: list[RetrievedChunk]) -> list[Citation]:
    """Numbered from 1 in the order given, which must be the order the model sees."""
    return [
        Citation(
            n=position,
            chunk_id=chunk.chunk_id,
            document_id=chunk.document_id,
            document_name=chunk.document_name,
            section=chunk.section,
            score=chunk.score,
        )
        for position, chunk in enumerate(chunks, start=1)
    ]


def sends_whole_help_centre(store: VectorStore) -> tuple[bool, int]:
    """Whether an answer's prompt holds every chunk (ADR 0011), and how many there are."""
    total = store.count(settings.collection)
    return 0 < total <= settings.full_context_max_chunks, total


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
    whole, total = sends_whole_help_centre(store)
    # One search either way. For a whole-help-centre prompt it scores every
    # chunk, because all of them are shown; the grounding decision still reads
    # only the best score, so it is the same decision.
    result = retrieve(
        query=question,
        collection=settings.collection,
        embedder=embedder,
        store=store,
        top_k=total if whole else settings.top_k,
        score_threshold=settings.score_threshold,
    )
    ranked = result.chunks[: settings.top_k]
    citations = _citations(ranked)

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

    if whole:
        # ADR 0011. Every source, in help-centre order, in the system message:
        # the same text for every question and conversation, so the model
        # reuses its reading of it. The sources that cleared the threshold are
        # named by number next to the question.
        shown = canonical_order(result.chunks)
        position = {chunk.chunk_id: n for n, chunk in enumerate(shown, start=1)}
        relevant = [position[chunk.chunk_id] for chunk in ranked if chunk.score >= settings.score_threshold]
        system = build_whole_help_centre_system(shown)
        question_message = build_question_message(question, relevant)
    else:
        shown = ranked
        system = SYSTEM_PROMPT
        question_message = build_user_message(question, ranked)

    return TurnPlan(
        grounded=True,
        should_escalate=False,
        top_score=result.top_score,
        # Numbered as the model sees the sources, so every [n] it writes has a
        # footnote.
        citations=_citations(shown),
        system=system,
        messages=[*build_history_messages(history), {"role": "user", "content": question_message}],
        context=WHOLE_HELP_CENTRE if whole else RETRIEVED,
    )


def warm_up_prompt(embedder: Embedder, store: VectorStore) -> tuple[str, list[dict]]:
    """The start every answer's prompt shares, for priming the model at startup.

    For a whole-help-centre prompt that is the system message with every source;
    otherwise only the system prompt is shared. The question is a placeholder:
    it is the part that is never reused.
    """
    whole, total = sends_whole_help_centre(store)
    placeholder = [{"role": "user", "content": "Question: (warm-up)"}]
    if not whole:
        return SYSTEM_PROMPT, placeholder
    chunks = store.query(settings.collection, embedder.embed_query("warm-up"), total)
    return build_whole_help_centre_system(canonical_order(chunks)), placeholder


async def stream_answer(
    plan: TurnPlan, generator: Generator, on_metrics: MetricsCallback | None = None
) -> AsyncIterator[str]:
    """Yields the answer, the refusal, or the action turn's static text.

    `on_metrics` receives the model's own timing when, and only when, the model
    was called.
    """
    if plan.action is not None:
        yield plan.action.text
        return

    if not plan.grounded:
        yield REFUSAL_TEXT
        return

    async for token in generator.stream(plan.system, plan.messages, on_metrics=on_metrics):
        yield token
