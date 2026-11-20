"""App-level configuration helpers (kept out of app.py so tests can import them)."""

import os
from typing import Optional

BUILD_PLACEHOLDER_TOKEN = "build-placeholder"


def resolve_api_token(env_name: str, ctx_token: Optional[str]) -> str:
    """Pick Doorman's bearer token: context, then STZ_API_TOKEN, then a placeholder
    for the pinned "build" synth only. Any other env without a token is an error."""
    token = ctx_token or os.getenv("STZ_API_TOKEN")
    if token:
        return token
    if env_name == "build":
        return BUILD_PLACEHOLDER_TOKEN
    raise ValueError("set STZ_API_TOKEN or -c api_token=…")
