import math
from typing import Any


def sanitize_for_json(value: Any) -> Any:
    """Return a JSON-compatible tree with non-finite provider floats replaced by null."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: sanitize_for_json(child) for key, child in value.items()}
    if isinstance(value, list):
        return [sanitize_for_json(child) for child in value]
    if isinstance(value, tuple):
        return [sanitize_for_json(child) for child in value]
    return value
