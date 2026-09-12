"""Token generation, provider-neutral. Ported in shape from Project 1.

The Protocol is the point. Retrieval, prompt construction and the grounding
decision are all testable without a model, and this is the seam that keeps them
that way -- every test injects a scripted generator and asserts on what was
ASKED FOR rather than on what a model happened to say.

That matters more than usual here, because live inference is blocked on this
machine by a GPU CUDA fault (Phase 1 section 8). A design that could only be
verified by calling a model would be a design that could not be verified at
all right now.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

import httpx

from app.config import settings


class Generator(Protocol):
    def stream(self, system: str, messages: list[dict]) -> AsyncIterator[str]: ...


class OllamaGenerator:
    """Local generation over Ollama's /api/chat streaming endpoint."""

    def __init__(self, base_url: str | None = None, model: str | None = None) -> None:
        self.base_url = (base_url or settings.ollama_base_url).rstrip("/")
        self.model = model or settings.model

    async def stream(self, system: str, messages: list[dict]) -> AsyncIterator[str]:
        payload = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, *messages],
            "stream": True,
            "options": {
                # Zero temperature for a grounded assistant. Creativity is the
                # mechanism by which a model departs from its sources, which is
                # exactly what INV-C forbids.
                "temperature": settings.temperature,
                "num_predict": settings.max_tokens,
            },
        }

        async with httpx.AsyncClient(timeout=settings.request_timeout_s) as client:
            async with client.stream("POST", f"{self.base_url}/api/chat", json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    import json  # noqa: PLC0415

                    try:
                        frame = json.loads(line)
                    except json.JSONDecodeError:
                        # A malformed frame is worth skipping rather than
                        # killing a response the customer is already reading.
                        continue
                    token = frame.get("message", {}).get("content")
                    if token:
                        yield token
                    if frame.get("done"):
                        return


class ScriptedGenerator:
    """Yields a fixed sequence. Used by tests and by the offline fixtures the
    escalation eval runs against while live inference is unavailable.

    It records what it was called with, because the assertions worth making
    about a RAG pipeline are about the PROMPT -- did the sources reach the
    model, in the right order, with the right system rules -- not about the
    text a model returned.
    """

    def __init__(self, chunks: list[str]) -> None:
        self.chunks = chunks
        self.calls: list[tuple[str, list[dict]]] = []

    async def stream(self, system: str, messages: list[dict]) -> AsyncIterator[str]:
        self.calls.append((system, messages))
        for chunk in self.chunks:
            yield chunk
