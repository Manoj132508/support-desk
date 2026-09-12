"""The advisory pipeline: what the model is shown, and when it is not called."""

from __future__ import annotations

import asyncio
from pathlib import Path

from app.pipeline.generator import ScriptedGenerator
from app.pipeline.loader import load_kb
from app.pipeline.prompt import REFUSAL_TEXT, SYSTEM_PROMPT
from app.service import plan_turn, stream_answer
from tests.fakes import BagOfWordsEmbedder, InMemoryVectorStore

KB = Path(__file__).resolve().parent.parent / "data" / "kb"


def _loaded():
    embedder = BagOfWordsEmbedder()
    store = InMemoryVectorStore()
    chunks = load_kb(KB)
    store.upsert("helpcentre", chunks, embedder.embed_documents([c.text for c in chunks]))
    return embedder, store


def _collect(plan, generator):
    async def run():
        return [token async for token in stream_answer(plan, generator)]

    return asyncio.run(run())


def test_a_grounded_question_reaches_the_model_with_its_sources():
    embedder, store = _loaded()
    plan = plan_turn(
        question="can I cancel an order before it is dispatched",
        history=[],
        embedder=embedder,
        store=store,
    )
    assert plan.grounded is True

    generator = ScriptedGenerator(["Yes", ", before dispatch [1]."])
    tokens = _collect(plan, generator)
    assert "".join(tokens) == "Yes, before dispatch [1]."

    # The assertion that matters is about the PROMPT, not the answer. A model's
    # output is not a stable thing to test; what the model was shown is.
    system, messages = generator.calls[0]
    assert system == SYSTEM_PROMPT
    assert "Sources:" in messages[-1]["content"]
    assert "Question: can I cancel" in messages[-1]["content"]


def test_sources_come_before_the_question():
    # The long stable part sits where prompt caching can reuse it, and
    # instructions placed after a long context are followed more reliably than
    # ones buried above it.
    embedder, store = _loaded()
    plan = plan_turn(question="cancel an order", history=[], embedder=embedder, store=store)
    content = plan.messages[-1]["content"]
    assert content.index("Sources:") < content.index("Question:")


def test_INV_C_an_ungrounded_question_never_reaches_the_model():
    embedder, store = _loaded()
    plan = plan_turn(
        question="what is the atomic mass of tungsten",
        history=[],
        embedder=embedder,
        store=store,
    )
    assert plan.grounded is False

    generator = ScriptedGenerator(["this should never be yielded"])
    tokens = _collect(plan, generator)

    assert "".join(tokens) == REFUSAL_TEXT
    # Not "the model was asked to refuse politely" -- the model was NOT CALLED.
    # Refusing here is both the honest answer and the cheapest possible request.
    assert generator.calls == []


def test_an_ungrounded_turn_asks_for_a_human():
    embedder, store = _loaded()
    plan = plan_turn(question="what is the capital of peru", history=[], embedder=embedder, store=store)
    assert plan.should_escalate is True
    # A grounded one does not.
    grounded = plan_turn(question="cancel an order", history=[], embedder=embedder, store=store)
    assert grounded.should_escalate is False


def test_citations_are_references_and_carry_no_prose():
    # ADR 0006's amendment. A snippet would become free text inside the
    # immutable audit row Express writes downstream -- unscrubbable by
    # construction.
    embedder, store = _loaded()
    plan = plan_turn(question="cancel an order", history=[], embedder=embedder, store=store)

    assert plan.citations
    for citation in plan.citations:
        assert citation.chunk_id
        assert not hasattr(citation, "text")
        assert not hasattr(citation, "snippet")


def test_citations_are_numbered_from_one_to_match_the_sources_block():
    embedder, store = _loaded()
    plan = plan_turn(question="cancel an order", history=[], embedder=embedder, store=store)
    assert [c.n for c in plan.citations] == list(range(1, len(plan.citations) + 1))


def test_an_ungrounded_turn_still_reports_what_was_found():
    # A threshold set too high fails silently, showing a polite refusal rather
    # than an error. Persisting the score and the near misses is the only way
    # it ever becomes visible.
    embedder, store = _loaded()
    plan = plan_turn(question="what is the capital of peru", history=[], embedder=embedder, store=store)
    assert plan.grounded is False
    assert plan.top_score is not None
    assert plan.citations != []


def test_history_is_bounded_and_starts_on_a_user_turn():
    embedder, store = _loaded()
    history = [{"role": "assistant", "content": f"a{i}"} for i in range(10)]
    history += [{"role": "user", "content": "and the other order?"}]

    plan = plan_turn(question="cancel an order", history=history, embedder=embedder, store=store)
    prior = plan.messages[:-1]

    assert len(prior) <= 6, "history must stay bounded or it crowds out the sources"
    if prior:
        assert prior[0]["role"] == "user"


def test_the_system_prompt_forbids_claiming_an_action_happened():
    # This does NOT enforce INV-A -- nothing in a prompt can, and the invariant
    # holds because this process has no write path at all. What it prevents is
    # the model LYING about the invariant: saying "I've cancelled that" while
    # the policy engine is refusing produces the same complaint and the same
    # lost trust as an unauthorised action would.
    lowered = SYSTEM_PROMPT.lower()
    assert "never state or imply that an action has already happened" in lowered
    assert "cannot change, cancel or refund anything yourself" in lowered
