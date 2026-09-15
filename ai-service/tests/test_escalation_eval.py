"""The escalation eval's own tests, and the per-push gate on the recogniser.

- The dataset is well formed, and every kind is in both halves of the split.
- The metric and tuning maths is right, on hand-built records.
- THE GATE: over every turn in the dataset, the intent recogniser never raises a
  proposal for a message that is not a request. It needs no model, so it runs
  on every push. The retrieval half needs the real embedder and runs weekly
  (eval.yml).
- The harness runs every turn through `plan_turn`, checked with the fakes.
"""

from __future__ import annotations

import inspect
import json

from app.config import Settings
from app.pipeline.intent import detect_action_request
from app.pipeline.retrieval import retrieve
from evaluation import tuning
from evaluation.dataset import ACTIONS, DATASET, KINDS, SPLITS
from evaluation.harness import KB_DIR, index_kb, run_turns, to_record
from evaluation.metrics import ANSWERED, OFFERED_PERSON, TurnRecord, outcome, summarise
from evaluation.run import BASELINE_PATH, turn_ok
from tests.fakes import BagOfWordsEmbedder, InMemoryVectorStore


def test_the_threshold_the_service_ships_is_the_one_the_eval_measured():
    # The live settings are pinned for the fake embedder (conftest.py), so the
    # DECLARED defaults are read. Change the threshold without re-running the
    # eval, or re-baseline without changing the threshold, and this fails.
    measured = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))["threshold"]
    assert Settings.model_fields["score_threshold"].default == measured
    assert inspect.signature(retrieve).parameters["score_threshold"].default == measured

# Requests the recogniser is known to miss. A miss fails SAFE -- the turn falls
# through to an ordinary answer and nothing is proposed -- so it is reported,
# not gated. A NEW miss still fails this suite, and a fixed one must be taken
# off this list, so the list stays true.
KNOWN_MISSES = {"act-could-you"}


def detected(message: str) -> str | None:
    request = detect_action_request(message)
    if request is None:
        return None
    return "ask_order_number" if request.needs_order_number else "propose"


def turn(id_: str):
    return next(t for t in DATASET if t.id == id_)


# --- The dataset -----------------------------------------------------------


def test_ids_are_unique_and_every_label_is_valid():
    ids = [t.id for t in DATASET]
    assert len(ids) == len(set(ids))
    for t in DATASET:
        assert t.kind in KINDS, t.id
        assert t.split in SPLITS, t.id
        assert t.expected_action in (*ACTIONS, None), t.id
        assert len(t.why) >= 10, f"{t.id} needs a reason"


def test_every_kind_is_in_both_halves_of_the_fixed_split():
    for kind in KINDS:
        for split in SPLITS:
            assert any(t.kind == kind and t.split == split for t in DATASET), (kind, split)


def test_labels_agree_with_their_kind():
    for t in DATASET:
        if t.kind == "answerable":
            assert t.kb_covers and not t.needs_person and t.expected_doc, t.id
        if t.kind == "needs_person":
            assert t.needs_person, t.id
        if t.kind == "out_of_scope":
            assert not t.kb_covers and not t.needs_person, t.id
        if t.kind != "action":
            assert t.expected_action is None, t.id


def test_every_expected_article_exists_in_the_help_centre():
    articles = {path.stem for path in KB_DIR.glob("*.md")}
    for t in DATASET:
        if t.expected_doc is not None:
            assert t.expected_doc in articles, t.id


def test_the_cases_the_eval_exists_for_are_present():
    # The help centre covering a topic and the customer needing a person come
    # apart; the set must contain both sides of that.
    assert any(t.needs_person and t.kb_covers for t in DATASET)
    assert any(t.needs_person and not t.kb_covers for t in DATASET)
    # Mentions of cancelling that are not requests, with an order number in them.
    for id_ in ("act-dont-cancel", "act-what-if", "act-no-need"):
        assert turn(id_).expected_action is None


# --- The gate --------------------------------------------------------------


def test_GATE_the_recogniser_never_proposes_for_a_message_that_is_not_a_request():
    false_proposals = [
        t.id for t in DATASET if t.expected_action is None and detected(t.message) == "propose"
    ]
    assert false_proposals == []


def test_requests_are_recognised_apart_from_the_known_misses():
    missed = {
        t.id for t in DATASET if t.expected_action is not None and detected(t.message) != t.expected_action
    }
    assert missed <= KNOWN_MISSES, f"new misses: {sorted(missed - KNOWN_MISSES)}"


def test_every_known_miss_is_still_a_miss_and_still_fails_safe():
    for id_ in KNOWN_MISSES:
        got = detected(turn(id_).message)
        assert got != turn(id_).expected_action, f"{id_} is fixed; remove it from KNOWN_MISSES"
        assert got != "propose"


# --- Metric maths ----------------------------------------------------------


