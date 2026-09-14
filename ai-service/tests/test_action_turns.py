"""Action turns: when the customer asks the assistant to DO something.

On these turns the model is never called. The assistant's words are static, the
proposal is a request for Express to decide on, and a request that names no
order produces a question rather than a guess.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from app.config import settings
from app.pipeline.generator import ScriptedGenerator
from app.pipeline.intent import ASK_FOR_ORDER_NUMBER
from app.pipeline.loader import load_kb
from app.service import plan_turn, stream_answer
from tests.fakes import BagOfWordsEmbedder, InMemoryVectorStore

KB = Path(__file__).resolve().parent.parent / "data" / "kb"
KB_DOCUMENTS = ("cancelling-an-order:", "returns-and-refunds:", "delivery-and-tracking:")


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


def _plan(question):
    embedder, store = _loaded()
    return plan_turn(question=question, history=[], embedder=embedder, store=store)


def test_a_cancellation_request_becomes_a_proposal_and_the_model_is_never_called():
    plan = _plan("Please cancel my order 1043")

    assert plan.action is not None
    assert plan.action.kind == "propose"
    assert plan.action.proposal["target"] == {"kind": "order", "orderNumber": "1043"}

    generator = ScriptedGenerator(["this text must never reach the customer"])
    text = "".join(_collect(plan, generator))

    assert "order 1043" in text
    # Not "the model was asked to phrase it carefully" -- the model was not
    # called. A model asked to say "let me check" can also say "done".
    assert generator.calls == []


def test_a_request_naming_no_order_asks_which_one_and_proposes_nothing():
    plan = _plan("cancel my order")
    assert plan.action.kind == "ask_order_number"
    assert plan.action.proposal is None

    generator = ScriptedGenerator(["should not be used"])
    assert "".join(_collect(plan, generator)) == ASK_FOR_ORDER_NUMBER
    assert generator.calls == []


def test_an_action_turn_is_not_a_deflection():
    # Asking which order, or handing a request to the policy engine, keeps the
    # conversation moving. If a person is needed, the policy decision says so.
    assert _plan("Please cancel my order 1043").should_escalate is False
    assert _plan("cancel my order").should_escalate is False


def test_a_question_about_cancelling_gets_an_answer_not_a_proposal():
    plan = _plan("can I cancel an order before it is dispatched")
    assert plan.action is None
    assert plan.grounded is True

    generator = ScriptedGenerator(["Yes, before dispatch [1]."])
    assert "".join(_collect(plan, generator)) == "Yes, before dispatch [1]."
    assert len(generator.calls) == 1


def test_negation_never_becomes_a_proposal():
    assert _plan("Don't cancel order 1043").action is None


# Grounding is FORCED in the next two tests, not hoped for.
#
# The first version picked a sentence -- "please cancel my order 1043 before it
# is dispatched" -- and assumed the fake embedder would score it above the
# threshold. It did not. The rule under test is not "this phrasing grounds";
# it is "evidence is attached when retrieval is grounded, and only then". So the
# threshold is set to make each case certain, and the rule is checked in both
# directions. How a real model grounds action phrasings is a question for the
# Phase 13 eval, not something a bag-of-words fake can answer.


def test_a_grounded_proposal_cites_the_help_centre_by_reference(monkeypatch):
    monkeypatch.setattr(settings, "score_threshold", 0.0)
    plan = _plan("Please cancel my order 1043")
    assert plan.grounded is True

    evidence = plan.action.proposal["evidence"]
    assert evidence, "a grounded request should carry its policy basis"
    for item in evidence:
        assert set(item) == {"kind", "ref"}
        assert item["ref"].startswith(KB_DOCUMENTS)


def test_an_ungrounded_proposal_carries_no_evidence(monkeypatch):
    # Citing chunks that scored below the threshold would claim a policy basis
    # the help centre does not actually provide.
    monkeypatch.setattr(settings, "score_threshold", 1.01)
    plan = _plan("Please cancel my order 1043")
    assert plan.grounded is False
    assert plan.action.kind == "propose", "an ungrounded request is still a request"
    assert plan.action.proposal["evidence"] == []
