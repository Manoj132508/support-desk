"""Local sentence-transformers embeddings. Ported from Project 1.

THE IMPORT IS LAZY, AND THAT IS A DESIGN DECISION RATHER THAN A TRICK.

`sentence-transformers` pulls in torch and transformers -- roughly two
gigabytes, and several minutes to install. If this module imported them at the
top level, then every test in the suite, and every CI run, would need that
install before it could assert anything about chunking, prompt construction or
the grounding threshold -- none of which involve a model at all.

Deferring the import to construction means the seams do the work: `retrieve()`
takes an `Embedder` protocol, tests inject a deterministic fake, and the real
class is only touched when the service actually starts. The logic is proven in
milliseconds; the model download is an integration concern.
"""

from __future__ import annotations

DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


class SentenceTransformerEmbedder:
    def __init__(self, model_name: str = DEFAULT_MODEL) -> None:
        from sentence_transformers import SentenceTransformer  # noqa: PLC0415

        self.model_name = model_name
        self._model = SentenceTransformer(model_name)

    def embed_query(self, text: str) -> list[float]:
        # normalize_embeddings=True is load-bearing, not tidiness: the
        # distance-to-similarity conversion in retrieval.py assumes unit
        # vectors, where cosine distance is exactly 1 - cosine similarity.
        # Without normalisation that identity does not hold and every
        # threshold comparison is quietly wrong.
        return self._model.encode(text, normalize_embeddings=True).tolist()

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return self._model.encode(
            texts, normalize_embeddings=True, batch_size=32, show_progress_bar=False
        ).tolist()
