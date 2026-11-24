"""App-level configuration helpers (kept out of app.py so tests can import them)."""

MODEL_PROVIDERS = ("mock", "anthropic", "openai", "bedrock")


def validate_model_provider(provider: str) -> str:
    """Prime's MODEL_PROVIDER (models/config.ts adapterFromEnv)."""
    if provider not in MODEL_PROVIDERS:
        raise ValueError(f"model_provider {provider!r} must be one of {', '.join(MODEL_PROVIDERS)}")
    return provider
