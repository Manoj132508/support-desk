"""NFR-1's instrumentation on the AI service's side of the boundary. Phase 14."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main
from app.config import Settings, settings
from app.pipeline.generator import OllamaGenerator, ScriptedGenerator, ollama_metrics, ollama_options
from app.pipeline.loader import load_kb
from app.timing import TurnClock
from tests.fakes import BagOfWordsEmbedder, InMemoryVectorStore

KB = Path(__file__).resolve().parent.parent / "data" / "kb"


# --- The clock ---------------------------------------------------------------


def test_marks_are_offsets_from_arrival_and_the_first_one_wins():
    now = iter([10.0, 10.25, 10.9])
    clock = TurnClock(now=lambda: next(now))
    clock.mark("first_token")
    clock.mark("first_token")
    assert clock.ms("first_token") == 250.0
    assert clock.ms("finished") is None


# --- What is asked of Ollama --------------------------------------------------


def test_num_gpu_is_sent_only_when_configured():
    assert "num_gpu" not in ollama_options(Settings())
    # 0 is a real setting, not "unset": it keeps the model off a faulty GPU.
    assert ollama_options(Settings(num_gpu=0))["num_gpu"] == 0


def test_the_example_environment_file_is_valid_configuration(monkeypatch):
    # Every AI_ setting exactly as .env.example documents it, empty values and
    # all -- which is how someone starting the project will first run it.
    example = Path(__file__).resolve().parents[2] / ".env.example"
    for line in example.read_text(encoding="utf-8").splitlines():
        if line.startswith("AI_") and "=" in line:
            name, value = line.split("=", 1)
            monkeypatch.setenv(name, value)

    configured = Settings()
    assert configured.num_gpu is None
    assert configured.environment == "development"


def test_ollama_metrics_split_a_request_into_load_prompt_and_generation():
    frame = {
        "done": True,
        "load_duration": 2_500_000_000,
        "prompt_eval_count": 812,
        "prompt_eval_duration": 9_123_456_789,
        "eval_count": 40,
        "eval_duration": 4_000_000_000,
        "total_duration": 15_700_000_000,
    }
    assert ollama_metrics(frame) == {
        "load_ms": 2500.0,
        "prompt_tokens": 812,
        "prompt_eval_ms": 9123.5,
        "output_tokens": 40,
        "eval_ms": 4000.0,
        "total_ms": 15700.0,
    }


def test_missing_metrics_are_none_rather_than_a_crash():
    assert ollama_metrics({"done": True})["prompt_eval_ms"] is None


def test_the_generator_streams_tokens_and_reports_the_final_frames_metrics(monkeypatch):
    monkeypatch.setattr(settings, "num_gpu", 0)
    sent = {}

    def handler(request: httpx.Request) -> httpx.Response:
        sent.update(json.loads(request.content))
        lines = [
            {"message": {"content": "Orders "}, "done": False},
            {"message": {"content": "can be cancelled."}, "done": False},
            {"message": {"content": ""}, "done": True, "prompt_eval_count": 300, "prompt_eval_duration": 1_500_000_000},
        ]
        return httpx.Response(200, content="\n".join(json.dumps(line) for line in lines).encode())

    reported = []
    generator = OllamaGenerator(base_url="http://ollama.test", model="m", transport=httpx.MockTransport(handler))

    async def run():
        return [t async for t in generator.stream("system", [{"role": "user", "content": "q"}], on_metrics=reported.append)]

    assert asyncio.run(run()) == ["Orders ", "can be cancelled."]
    assert sent["options"]["num_gpu"] == 0
    assert len(reported) == 1
    assert reported[0]["prompt_tokens"] == 300
    assert reported[0]["prompt_eval_ms"] == 1500.0


# --- The /turn log line -------------------------------------------------------


@pytest.fixture()
def client():
    embedder, store = BagOfWordsEmbedder(), InMemoryVectorStore()
    chunks = load_kb(KB)
    store.upsert("helpcentre", chunks, embedder.embed_documents([c.text for c in chunks]))
    previous = dict(main.state)
    main.state.update({"embedder": embedder, "store": store, "generator": ScriptedGenerator(["An answer [1]."])})
    try:
        with TestClient(main.app) as test_client:
            yield test_client
    finally:
        main.state.clear()
        main.state.update(previous)


def timing_lines(output: str) -> list[dict]:
    lines = [json.loads(line) for line in output.splitlines() if line.startswith("{")]
    return [line for line in lines if line.get("event") == "turn_timing"]


@pytest.mark.parametrize(
    ("question", "kind"),
    [
        ("can I cancel an order before it is dispatched", "answered"),
        ("what is the atomic mass of tungsten", "offered_person"),
        ("Please cancel my order 1043", "propose"),
        ("cancel my order", "ask_order_number"),
    ],
)
def test_every_turn_logs_one_timing_line_with_its_kind(client, capsys, question, kind):
    response = client.post("/turn", json={"question": question, "correlation_id": "corr-42"})
    assert response.status_code == 200

    [line] = timing_lines(capsys.readouterr().out)
    assert line["correlation_id"] == "corr-42"
    assert line["kind"] == kind
    assert line["completed"] is True
    assert 0 <= line["plan_ms"] <= line["first_token_ms"] <= line["finished_ms"]


def test_the_timing_line_never_contains_the_question(client, capsys):
    question = "My name is Ana Pereira and my order 1043 is late"
    client.post("/turn", json={"question": question, "correlation_id": "corr-43"})

    output = capsys.readouterr().out
    assert timing_lines(output)
    assert "Ana Pereira" not in output
    assert question not in output
