"""CLI for the escalation eval. Phase 1 §7.3.

    python -m evaluation.run                  # the report, at the configured threshold
    python -m evaluation.run --tune           # choose a threshold on `tune`, judge it once on `holdout`
    python -m evaluation.run --write-baseline # save the numbers as the drift baseline
    python -m evaluation.run --check          # exit 1 if a number moved the wrong way since the baseline
    python -m evaluation.run --json           # the per-turn results as JSON

Needs the full requirements (sentence-transformers, chromadb), not the test
subset: it embeds the real help centre with the real model into a throwaway
Chroma directory. No language model is involved -- see harness.py -- so it runs
on a CPU in about a minute.

DETERMINISTIC, BUT NOT A MERGE GATE. The model is fixed and runs on CPU, so the
same code gives the same numbers. It still stays out of the per-push CI: it
installs torch and downloads a model, minutes of setup most changes do not
need. It runs weekly and on demand instead (eval.yml), and `--check` fails that
run if the numbers drift. The per-push gate on this service is the recogniser's
restraint, which needs no model and lives in tests/test_escalation_eval.py.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

from app.config import settings
from app.pipeline.embedder import DEFAULT_MODEL, SentenceTransformerEmbedder
from app.pipeline.vector_store import ChromaVectorStore
from evaluation import tuning
from evaluation.dataset import DATASET
from evaluation.harness import TurnResult, index_kb, run_turns, to_record
from evaluation.metrics import TurnRecord, outcome, summarise

BASELINE_PATH = Path(__file__).parent / "baseline.json"

# +1 higher is better, -1 lower is better. Used by --check.
DIRECTION = {
    "wrongful_deflection_rate": -1,
    "unnecessary_offer_rate": -1,
    "false_answer_rate": -1,
    "false_proposal_rate": -1,
    "missed_request_rate": -1,
    "grounding_balanced_accuracy": +1,
}

EXPECTED_OUTCOME = {"answerable": "answered", "needs_person": "offered_person", "out_of_scope": "offered_person"}


def turn_ok(record: TurnRecord) -> bool:
    if record.kind == "action":
        if record.expected_action is not None:
            return record.detected_action == record.expected_action
        return record.detected_action != "propose"
    return outcome(record) == EXPECTED_OUTCOME[record.kind]


def top_doc_hit_rate(results: list[TurnResult]) -> float:
    """Of the answerable turns, how many retrieved the expected article first."""
    answerable = [r for r in results if r.case.kind == "answerable"]
    hits = [r for r in answerable if r.top_document == r.case.expected_doc]
    return len(hits) / len(answerable) if answerable else 0.0


def _bar(value: float) -> str:
    filled = round(value * 20)
    return "█" * filled + "·" * (20 - filled)


def print_report(results: list[TurnResult], summary: dict, chunks: int) -> None:
    counts, ids = summary["_counts"], summary["_ids"]
    print("\n" + "=" * 78)
    print("  ESCALATION EVAL -- Phase 1 §7.3")
    print("=" * 78)
    print(
        f"  model={DEFAULT_MODEL.split('/')[-1]}  threshold={settings.score_threshold}  "
        f"top_k={settings.top_k}  turns={counts['turns']}  chunks={chunks}"
    )
    print("\n  WHAT CUSTOMERS WOULD EXPERIENCE (lower is better unless marked)")
    rows = (
        ("wrongful_deflection_rate", "deflected", "needs_person", "needed a person and got an answer"),
        ("unnecessary_offer_rate", "unnecessary_offers", "answerable", "had an answer and were offered a person"),
        ("false_answer_rate", "false_answers", "out_of_scope", "out of scope and answered anyway"),
        ("false_proposal_rate", "false_proposals", "not_requests", "not requests, and a proposal was raised"),
        ("missed_request_rate", "missed_requests", "requests", "requests not acted on correctly"),
    )
    for key, id_key, count_key, meaning in rows:
        print(f"    {key:<28} {summary[key]:.3f}  {_bar(summary[key])}  {len(ids[id_key])} of {counts[count_key]} {meaning}")
    bal = summary["grounding_balanced_accuracy"]
    print(f"    {'grounding_balanced_accuracy':<28} {bal:.3f}  {_bar(bal)}  higher is better")
    hit = top_doc_hit_rate(results)
    print(f"    {'top_doc_hit_rate':<28} {hit:.3f}  {_bar(hit)}  higher is better")

    print("\n  PER TURN")
    for result in results:
        record = to_record(result)
        mark = "ok" if turn_ok(record) else "!!"
        score = f"{result.top_score:.3f}" if result.top_score is not None else "  -- "
        print(f"    {mark}  {result.case.id:<32} score={score}  -> {outcome(record):<17} [{result.case.kind}]")
    print("=" * 78 + "\n")


def run_tuning(results: list[TurnResult]) -> None:
    """Choose on `tune`; look at `holdout` once, at the old and the chosen threshold only.

    The target is `kb_covers`. Action turns are left out, because a request
    to act never reaches the grounding decision.
    """
    conversational = [r for r in results if r.case.kind != "action"]
    tune = [(r.case.kb_covers, r.top_score) for r in conversational if r.case.split == "tune"]
    holdout = [r for r in conversational if r.case.split == "holdout"]

    chosen, best, _curve = tuning.select_threshold(tune, tuning.default_candidates())
    old = settings.score_threshold

    def holdout_at(threshold: float) -> dict:
        return summarise([to_record(r, grounded=tuning.grounded_at(r.top_score, threshold)) for r in holdout])

    before, after = holdout_at(old), holdout_at(chosen)

    print("\n" + "=" * 78)
    print("  THRESHOLD TUNING")
    print("=" * 78)
    print(f"  tuning turns: {len(tune)}   holdout turns: {len(holdout)}")
    print(f"  selected on TUNING: threshold={chosen:.3f}  (balanced accuracy {best:.3f})")
    print("\n  HELD-OUT (looked at once, never used to choose)")
    print(f"    {'metric':<30}{'@ ' + format(old, '.3f') + ' (now)':>16}{'@ ' + format(chosen, '.3f') + ' (chosen)':>19}")
    for key in ("grounding_balanced_accuracy", "wrongful_deflection_rate", "unnecessary_offer_rate", "false_answer_rate"):
        print(f"    {key:<30}{before[key]:>16.3f}{after[key]:>19.3f}")
    better = after["grounding_balanced_accuracy"] >= before["grounding_balanced_accuracy"]
    print(f"\n  verdict: {chosen:.3f} {'holds up on holdout' if better else 'does NOT beat the current value on holdout'}")
    print("  (to apply: change score_threshold in app/config.py, then --write-baseline)")
    print("=" * 78 + "\n")


def save_baseline(summary: dict) -> None:
    payload = {
        "embedding_model": DEFAULT_MODEL,
        "threshold": settings.score_threshold,
        "top_k": settings.top_k,
        "turns": summary["_counts"]["turns"],
        "metrics": {key: round(summary[key], 6) for key in DIRECTION},
    }
    BASELINE_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"  baseline written to {BASELINE_PATH.name}")


def check_baseline(summary: dict, tolerance: float = 0.02) -> bool:
    if not BASELINE_PATH.exists():
        print("  no baseline.json -- run with --write-baseline first.")
        return False
    baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    ok = True
    print("\n  DRIFT CHECK (vs baseline.json)")
    if baseline.get("turns") != summary["_counts"]["turns"]:
        # A changed dataset makes the comparison meaningless, not passing.
        print(f"    the dataset has {summary['_counts']['turns']} turns; the baseline had {baseline.get('turns')}. Re-baseline deliberately.")
        return False
    for key, direction in DIRECTION.items():
        now, was = summary[key], baseline["metrics"][key]
        regressed = direction * (now - was) < -tolerance
        print(f"    {key:<30} {was:.3f} -> {now:.3f}   {'REGRESSED' if regressed else 'ok'}")
        ok = ok and not regressed
    print(f"  result: {'PASS' if ok else 'FAIL'}\n")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description="Escalation eval")
    parser.add_argument("--tune", action="store_true", help="choose a threshold on tune, judge it on holdout")
    parser.add_argument("--write-baseline", action="store_true", help="save the numbers as the baseline")
    parser.add_argument("--check", action="store_true", help="exit 1 if a number drifted the wrong way")
    parser.add_argument("--json", action="store_true", help="print per-turn results as JSON")
    args = parser.parse_args()

    # The report draws bars with block characters, and a Windows console
    # defaults to cp1252, which has none: the first run crashed mid-report.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    print("  loading the embedding model (the first run downloads ~90 MB)...")
    embedder = SentenceTransformerEmbedder(DEFAULT_MODEL)

    directory = tempfile.mkdtemp(prefix="support-desk-eval-")
    try:
        store = ChromaVectorStore(directory)
        chunks = index_kb(embedder, store)
        results = run_turns(DATASET, embedder, store)

        if args.tune:
            run_tuning(results)
            return 0

        summary = summarise([to_record(r) for r in results])

        if args.json:
            print(json.dumps(
                {
                    "threshold": settings.score_threshold,
                    "summary": summary,
                    "turns": [
                        {
                            "id": r.case.id,
                            "kind": r.case.kind,
                            "split": r.case.split,
                            "top_score": r.top_score,
                            "top_document": r.top_document,
                            "outcome": outcome(to_record(r)),
                            "ok": turn_ok(to_record(r)),
                        }
                        for r in results
                    ],
                },
                indent=2,
            ))
        else:
            print_report(results, summary, chunks)

        if args.write_baseline:
            save_baseline(summary)
        if args.check:
            return 0 if check_baseline(summary) else 1
        return 0
    finally:
        # Chroma can hold its files open on Windows; a leftover temp directory
        # is not worth failing a measurement over.
        shutil.rmtree(directory, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
