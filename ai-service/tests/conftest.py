"""Shared test setup."""

from __future__ import annotations

import os
import sys

import pytest

from app.config import settings
from tests.fakes import FAKE_EMBEDDER_THRESHOLD


def _escape_data(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _escape_property(value: str) -> str:
    return _escape_data(value).replace(":", "%3A").replace(",", "%2C")


def github_annotation(nodeid: str, path: str, line: int, message: str, workspace: str) -> str:
    """One failed test as a GitHub annotation line. Phase 15.

    GitHub shows a job's log only to people signed in; annotations anyone can
    read, through the API as well. So on CI a failure's test, file, line and
    last line of the error also go out as an annotation.
    """
    relative = os.path.relpath(os.path.abspath(path), workspace).replace("\\", "/")
    # A leading newline: GitHub reads a command only at the start of a line,
    # and pytest's progress dots are still on this one.
    return (
        f"\n::error file={_escape_property(relative)},line={line},"
        f"title={_escape_property(nodeid)}::{_escape_data(message)}\n"
    )


def failure_message(longreprtext: str) -> str:
    """The `E` lines pytest marks as the error, else the report's last line."""
    lines = [text for text in longreprtext.strip().splitlines() if text.strip()]
    errors = [text[1:].strip() for text in lines if text.startswith("E ")]
    if errors:
        return "\n".join(errors)
    return lines[-1] if lines else "failed"


def pytest_runtest_logreport(report):
    if os.environ.get("GITHUB_ACTIONS") != "true" or not report.failed:
        return
    path, line, _ = report.location
    message = failure_message(report.longreprtext)
    workspace = os.environ.get("GITHUB_WORKSPACE", os.getcwd())
    # sys.__stdout__, not print: pytest captures print while a test runs.
    sys.__stdout__.write(github_annotation(report.nodeid, path, (line or 0) + 1, message, workspace))


@pytest.fixture(autouse=True)
def threshold_for_the_fake_embedder(monkeypatch):
    """Every test reads the fake embedder's scores against the fake's own threshold.

    See FAKE_EMBEDDER_THRESHOLD. A test that needs a grounding outcome to be
    certain still forces it (0.0 or 1.01) inside the test, which overrides this.
    The production value is checked where it means something: against the eval's
    baseline, in test_escalation_eval.py.
    """
    monkeypatch.setattr(settings, "score_threshold", FAKE_EMBEDDER_THRESHOLD)
