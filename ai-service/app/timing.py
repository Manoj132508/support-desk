"""Where the time goes inside an advisory turn. NFR-1, Phase 14.

Express logs a turn from the customer's side of the boundary. This is the other
side: how long the plan took (recognising a request, embedding the question,
searching the index), when the first token was ready, and -- when a model was
called -- the model's own account of loading, reading the prompt and generating.
The two lines share a correlation id, which is what lets one slow turn be traced
across both processes.

Logged as one JSON line on stdout, with ids and durations only. The question is
never logged: NFR-4 keeps a customer's words out of anything that is not the
conversation itself.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable


class TurnClock:
    """Monotonic marks from the moment a turn arrived. The first mark of a name wins."""

    def __init__(self, now: Callable[[], float] = time.perf_counter) -> None:
        self._now = now
        self._start = now()
        self._marks: dict[str, float] = {}

    def mark(self, name: str) -> None:
        if name not in self._marks:
            self._marks[name] = self._now() - self._start

    def ms(self, name: str) -> float | None:
        value = self._marks.get(name)
        return None if value is None else round(value * 1000, 1)


def log_event(event: str, **fields) -> None:
    # print, not logging: uvicorn configures only its own loggers, and an app
    # logger at INFO would be silently discarded by the root logger's default
    # level. A measurement nobody can see is not a measurement.
    print(json.dumps({"level": "info", "event": event, **fields}), flush=True)
