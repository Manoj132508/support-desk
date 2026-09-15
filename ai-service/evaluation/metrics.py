"""Escalation eval metrics. Pure: plain records in, numbers out, no model.

What a customer experiences on a turn is one of four outcomes:

- propose           the assistant raised a proposal, and the policy engine
                    decides what happens next (ADR 0002);
- ask_order_number  it asked which order the customer meant;
- answered          it answered from the help centre, and offered nobody;
- offered_person    it could not ground an answer, and offered a person
                    (ADR 0010).

A request for an action takes the first two paths whatever retrieval scored,
because `plan_turn` checks for one before it looks at grounding.
"""

from __future__ import annotations

from dataclasses import dataclass

from evaluation.tuning import balanced_accuracy

ANSWERED = "answered"
OFFERED_PERSON = "offered_person"


@dataclass(frozen=True)
class TurnRecord:
    id: str
    kind: str
    kb_covers: bool
    needs_person: bool
    expected_action: str | None
    detected_action: str | None
    grounded: bool


def outcome(record: TurnRecord) -> str:
    if record.detected_action is not None:
        return record.detected_action
    return ANSWERED if record.grounded else OFFERED_PERSON


def _rate(count: int, of: int) -> float:
    return count / of if of else 0.0


def summarise(records: list[TurnRecord]) -> dict:
    """The eval's numbers, with the ids behind each so no failure is anonymous."""
    conversational = [r for r in records if r.kind != "action"]
    needs_person = [r for r in conversational if r.needs_person]
    answerable = [r for r in conversational if r.kind == "answerable"]
    out_of_scope = [r for r in conversational if r.kind == "out_of_scope"]
    no_request = [r for r in records if r.expected_action is None]
    requests = [r for r in records if r.expected_action is not None]

    deflected = [r.id for r in needs_person if outcome(r) == ANSWERED]
    unnecessary = [r.id for r in answerable if outcome(r) == OFFERED_PERSON]
    false_answers = [r.id for r in out_of_scope if outcome(r) == ANSWERED]
    false_proposals = [r.id for r in no_request if r.detected_action == "propose"]
    missed = [r.id for r in requests if r.detected_action != r.expected_action]

    return {
        # Of the customers who needed a person, how many got an answer instead.
        # The metric Phase 1 §6 names. Lower is better.
        "wrongful_deflection_rate": _rate(len(deflected), len(needs_person)),
        # Of the questions the help centre answers, how many were offered a
        # person instead. The cost of caution. Lower is better.
        "unnecessary_offer_rate": _rate(len(unnecessary), len(answerable)),
        # Of the questions that have nothing to do with the shop, how many were
        # answered from its help centre. Lower is better.
        "false_answer_rate": _rate(len(false_answers), len(out_of_scope)),
        # Of the messages that were not requests, how many raised a proposal.
        # A restraint metric: it should be exactly 0.
        "false_proposal_rate": _rate(len(false_proposals), len(no_request)),
        # Of the requests, how many the recogniser did not act on correctly.
        "missed_request_rate": _rate(len(missed), len(requests)),
        # How well grounding tracks whether the help centre covers the topic.
        "grounding_balanced_accuracy": balanced_accuracy([(r.kb_covers, r.grounded) for r in conversational]),
        "_ids": {
            "deflected": deflected,
            "unnecessary_offers": unnecessary,
            "false_answers": false_answers,
            "false_proposals": false_proposals,
            "missed_requests": missed,
        },
        "_counts": {
            "turns": len(records),
            "needs_person": len(needs_person),
            "answerable": len(answerable),
            "out_of_scope": len(out_of_scope),
            "not_requests": len(no_request),
            "requests": len(requests),
        },
    }
