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

import json
from collections.abc import AsyncIterator, Callable
from typing import Protocol

import httpx

from app.config import settings

MetricsCallback = Callable[[dict], None]


class Generator(Protocol):
    def stream(
        self, system: str, messages: list[dict], on_metrics: MetricsCallback | None = None
    ) -> AsyncIterator[str]: ...


def ollama_options(value=settings) -> dict:
    """The generation options sent with every request."""
    options = {
        # Zero temperature for a grounded assistant. Creativity is the
        # mechanism by which a model departs from its sources, which is
        # exactly what INV-C forbids.
        "temperature": value.temperature,
        "num_predict": value.max_tokens,
    }
    if value.num_gpu is not None:
        options["num_gpu"] = value.num_gpu
    return options


def _ms(nanoseconds) -> float | None:
    return round(nanoseconds / 1e6, 1) if isinstance(nanoseconds, int | float) else None


def ollama_metrics(frame: dict) -> dict:
    """Ollama's own account of a request, from its final frame. Phase 14.

    It separates the three things time to first token is made of on this kind
    of server: loading the model into memory, reading the prompt, and then
    generating. Without it, a slow first token could be any of the three.
    Durations arrive in nanoseconds and leave in milliseconds.
    """
    return {
        "load_ms": _ms(frame.get("load_duration")),
        "prompt_tokens": frame.get("prompt_eval_count"),
        "prompt_eval_ms": _ms(frame.get("prompt_eval_duration")),
        "output_tokens": frame.get("eval_count"),
        "eval_ms": _ms(frame.get("eval_duration")),
        "total_ms": _ms(frame.get("total_duration")),
    }


class OllamaGenerator:
    """Local generation over Ollama's /api/chat streaming endpoint."""

    def __init__(
        self,
        base_url: str | None = None,
        model: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = (base_url or settings.ollama_base_url).rstrip("/")
        self.model = model or settings.model
        # A seam for tests. In production httpx chooses its own transport.
        self._transport = transport

    async def prime(self, system: str, messages: list[dict]) -> dict:
        """Loads the model and reads a prompt, generating one token. Phase 14.

        Called at startup with the start every answer's prompt shares, so the
        first customer does not wait for the model to load (16 s on the
        development machine) or for that start to be read (a further 20 s).
        Returns Ollama's metrics for the log.
        """
        payload = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, *messages],
            "stream": False,
            "keep_alive": settings.keep_alive,
            "options": {**ollama_options(), "num_predict": 1},
        }
        async with httpx.AsyncClient(timeout=settings.request_timeout_s, transport=self._transport) as client:
            response = await client.post(f"{self.base_url}/api/chat", json=payload)
            response.raise_for_status()
            return ollama_metrics(response.json())

    async def stream(
        self, system: str, messages: list[dict], on_metrics: MetricsCallback | None = None
    ) -> AsyncIterator[str]:
        payload = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, *messages],
            "stream": True,
            # Sent with every request, because Ollama applies the most recent
            # request's value: one without it would reset the model to unload
            # after Ollama's default five minutes.
            "keep_alive": settings.keep_alive,
            "options": ollama_options(),
        }

        async with httpx.AsyncClient(timeout=settings.request_timeout_s, transport=self._transport) as client:
            async with client.stream("POST", f"{self.base_url}/api/chat", json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
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
                        if on_metrics is not None:
                            on_metrics(ollama_metrics(frame))
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

    async def stream(
        self, system: str, messages: list[dict], on_metrics: MetricsCallback | None = None
    ) -> AsyncIterator[str]:
        self.calls.append((system, messages))
        for chunk in self.chunks:
            yield chunk
