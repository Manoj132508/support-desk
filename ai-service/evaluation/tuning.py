"""Threshold selection. PORTED FROM PROJECT 1 (ai-knowledge-assistant), unchanged in method.

Pure, so it is unit-tested without a model.

A turn's retrieval score does NOT depend on the threshold: retrieval computes a
top similarity, and the threshold only decides `grounded = top_score >=
threshold`. So the harness retrieves each turn once, records its top score, and
this module sweeps thresholds over the recorded scores analytically -- no
re-embedding, and no way for the sweep to leak into retrieval.

Selection rule: maximise BALANCED ACCURACY of the grounding decision against
`kb_covers` on the tuning turns, then take the midpoint of the plateau of
thresholds that tie for the best -- the choice furthest from any tuning score on
either side, and so the one most likely to hold on turns it has not seen.
"""

from __future__ import annotations


def grounded_at(top_score: float | None, threshold: float) -> bool:
    """The production rule, isolated: ground an answer iff a chunk cleared the threshold."""
    return top_score is not None and top_score >= threshold


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def balanced_accuracy(records: list[tuple[bool, bool]]) -> float:
    """Mean of the true-positive rate and the true-negative rate over (label, predicted) pairs.

    Balanced rather than plain accuracy, so a set with more of one label than
    the other cannot be gamed by always predicting the common one.
    """
    positives = [predicted for label, predicted in records if label]
    negatives = [predicted for label, predicted in records if not label]
    true_positive_rate = _mean([1.0 if predicted else 0.0 for predicted in positives])
    true_negative_rate = _mean([0.0 if predicted else 1.0 for predicted in negatives])
    return (true_positive_rate + true_negative_rate) / 2.0


def sweep(scored: list[tuple[bool, float | None]], candidates: list[float]) -> list[tuple[float, float]]:
    """Balanced accuracy at each candidate threshold, over (kb_covers, top_score) pairs."""
    return [
        (threshold, balanced_accuracy([(label, grounded_at(score, threshold)) for label, score in scored]))
        for threshold in candidates
    ]


def select_threshold(
    scored: list[tuple[bool, float | None]], candidates: list[float], *, eps: float = 1e-9
) -> tuple[float, float, list[tuple[float, float]]]:
    """The best threshold, ties broken to the plateau midpoint. Returns (chosen, best, curve)."""
    curve = sweep(scored, candidates)
    best = max(value for _, value in curve)
    plateau = [threshold for threshold, value in curve if value >= best - eps]
    return plateau[len(plateau) // 2], best, curve


def default_candidates(low: float = 0.10, high: float = 0.60, step: float = 0.005) -> list[float]:
    count = round((high - low) / step)
    return [round(low + index * step, 3) for index in range(count + 1)]
