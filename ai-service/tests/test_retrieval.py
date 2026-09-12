"""INV-C: grounded, or silent.

The threshold is the single most consequential number in the service, so these
tests are about what happens either side of it.
"""

from __future__ import annotations

from app.pipeline.retrieval import RetrievalResult, RetrievedChunk, distance_to_similarity, retrieve
from tests.fakes import BagOfWordsEmbedder, InMemoryVectorStore


class _Chunk:
    def __init__(self, chunk_id, text):
        self.chunk_id = chunk_id
        self.document_id = "doc"
        self.document_name = "Doc"
        self.section = "Section"
        self.text = text


def _store_with(texts: dict[str, str]) -> tuple[BagOfWordsEmbedder, InMemoryVectorStore]:
    embedder = BagOfWordsEmbedder()
    store = InMemoryVectorStore()
    chunks = [_Chunk(chunk_id, text) for chunk_id, text in texts.items()]
    store.upsert("kb", chunks, embedder.embed_documents([c.text for c in chunks]))
    return embedder, store


def test_distance_to_similarity_inverts_the_scale():
    # The classic silent bug: a store returns a DISTANCE where smaller is
    # better, while every threshold assumes a SIMILARITY where larger is
    # better. Comparing one against the other inverts the entire decision --
    # the system answers from irrelevant chunks and refuses the relevant ones,
    # while every number on screen still looks plausible.
    assert distance_to_similarity(0.0) == 1.0
    assert distance_to_similarity(1.0) == 0.0
    assert distance_to_similarity(0.25) == 0.75


def test_a_close_match_is_grounded():
    embedder, store = _store_with(
        {"a": "orders can be cancelled before dispatch", "b": "delivery takes three days"}
    )
    result = retrieve(
        query="can I cancel before dispatch",
        collection="kb",
        embedder=embedder,
        store=store,
        score_threshold=0.35,
    )
    assert result.grounded is True
    assert result.chunks[0].chunk_id == "a"


def test_an_unrelated_question_is_not_grounded():
    # Cosine similarity ALWAYS returns a nearest neighbour. There is no "no
    # match", so without a threshold this returns chunks about cancellation for
    # a question about astronomy, and passing them to a model is precisely how
    # a grounded system produces a confident wrong answer.
    embedder, store = _store_with(
        {"a": "orders can be cancelled before dispatch", "b": "delivery takes three days"}
    )
    result = retrieve(
        query="what is the mass of jupiter",
        collection="kb",
        embedder=embedder,
        store=store,
        score_threshold=0.35,
    )
    assert result.grounded is False
    # The chunks come back anyway, so the caller can log WHAT was found
    # alongside the score that rejected it. A badly tuned threshold fails
    # silently -- a polite refusal, not an error -- so nothing else would record
    # that it happened.
    assert result.chunks != []
    assert result.top_score is not None


def test_an_empty_knowledge_base_is_not_grounded():
    embedder = BagOfWordsEmbedder()
    result = retrieve(
        query="anything", collection="kb", embedder=embedder, store=InMemoryVectorStore()
    )
    assert result.grounded is False
    assert result.top_score is None
    assert result.chunks == []


def test_the_threshold_is_the_decision():
    embedder, store = _store_with({"a": "orders can be cancelled before dispatch"})
    query = "delivery tracking number"

    permissive = retrieve(
        query=query, collection="kb", embedder=embedder, store=store, score_threshold=0.0
    )
    strict = retrieve(
        query=query, collection="kb", embedder=embedder, store=store, score_threshold=0.99
    )

    assert permissive.grounded is True
    assert strict.grounded is False
    # Same chunks, same scores, opposite decisions. The number is the policy.
    assert permissive.chunks[0].chunk_id == strict.chunks[0].chunk_id


def test_ungrounded_turns_escalate_rather_than_dead_end():
    # The project-specific half. Project 1 could stop at "not in your
    # documents"; a customer told that and left there has been DEFLECTED, which
    # is the failure this project measures.
    result = RetrievalResult(chunks=[], top_score=None, grounded=False)
    assert result.should_escalate is True

    grounded = RetrievalResult(
        chunks=[RetrievedChunk("a", "d", "D", None, "text", 0.9)], top_score=0.9, grounded=True
    )
    assert grounded.should_escalate is False


def test_results_are_ranked_best_first():
    embedder, store = _store_with(
        {
            "cancel": "cancel an order before dispatch cancellation",
            "delivery": "delivery options and tracking",
        }
    )
    result = retrieve(
        query="cancel cancellation dispatch", collection="kb", embedder=embedder, store=store
    )
    scores = [chunk.score for chunk in result.chunks]
    assert scores == sorted(scores, reverse=True)
