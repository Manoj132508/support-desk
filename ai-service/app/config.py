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
    model_config = SettingsConfigDict(env_prefix="AI_", extra="ignore")

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
    # deflects customers who had answerable questions. Tuned against a held-out
    # set in Phase 13, exactly as Project 1 did -- not guessed here.
    top_k: int = 5
    score_threshold: float = 0.35
    chunk_size: int = 800
    chunk_overlap: int = 150

    # Generation. Provider-neutral; Ollama by default because it is free, local
    # and needs no API key.
    ollama_base_url: str = "http://localhost:11434"
    model: str = "llama3.1:8b"
    temperature: float = 0.0
    max_tokens: int = 600
    request_timeout_s: float = 120.0

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
