"""ADR 0011: the shape of an answer's prompt, and the warm-up that relies on it.

On a CPU, an answer's first token waits for the model to read its prompt, and
the model reuses its reading of any start it has read before. These tests pin
down the properties that make that reuse happen -- the start is identical
across questions and conversations -- and the ones that keep answers honest
while it does: every source the model can cite has a footnote, the relevant
sources are named, grounding is still decided by retrieval, and a help centre
too large to send whole gets exactly the prompt it had before.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main
from app.config import settings
from app.pipeline.generator import OllamaGenerator, ScriptedGenerator
from app.pipeline.loader import load_kb
from app.pipeline.prompt import SYSTEM_PROMPT, canonical_order
from app.pipeline.retrieval import RetrievedChunk, retrieve
from app.service import RETRIEVED, WHOLE_HELP_CENTRE, plan_turn, warm_up_prompt
from tests.fakes import BagOfWordsEmbedder, InMemoryVectorStore

KB = Path(__file__).resolve().parent.parent / "data" / "kb"
QUESTIONS = ("can I cancel an order before it is dispatched", "how long does a refund take to appear")


def loaded():
    embedder, store = BagOfWordsEmbedder(), InMemoryVectorStore()
    chunks = load_kb(KB)
    store.upsert(settings.collection, chunks, embedder.embed_documents([c.text for c in chunks]))
    return embedder, store, chunks


def plan(question, embedder, store, history=()):
    return plan_turn(question=question, history=list(history), embedder=embedder, store=store)


@pytest.fixture()
def grounded_everything(monkeypatch):
    # Grounding is forced, not hoped for: the property under test is the prompt
    # a grounded question gets, not whether a bag-of-words fake grounds it.
    monkeypatch.setattr(settings, "score_threshold", 0.0)


def chunk(chunk_id):
    return RetrievedChunk(chunk_id=chunk_id, document_id=chunk_id.split(":")[0], document_name="", section=None, text="", score=0.0)


def test_canonical_order_is_article_then_numeric_position_whatever_the_scores():
    shuffled = [chunk("returns:1"), chunk("cancelling:10"), chunk("cancelling:2"), chunk("delivery:0")]
    assert [c.chunk_id for c in canonical_order(shuffled)] == ["cancelling:2", "cancelling:10", "delivery:0", "returns:1"]


def test_two_different_questions_share_the_same_system_message(grounded_everything):
    embedder, store, _ = loaded()
    first, second = (plan(question, embedder, store) for question in QUESTIONS)

    assert first.context == second.context == WHOLE_HELP_CENTRE
    # The whole point: the part the model can reuse is byte-for-byte identical,
    # AND it is the long part. A bare system prompt was identical before too.
    assert "Sources:" in first.system
    assert first.system == second.system
    assert first.messages[-1]["content"] != second.messages[-1]["content"]


def test_history_does_not_change_the_shared_start(grounded_everything):
    # Measured: sources placed after history made a follow-up turn's prompt
    # take 23.7 s to read, against about 2 s with them in the system message.
    embedder, store, _ = loaded()
    history = [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "Hi, how can I help?"}]
    fresh = plan(QUESTIONS[0], embedder, store)
    follow_up = plan(QUESTIONS[0], embedder, store, history)

    assert "Sources:" in follow_up.system
    assert follow_up.system == fresh.system
    assert all("Sources:" not in m["content"] for m in follow_up.messages)
    assert [m["role"] for m in follow_up.messages] == ["user", "assistant", "user"]
    assert follow_up.messages[-1]["content"].endswith(f"Question: {QUESTIONS[0]}")


def test_every_chunk_is_shown_in_help_centre_order_and_every_citation_resolves(grounded_everything):
    embedder, store, chunks = loaded()
    grounded = plan(QUESTIONS[0], embedder, store)

    expected = [c.chunk_id for c in canonical_order([chunk(c.chunk_id) for c in chunks])]
    assert [c.chunk_id for c in grounded.citations] == expected
    assert [c.n for c in grounded.citations] == list(range(1, len(chunks) + 1))
    # Numbered in the system message exactly as the citations are numbered.
    for citation in grounded.citations:
        assert f"[{citation.n}] (" in grounded.system


def test_the_question_names_only_the_sources_that_cleared_the_threshold(monkeypatch):
    embedder, store, _ = loaded()
    ranked = retrieve(query=QUESTIONS[0], collection=settings.collection, embedder=embedder, store=store, top_k=10,
                      score_threshold=0.0).chunks
    assert ranked[0].score > ranked[1].score, "the fixture needs a clear best chunk"
    monkeypatch.setattr(settings, "score_threshold", (ranked[0].score + ranked[1].score) / 2)

    grounded = plan(QUESTIONS[0], embedder, store)

    best = next(c.n for c in grounded.citations if c.chunk_id == ranked[0].chunk_id)
    assert grounded.messages[-1]["content"] == (
        f"The sources most relevant to this question are [{best}].\n\nQuestion: {QUESTIONS[0]}"
    )


def test_a_help_centre_too_large_to_send_whole_gets_the_prompt_it_had_before(grounded_everything, monkeypatch):
    monkeypatch.setattr(settings, "full_context_max_chunks", 3)
    embedder, store, _ = loaded()
    grounded = plan(QUESTIONS[0], embedder, store)

    assert grounded.context == RETRIEVED
    assert grounded.system == SYSTEM_PROMPT
    content = grounded.messages[-1]["content"]
    assert content.startswith("Sources:") and "most relevant" not in content
    assert len(grounded.citations) == settings.top_k
    scores = [c.score for c in grounded.citations]
    assert scores == sorted(scores, reverse=True), "score order, as before"


def test_INV_C_is_untouched_an_ungrounded_question_is_not_sent_the_help_centre(monkeypatch):
    monkeypatch.setattr(settings, "score_threshold", 1.01)
    embedder, store, _ = loaded()
    ungrounded = plan(QUESTIONS[0], embedder, store)

    assert ungrounded.grounded is False
    assert ungrounded.messages == [] and ungrounded.context is None
    # What was found is still reported, as the top few, not the whole help centre.
    assert len(ungrounded.citations) == settings.top_k


def test_a_proposal_cites_the_most_relevant_chunks_not_the_whole_help_centre(grounded_everything):
    embedder, store, _ = loaded()
    action = plan("Please cancel my order 1043", embedder, store)
    assert action.action.kind == "propose"
    assert len(action.action.proposal["evidence"]) == settings.top_k


def test_the_warm_up_primes_exactly_the_start_a_real_answer_uses(grounded_everything):
    embedder, store, _ = loaded()
    system, messages = warm_up_prompt(embedder, store)
    assert system == plan(QUESTIONS[1], embedder, store).system
    assert messages[-1]["role"] == "user"


def test_without_a_whole_help_centre_the_warm_up_primes_the_system_prompt(monkeypatch):
    monkeypatch.setattr(settings, "full_context_max_chunks", 0)
    embedder, store, _ = loaded()
    assert warm_up_prompt(embedder, store)[0] == SYSTEM_PROMPT


# --- Keeping the model loaded, and priming it ----------------------------------


def test_every_request_asks_ollama_to_keep_the_model_loaded(monkeypatch):
    monkeypatch.setattr(settings, "keep_alive", "30m")
    sent = []

    def handler(request):
        sent.append(json.loads(request.content))
        if sent[-1]["stream"]:
            return httpx.Response(200, content=json.dumps({"message": {"content": "hi"}, "done": True}).encode())
        return httpx.Response(200, json={"done": True, "load_duration": 16_000_000_000, "prompt_eval_count": 1200})

    generator = OllamaGenerator(base_url="http://ollama.test", model="m", transport=httpx.MockTransport(handler))

    async def run():
        metrics = await generator.prime("system", [{"role": "user", "content": "q"}])
        tokens = [t async for t in generator.stream("system", [{"role": "user", "content": "q"}])]
        return metrics, tokens

    metrics, tokens = asyncio.run(run())
    primed, streamed = sent
    assert primed["keep_alive"] == streamed["keep_alive"] == "30m"
    assert primed["stream"] is False and primed["options"]["num_predict"] == 1
    assert metrics["load_ms"] == 16000.0 and tokens == ["hi"]


class RecordingPrimer(ScriptedGenerator):
    def __init__(self, fail=False):
        super().__init__([])
        self.primed = []
        self.fail = fail

    async def prime(self, system, messages):
        if self.fail:
            raise httpx.ConnectError("ollama is not running")
        self.primed.append(system)
        return {"load_ms": 1.0}


def warm_up_lines(output):
    return [json.loads(line) for line in output.splitlines() if line.startswith("{") and '"warm_up"' in line]


def test_warm_up_primes_the_model_with_the_shared_start(grounded_everything, capsys):
    embedder, store, _ = loaded()
    primer = RecordingPrimer()
    previous = dict(main.state)
    main.state.update({"embedder": embedder, "store": store, "generator": primer})
    try:
        asyncio.run(main.warm_up())
    finally:
        main.state.clear()
        main.state.update(previous)

    assert primer.primed == [warm_up_prompt(embedder, store)[0]]
    [line] = warm_up_lines(capsys.readouterr().out)
    assert line["outcome"] == "complete"


def test_a_failed_warm_up_is_logged_and_never_raised(capsys):
    embedder, store, _ = loaded()
    previous = dict(main.state)
    main.state.update({"embedder": embedder, "store": store, "generator": RecordingPrimer(fail=True)})
    try:
        asyncio.run(main.warm_up())
    finally:
        main.state.clear()
        main.state.update(previous)

    [line] = warm_up_lines(capsys.readouterr().out)
    assert line["outcome"] == "failed"
    assert line["error"] == "ConnectError"


def test_reindexing_the_help_centre_warms_the_model_again(capsys, monkeypatch):
    embedder, store = BagOfWordsEmbedder(), InMemoryVectorStore()
    primer = RecordingPrimer()
    previous = dict(main.state)
    main.state.update({"embedder": embedder, "store": store, "generator": primer})
    monkeypatch.setattr(settings, "kb_path", str(KB))
    try:
        with TestClient(main.app) as client:
            capsys.readouterr()  # the startup warm-up, over an empty index
            assert client.post("/ingest").status_code == 200
    finally:
        main.state.clear()
        main.state.update(previous)

    assert warm_up_lines(capsys.readouterr().out), "ingest should warm the model for the new help centre"
    assert primer.primed and "Sources:" in primer.primed[-1]
