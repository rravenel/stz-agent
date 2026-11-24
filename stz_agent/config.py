"""App-level configuration helpers (kept out of app.py so tests can import them)."""

from typing import Optional

MODEL_PROVIDERS = ("mock", "anthropic", "openai", "bedrock")


def validate_model_provider(provider: str) -> str:
    """Prime's MODEL_PROVIDER (models/config.ts adapterFromEnv)."""
    if provider not in MODEL_PROVIDERS:
        raise ValueError(f"model_provider {provider!r} must be one of {', '.join(MODEL_PROVIDERS)}")
    return provider


def spike_s1_enabled(env_name: str, ctx: Optional[str]) -> bool:
    """Spike S1 (#0020): only on request, never in the shared demo stack."""
    return env_name != "demo" and ctx == "on"
