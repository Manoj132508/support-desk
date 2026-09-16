"""Phase 12: the advisory tier refuses strangers, and reads only its own help centre."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main
from app.config import Settings, startup_problems
from app.pipeline.generator import ScriptedGenerator
from tests.fakes import BagOfWordsEmbedder, InMemoryVectorStore

TOKEN = "t" * 32


@pytest.fixture()
def client():
    previous = dict(main.state)
    main.state.update(
        {
            "embedder": BagOfWordsEmbedder(),
            "store": InMemoryVectorStore(),
            "generator": ScriptedGenerator(["An answer."]),
        }
    )
    try:
        with TestClient(main.app) as test_client:
            yield test_client
    finally:
        main.state.clear()
        main.state.update(previous)


def _turn(test_client, headers=None):
    return test_client.post("/turn", json={"question": "hello"}, headers=headers or {})


def test_with_a_token_configured_a_call_without_it_or_with_the_wrong_one_is_refused(client, monkeypatch):
    monkeypatch.setattr(main.settings, "service_token", TOKEN)
    assert _turn(client).status_code == 401
    assert _turn(client, {"X-Service-Token": "wrong"}).status_code == 401
    assert _turn(client, {"X-Service-Token": TOKEN}).status_code == 200


def test_in_production_an_unset_token_fails_closed(client, monkeypatch):
    monkeypatch.setattr(main.settings, "environment", "production")
    monkeypatch.setattr(main.settings, "service_token", "")
    assert _turn(client).status_code == 401
    assert client.post("/ingest").status_code == 401


def test_in_development_an_unset_token_still_admits_local_calls(client, monkeypatch):
    monkeypatch.setattr(main.settings, "environment", "development")
    monkeypatch.setattr(main.settings, "service_token", "")
    assert _turn(client).status_code == 200


def test_production_refuses_to_start_without_a_strong_token_and_names_no_value():
    assert startup_problems(Settings(environment="production", service_token=TOKEN)) == []
    assert startup_problems(Settings(environment="development", service_token="")) == []

    short = startup_problems(Settings(environment="production", service_token="hunter2"))
    assert len(short) == 1
    assert "AI_SERVICE_TOKEN" in short[0]
    assert "hunter2" not in short[0]
    assert startup_problems(Settings(environment="production", service_token="")) == short


def test_the_app_will_not_start_in_production_without_a_token(monkeypatch):
    monkeypatch.setattr(main.settings, "environment", "production")
    monkeypatch.setattr(main.settings, "service_token", "")
    with pytest.raises(RuntimeError, match="Refusing to start"):
        with TestClient(main.app):
            pass


def test_ingest_reads_only_the_configured_help_centre_whatever_the_request_names(client, monkeypatch):
    seen = []

    def fake_load(directory, **kwargs):
        seen.append(Path(directory))
        return []

    monkeypatch.setattr(main, "load_kb", fake_load)
    response = client.post("/ingest", json={"path": "C:/Windows/System32"})

    assert response.status_code == 200
    # Every read, including the startup indexing of an empty index (Phase 15),
    # is of the configured directory and nothing else.
    assert seen
    assert set(seen) == {Path(main.settings.kb_path)}
