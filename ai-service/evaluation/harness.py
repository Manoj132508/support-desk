"""Runs the labelled turns through the REAL advisory pipeline.

`plan_turn` is what the `/turn` endpoint calls, so the eval measures the
shipping decision path: the intent recogniser, retrieval, the threshold, and the
escalation signal. The embedder and store are passed in -- the real
sentence-transformers model with a throwaway Chroma directory for a measurement,
or the test fakes for checking the plumbing.

NO GENERATOR. In this design the escalation signal is decided before any text is
generated (ADR 0010), so measuring it needs no language model. That is why this
eval can run on a machine whose GPU cannot run one.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.config import settings
from app.pipeline.loader import load_kb
from app.service import plan_turn
from evaluation.dataset import EvalTurn
from evaluation.metrics import TurnRecord

KB_DIR = Path(__file__).resolve().parent.parent / "data" / "kb"


@dataclass(frozen=True)
class TurnResult:
    case: EvalTurn
    top_score: float | None
    grounded: bool
    should_escalate: bool
    detected_action: str | None
    top_document: str | None


def index_kb(embedder, store) -> int:
    """Indexes the real help centre with the real loader and chunker."""
    chunks = load_kb(KB_DIR, chunk_size=settings.chunk_size, chunk_overlap=settings.chunk_overlap)
    store.upsert(settings.collection, chunks, embedder.embed_documents([chunk.text for chunk in chunks]))
    return len(chunks)


def run_turns(cases: list[EvalTurn], embedder, store) -> list[TurnResult]:
    results = []
    for case in cases:
        plan = plan_turn(question=case.message, history=[], embedder=embedder, store=store)
        results.append(
            TurnResult(
                case=case,
                top_score=plan.top_score,
                grounded=plan.grounded,
                should_escalate=plan.should_escalate,
                detected_action=plan.action.kind if plan.action is not None else None,
                top_document=plan.citations[0].document_id if plan.citations else None,
            )
        )
    return results


def to_record(result: TurnResult, *, grounded: bool | None = None) -> TurnRecord:
    """A metric record. `grounded` can be overridden to replay a turn at another threshold."""
    return TurnRecord(
        id=result.case.id,
        kind=result.case.kind,
        kb_covers=result.case.kb_covers,
        needs_person=result.case.needs_person,
        expected_action=result.case.expected_action,
        detected_action=result.detected_action,
        grounded=result.grounded if grounded is None else grounded,
    )
