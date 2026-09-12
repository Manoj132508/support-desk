"""Chroma-backed vector store. Ported from Project 1.

Lazy import, for the same reason as the embedder: nothing in the retrieval
logic needs a real store, because `retrieve()` takes a `VectorStore` protocol
and the tests inject an in-memory one.
"""

from __future__ import annotations

from app.pipeline.retrieval import RetrievedChunk, distance_to_similarity


class ChromaVectorStore:
    def __init__(self, path: str) -> None:
        import chromadb  # noqa: PLC0415

        self._client = chromadb.PersistentClient(path=path)

    def _collection(self, name: str):
        # cosine, explicitly. Chroma's default is L2, and the
        # distance-to-similarity conversion in retrieval.py assumes cosine.
        # Leaving it to the default would not error -- it would just make every
        # score mean something other than what the threshold expects.
        return self._client.get_or_create_collection(
            name=name, metadata={"hnsw:space": "cosine"}
        )

    def upsert(self, collection: str, chunks, embeddings: list[list[float]]) -> None:
        if not chunks:
            return
        self._collection(collection).upsert(
            ids=[chunk.chunk_id for chunk in chunks],
            embeddings=embeddings,
            documents=[chunk.text for chunk in chunks],
            metadatas=[
                {
                    "document_id": chunk.document_id,
                    "document_name": chunk.document_name,
                    # Chroma metadata values cannot be None.
                    "section": chunk.section or "",
                }
                for chunk in chunks
            ],
        )

    def query(self, collection: str, embedding: list[float], top_k: int) -> list[RetrievedChunk]:
        result = self._collection(collection).query(
            query_embeddings=[embedding],
            n_results=top_k,
            include=["documents", "metadatas", "distances"],
        )

        ids = result.get("ids", [[]])[0]
        documents = result.get("documents", [[]])[0]
        metadatas = result.get("metadatas", [[]])[0]
        distances = result.get("distances", [[]])[0]

        return [
            RetrievedChunk(
                chunk_id=chunk_id,
                document_id=metadata.get("document_id", ""),
                document_name=metadata.get("document_name", ""),
                section=metadata.get("section") or None,
                text=text,
                # The conversion happens HERE, at the boundary, so no caller
                # above this line ever handles a distance. One place to get the
                # inversion right.
                score=distance_to_similarity(distance),
            )
            for chunk_id, text, metadata, distance in zip(
                ids, documents, metadatas, distances, strict=False
            )
        ]

    def count(self, collection: str) -> int:
        return self._collection(collection).count()
