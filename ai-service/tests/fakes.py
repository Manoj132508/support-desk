"""Deterministic stand-ins for the two heavy dependencies.

These exist because `retrieve()` takes an `Embedder` and a `VectorStore`
protocol, and `stream_answer()` takes a `Generator` protocol. Those seams were
in Project 1's design and they are the reason this whole suite runs in
milliseconds with no torch, no model download, and no network.

The fake embedder is a bag-of-words cosine. It is not a good embedder -- it has
no notion of synonyms -- but it is a REAL similarity function with real scores,
which is what the threshold logic needs to be exercised against. A fake that
returned fixed scores would test nothing about grounding.

This file has now been wrong twice, and both times the suite was green.

1. STOP WORDS WERE NOT REMOVED. "what is the capital of peru" scored 0.48
   against a help centre about deliveries -- above the 0.35 threshold -- purely
   on "what is the of". Three grounding tests passed for the wrong reason. A
   real sentence embedder represents meaning rather than token overlap, so the
   double was unrepresentative of the thing it stands in for.

2. TOKENS WERE BUCKETED WITH PYTHON'S BUILT-IN `hash()`, which is salted
   randomly per process (PYTHONHASHSEED). With 64 buckets, which tokens
   collided changed on every run. The same commit passed 23/23 on one day and
   failed 4/23 two days later with no file changed; a sweep across fixed seeds
   confirmed it -- seeds 0 and 4 failed, the others passed.

   That is a flaky suite, and a flaky suite is worse than a failing one: it
   teaches everyone that red means "run it again". The fix is a content hash
   that gives a token the same bucket in every process on every machine, and
   enough buckets that collisions are rare rather than routine.

   Setting PYTHONHASHSEED in CI was the tempting alternative and was rejected.
   It would have made the symptom disappear in CI while leaving the double
   non-deterministic everywhere else -- on a developer's machine, in a new CI
   provider, in the eval harness that reuses this file. Hiding a
   nondeterminism is not the same as removing it.

   `test_fakes_determinism.py` guards this by spawning interpreters with
   different seeds, because inside a single process `hash()` is perfectly
   stable and no in-process test could ever have caught it.
"""

from __future__ import annotations

import hashlib
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


def stable_bucket(token: str, dimensions: int) -> int:
    """The same bucket for the same token in every process, on every machine.

    blake2b over the token's bytes, rather than `hash()`. It is not used for
    anything security-related here; it is used because its output depends only
    on its input, which is the one property the built-in lacked.
    """
    digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") % dimensions


class BagOfWordsEmbedder:
    """Hashes tokens into a fixed-width vector and normalises it.

    Normalisation matters for the same reason it matters in the real embedder:
    the distance-to-similarity identity in retrieval.py assumes unit vectors.

    1024 dimensions rather than 64. With the vocabulary of three help-centre
    articles, 64 buckets made collisions routine, and a collision is a fake
    similarity between two unrelated words -- noise the real embedder does not
    have.
    """

    def __init__(self, dimensions: int = 1024) -> None:
        self.dimensions = dimensions

    def _embed(self, text: str) -> list[float]:
        vector = [0.0] * self.dimensions
        for token in _tokens(text):
            vector[stable_bucket(token, self.dimensions)] += 1.0
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
