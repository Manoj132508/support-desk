"""Service configuration.

Nothing here has a secret default, and nothing here grants write access to
anything. The AI service holds no database credential at all -- that is not an
oversight to be fixed later, it is ADR 0002: this process cannot mutate
business data because it has no means to.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict

MIN_TOKEN_LENGTH = 32


class Settings(BaseSettings):
    # `env_ignore_empty`: a variable present but empty means "not set", as it
    # does when someone copies .env.example without filling everything in.
    # Without it, `AI_NUM_GPU=` stopped the service at import.
    model_config = SettingsConfigDict(env_prefix="AI_", extra="ignore", env_ignore_empty=True)

    # "production" makes the service refuse to run -- and refuse every call --
    # without a service token. Anything else is development, whose ports are
    # localhost-only. Phase 12.
    environment: str = "development"

    port: int = 8200
    kb_path: str = "data/kb"
    index_path: str = "data/index"
    collection: str = "helpcentre"

    # Retrieval. The threshold is the single most consequential number in the
    # service: too low and it answers from irrelevant chunks, too high and it
    # offers a person to customers whose question the help centre answers.
    #
    # 0.51 was chosen by the Phase 13 escalation eval, by Project 1's method:
    # selected on the tuning half of a labelled set, checked once on the
    # held-out half. Against the 0.35 inherited from Project 1, it offers a
    # person for 5 of 16 answerable questions, a mistake that fails safe. In
    # return, 2 out-of-scope questions are no longer answered from the help
    # centre, and 3 customers who needed a person are no longer deflected. The
    # evidence is thin (17 held-out turns). What no threshold can fix is in the
    # Phase 13 doc.
    top_k: int = 5
    score_threshold: float = 0.51
    # While the help centre has at most this many chunks, an answer's prompt
    # holds ALL of them in a fixed order, so every prompt starts identically and
    # the model reuses its reading of that start (ADR 0011). 10 chunks of at
    # most 800 characters stays near 2,000 tokens. Above it, the prompt is the
    # retrieved chunks by score, as before.
    full_context_max_chunks: int = 10
    chunk_size: int = 800
    chunk_overlap: int = 150

    # Generation. Provider-neutral; Ollama by default because it is free, local
    # and needs no API key.
    ollama_base_url: str = "http://localhost:11434"
    model: str = "llama3.1:8b"
    temperature: float = 0.0
    max_tokens: int = 600
    request_timeout_s: float = 120.0
    # How many model layers Ollama may put on a GPU. Unset lets Ollama decide,
    # which is right for a working GPU. 0 keeps the model entirely on the CPU:
    # the development machine's GPU faults under load (Phase 1 §8), so its
    # Phase 14 measurements were taken with AI_NUM_GPU=0.
    num_gpu: int | None = None
    # How long Ollama keeps the model loaded after a request. Its default is 5
    # minutes; after that the next customer waits for the model to load again
    # (16 s on the development machine) and for its prompt cache to be rebuilt.
    # The cost is the model's memory, held for this long after the last turn.
    keep_alive: str = "30m"

    # A shared secret between Express and this service, read from the same
    # AI_SERVICE_TOKEN variable the API sends. Not a user credential: it exists
    # so the AI service refuses calls that did not come from the API tier, since
    # it is not publicly routable and should not answer as though it were.
    service_token: str = ""

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


def startup_problems(value: Settings) -> list[str]:
    """What would make this configuration unsafe to run. Empty means nothing.

    Names settings, never their values, so the refusal message leaks nothing.
    """
    if not value.is_production:
        return []
    problems = []
    if len(value.service_token) < MIN_TOKEN_LENGTH:
        problems.append(f"AI_SERVICE_TOKEN must be at least {MIN_TOKEN_LENGTH} characters in production")
    return problems


settings = Settings()
