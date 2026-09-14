"""The /turn stream, end to end through FastAPI, with no model and no network.

The heavy objects are placed in the app's state before the test client starts,
so the lifespan hook finds them already built and never imports torch.

The property that matters most here: this service emits `proposal_request` and
NEVER `proposal`. The browser's `proposal` event is produced only by Express,
after validation -- so if this service ever emitted it, the frame allowlist in
Express would be the only thing standing between the model and a confirmation
dialog. It should not have to be.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main
from app.pipeline.generator import ScriptedGenerator
from app.pipeline.loader import load_kb
from tests.fakes import BagOfWordsEmbedder, InMemoryVectorStore

KB = Path(__file__).resolve().parent.parent / "data" / "kb"
SERVER_ALLOWED_TOP_LEVEL = {"actionType", "target", "evidence", "reasonCode"}


@pytest.fixture()
def client():
    embedder = BagOfWordsEmbedder()
    store = InMemoryVectorStore()
    chunks = load_kb(KB)
    store.upsert("helpcentre", chunks, embedder.embed_documents([c.text for c in chunks]))
    generator = ScriptedGenerator(["Orders can be cancelled before dispatch [1]."])

    previous = dict(main.state)
    main.state.update({"embedder": embedder, "store": store, "generator": generator})
    try:
        with TestClient(main.app) as test_client:
            yield test_client, generator
    finally:
        main.state.clear()
        main.state.update(previous)


def _frames(body: str) -> list[tuple[str, object]]:
    frames = []
    for block in body.strip().split("\n\n"):
        event, data = None, None
        for line in block.splitlines():
            if line.startswith("event:"):
                event = line[len("event:"):].strip()
            elif line.startswith("data:"):
                data = json.loads(line[len("data:"):].strip())
        if event:
            frames.append((event, data))
    return frames


def _turn(test_client, question):
    response = test_client.post("/turn", json={"question": question})
    assert response.status_code == 200
    return _frames(response.text)


def test_a_cancellation_request_streams_text_then_a_proposal_request(client):
    test_client, generator = client
    frames = _turn(test_client, "Please cancel my order 1043")
    events = [event for event, _ in frames]

    assert events == ["token", "proposal_request", "done"]
    proposal = dict(frames)["proposal_request"]
    assert proposal["target"] == {"kind": "order", "orderNumber": "1043"}
    assert set(proposal) <= SERVER_ALLOWED_TOP_LEVEL
    assert dict(frames)["done"]["action"] == "propose"
    assert generator.calls == []


def test_THIS_SERVICE_NEVER_EMITS_THE_BROWSERS_PROPOSAL_EVENT(client):
    test_client, _ = client
    for question in (
        "Please cancel my order 1043",
        "cancel my order",
        "How do I cancel an order?",
        "Don't cancel order 1043",
    ):
        events = [event for event, _ in _turn(test_client, question)]
        assert "proposal" not in events, question


def test_a_request_without_an_order_asks_and_sends_no_proposal(client):
    test_client, _ = client
    frames = _turn(test_client, "cancel my order")
    assert [event for event, _ in frames] == ["token", "done"]
    assert dict(frames)["done"]["action"] == "ask_order_number"


def test_an_ordinary_question_streams_evidence_and_an_answer(client):
    test_client, generator = client
    frames = _turn(test_client, "can I cancel an order before it is dispatched")
    events = [event for event, _ in frames]

    assert "evidence" in events
    assert "proposal_request" not in events
    assert dict(frames)["done"]["action"] is None
    assert len(generator.calls) == 1


def test_an_action_turn_shows_no_footnotes(client):
    # The assistant's words on an action turn are static and carry no [n]
    # markers, so the citations travel with the proposal instead.
    test_client, _ = client
    events = [event for event, _ in _turn(test_client, "please cancel my order 1043 before it is dispatched")]
    assert "evidence" not in events


def test_a_negated_request_sends_no_proposal(client):
    test_client, _ = client
    events = [event for event, _ in _turn(test_client, "Don't cancel order 1043")]
    assert "proposal_request" not in events