def record(id_="t", kind="answerable", kb_covers=True, needs_person=False,
           expected_action=None, detected_action=None, grounded=True) -> TurnRecord:
    return TurnRecord(id_, kind, kb_covers, needs_person, expected_action, detected_action, grounded)


def test_a_request_to_act_is_decided_before_grounding_is_looked_at():
    assert outcome(record(detected_action="propose", grounded=False)) == "propose"
    assert outcome(record(grounded=True)) == ANSWERED
    assert outcome(record(grounded=False)) == OFFERED_PERSON


def test_an_answer_to_someone_who_needed_a_person_is_a_wrongful_deflection():
    summary = summarise([
        record("late-parcel", "needs_person", kb_covers=True, needs_person=True, grounded=True),
        record("charged-twice", "needs_person", kb_covers=False, needs_person=True, grounded=False),
    ])
    assert summary["wrongful_deflection_rate"] == 0.5
    assert summary["_ids"]["deflected"] == ["late-parcel"]


def test_unnecessary_offers_and_false_answers_are_counted_in_their_own_groups():
    summary = summarise([
        record("offered", grounded=False),
        record("answered", grounded=True),
        record("gym", "out_of_scope", kb_covers=False, grounded=True),
    ])
    assert summary["unnecessary_offer_rate"] == 0.5
    assert summary["_ids"]["unnecessary_offers"] == ["offered"]
    assert summary["false_answer_rate"] == 1.0


def test_false_proposals_count_every_turn_that_was_not_a_request():
    summary = summarise([
        record("question", detected_action="propose"),
        record("negated", "action"),
        record("request", "action", expected_action="propose", detected_action="propose"),
    ])
    assert summary["_ids"]["false_proposals"] == ["question"]
    assert summary["false_proposal_rate"] == 0.5
    assert summary["missed_request_rate"] == 0.0


def test_asking_for_an_order_number_when_a_proposal_was_due_is_a_miss():
    summary = summarise([record("r", "action", expected_action="propose", detected_action="ask_order_number")])
    assert summary["_ids"]["missed_requests"] == ["r"]


def test_an_empty_group_gives_zero_rather_than_a_crash():
    assert summarise([])["wrongful_deflection_rate"] == 0.0


def test_a_turn_is_ok_when_the_customer_got_what_its_kind_needs():
    assert turn_ok(record("oos", "out_of_scope", kb_covers=False, grounded=False))
    assert not turn_ok(record("oos", "out_of_scope", kb_covers=False, grounded=True))
    # A non-request that asks which order is not a proposal, so it is not a breach.
    assert turn_ok(record("neg", "action", detected_action="ask_order_number"))
    assert not turn_ok(record("neg", "action", detected_action="propose"))


# --- Tuning maths ----------------------------------------------------------


def test_grounded_at_is_the_production_rule():
    assert tuning.grounded_at(0.35, 0.35) is True
    assert tuning.grounded_at(0.349, 0.35) is False
    assert tuning.grounded_at(None, 0.0) is False


def test_balanced_accuracy_cannot_be_won_by_always_predicting_the_common_label():
    assert tuning.balanced_accuracy([(True, True)] * 9 + [(False, True)]) == 0.5


def test_the_threshold_chosen_is_the_middle_of_the_best_plateau():
    scored = [(True, 0.8), (True, 0.7), (False, 0.3), (False, 0.2)]
    chosen, best, _curve = tuning.select_threshold(scored, [0.25, 0.35, 0.45, 0.55, 0.65, 0.75])
    assert best == 1.0
    # Perfect at 0.35, 0.45, 0.55 and 0.65; the middle of those four is 0.55.
    assert chosen == 0.55


# --- The harness -----------------------------------------------------------


def test_the_harness_runs_every_turn_through_plan_turn_against_the_real_help_centre():
    embedder, store = BagOfWordsEmbedder(), InMemoryVectorStore()
    assert index_kb(embedder, store) > 0

    results = run_turns(DATASET, embedder, store)

    assert [r.case.id for r in results] == [t.id for t in DATASET]
    for r in results:
        assert r.detected_action == detected(r.case.message), r.case.id
        # The production escalation rule, observed rather than re-implemented.
        assert r.should_escalate is (r.detected_action is None and not r.grounded), r.case.id
    summary = summarise([to_record(r) for r in results])
    assert summary["false_proposal_rate"] == 0.0
    assert summary["_counts"]["turns"] == len(DATASET)


def test_replaying_a_turn_at_another_threshold_changes_only_its_grounding():
    embedder, store = BagOfWordsEmbedder(), InMemoryVectorStore()
    index_kb(embedder, store)
    [result] = run_turns([turn("act-cancel-numbered")], embedder, store)

    replayed = to_record(result, grounded=not result.grounded)

    assert replayed.grounded is (not result.grounded)
    assert replayed.detected_action == result.detected_action == "propose"
