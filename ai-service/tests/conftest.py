"""Shared test setup."""

from __future__ import annotations

import pytest

from app.config import settings
from tests.fakes import FAKE_EMBEDDER_THRESHOLD


@pytest.fixture(autouse=True)
def threshold_for_the_fake_embedder(monkeypatch):
    """Every test reads the fake embedder's scores against the fake's own threshold.

    See FAKE_EMBEDDER_THRESHOLD. A test that needs a grounding outcome to be
    certain still forces it (0.0 or 1.01) inside the test, which overrides this.
    The production value is checked where it means something: against the eval's
    baseline, in test_escalation_eval.py.
    """
    monkeypatch.setattr(settings, "score_threshold", FAKE_EMBEDDER_THRESHOLD)
