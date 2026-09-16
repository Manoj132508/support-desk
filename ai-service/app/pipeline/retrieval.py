"""Semantic retrieval and the grounding decision.

PORTED FROM PROJECT 1 (ai-knowledge-assistant), where it is ADR 008. The rule
it owns -- the LLM is not called when nothing relevant was found -- is INV-C in
this project, and it is inherited wholesale rather than re-derived.

One thing is different here, and it is worth reading §2 of the Phase 9 document
for: in Project 1 a refusal was the end of the interaction. Here it is a
HANDOFF. A support customer told "I couldn't find that" and left there has been
deflected, which is the failure this project measures (wrongful deflection
rate). So the grounding decision now carries an escalation signal alongside it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class RetrievedChunk:
    chunk_id: str
    document_id: str
    document_name: str
    section: str | None
    text: str
    score: float


@dataclass(frozen=True)
class RetrievalResult:
    chunks: list[RetrievedChunk]
    top_score: float | None
    grounded: bool
    """False means: do not call the model, and hand off to a human."""

    @property
    def should_escalate(self) -> bool:
        """The project-specific half of the decision.

        Project 1 could stop at "not in your documents". A support desk cannot:
        a customer who asked a real question and got a refusal still has the
        problem they arrived with. Every ungrounded turn therefore offers a
        person (FR-8.2), and the rate at which that happens is the wrongful
        deflection metric the escalation eval measures in Phase 13.
        """
        return not self.grounded


class VectorStore(Protocol):
    def query(
        self, collection: str, embedding: list[float], top_k: int
    ) -> list[RetrievedChunk]: ...

    def count(self, collection: str) -> int: ...


class Embedder(Protocol):
    def embed_query(self, text: str) -> list[float]: ...


def distance_to_similarity(distance: float) -> float:
    """Converts a cosine DISTANCE into a similarity.

    A classic source of silent bugs: the store returns a distance, where
    SMALLER is more similar, while every threshold people write assumes a
    similarity, where LARGER is more similar. Compare a distance against a 0.35
    similarity threshold and the logic is exactly inverted -- the system
    confidently answers from irrelevant chunks and refuses the relevant ones,
    while every number on screen still looks plausible.

    For normalised vectors, cosine distance is 1 - cosine similarity.
    """
    return 1.0 - distance


def retrieve(
    *,
    query: str,
    collection: str,
    embedder: Embedder,
    store: VectorStore,
    top_k: int = 5,
    score_threshold: float = 0.51,
) -> RetrievalResult:
    """Embeds the question, fetches the nearest chunks, and decides groundedness.

    THE THRESHOLD IS THE POINT. Cosine similarity always returns a nearest
    neighbour -- there is no "no match". Ask about a product this help centre
    has never documented and five chunks come back, each with a score, all
    irrelevant, and nothing errors. Passing those to the model is precisely how
    a grounded system produces a confident, wrong answer.

    Refusing here is also the cheapest possible request: zero output tokens.
    """
    embedding = embedder.embed_query(query)
    chunks = store.query(collection, embedding, top_k)

    if not chunks:
        # An empty knowledge base, or every vector filtered out.
        return RetrievalResult(chunks=[], top_score=None, grounded=False)

    ranked = sorted(chunks, key=lambda chunk: chunk.score, reverse=True)
    top_score = ranked[0].score
    grounded = top_score >= score_threshold

    # When the answer is refused, the chunks are still returned so the caller
    # can log them. `top_score` is persisted on every message specifically so a
    # badly tuned threshold can be audited later -- it fails SILENTLY, showing
    # the user a polite refusal rather than an error, so nothing else would
    # ever record that it happened.
    return RetrievalResult(chunks=ranked, top_score=top_score, grounded=grounded)
