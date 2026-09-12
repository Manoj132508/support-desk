"""Deterministic stand-ins for the two heavy dependencies.

These exist because `retrieve()` takes an `Embedder` and a `VectorStore`
protocol, and `stream_answer()` takes a `Generator` protocol. Those seams were
in Project 1's design and they are the reason this whole suite runs in
milliseconds with no torch, no model download, and no network.

The fake embedder is a bag-of-words cosine. It is not a good embedder -- it has
no notion of synonyms -- but it is a REAL similarity function with real scores,
which is what the threshold logic needs to be exercised against. A fake that
returned fixed scores would test nothing about grounding.

STOP WORDS ARE REMOVED, and the first version of this file did not do that.
Without it, "what is the capital of peru" scored 0.48 against a help centre
about deliveries -- above the 0.35 threshold -- purely on "what is the of".
Every grounding test then passed for the wrong reason.

A real sentence embedder does not have that failure, because it represents
meaning rather than token overlap. So the omission made the double
unrepresentative of the thing it stands in for, which is the one way a test
double can quietly invalidate a suite. Filtering restores the property that
matters: unrelated questions score low.
"""

from __future__ import annotations

import math
import re

from app.pipeline.retrieval import RetrievedChunk

STOP_WORDS = frozenset(
    """
    a an and are as at be by can do does for from has have how i if in is it
    its of on or that the this to was what when where which who will with you
    your my me we our not no yes
    """.split()
)


def _tokens(text: str) -> list[str]:
    return [
        token for token in re.findall(r"[a-z0-9]+", text.lower()) if token not in STOP_WORDS
    ]


class BagOfWordsEmbedder:
    """Hashes tokens into a fixed-width vector and normalises it.

    Normalisation matters for the same reason it matters in the real embedder:
    the distance-to-similarity identity in retrieval.py assumes unit vectors.
    """

    def __init__(self, dimensions: int = 64) -> None:
        self.dimensions = dimensions

    def _embed(self, text: str) -> list[float]:
        vector = [0.0] * self.dimensions
        for token in _tokens(text):
            vector[hash(token) % self.dimensions] += 1.0
        norm = math.sqrt(sum(value * value for value in vector))
        if norm == 0:
            return vector
        return [value / norm for value in vector]

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._embed(text) for text in texts]


class InMemoryVectorStore:
    """Exact cosine search over a list. Correct, and fast enough for tests."""

    def __init__(self) -> None:
        self.vectors: dict[str, list[tuple[RetrievedChunk, list[float]]]] = {}

    def upsert(self, collection: str, chunks, embeddings: list[list[float]]) -> None:
        rows = self.vectors.setdefault(collection, [])
        existing = {chunk.chunk_id for chunk, _ in rows}
        for chunk, embedding in zip(chunks, embeddings, strict=True):
            retrieved = RetrievedChunk(
                chunk_id=chunk.chunk_id,
                document_id=chunk.document_id,
                document_name=chunk.document_name,
                section=chunk.section,
                text=chunk.text,
                score=0.0,
            )
            if chunk.chunk_id in existing:
                rows[:] = [row for row in rows if row[0].chunk_id != chunk.chunk_id]
            rows.append((retrieved, embedding))

    def query(self, collection: str, embedding: list[float], top_k: int) -> list[RetrievedChunk]:
        scored = []
        for chunk, vector in self.vectors.get(collection, []):
            score = sum(a * b for a, b in zip(embedding, vector, strict=True))
            scored.append(
                RetrievedChunk(
                    chunk_id=chunk.chunk_id,
                    document_id=chunk.document_id,
                    document_name=chunk.document_name,
                    section=chunk.section,
                    text=chunk.text,
                    score=score,
                )
            )
        scored.sort(key=lambda chunk: chunk.score, reverse=True)
        return scored[:top_k]

    def count(self, collection: str) -> int:
        return len(self.vectors.get(collection, []))
