"""Estimated USD cost for archived GenAI spans.

OpenTelemetry records tokens and model, not dollars. Proofgrove prices those
signals with a list-rate book so tracing can show a dollar amount. The figure
is an estimate: list rates, not the Azure invoice or a tenant EA.

Preference order for one span:

1. A numeric cost already on the span (``llm.cost.total``, ``gen_ai.usage.cost``,
   ``gen_ai.cost.total``).
2. ``tokens × rate`` for a recognised model.
3. ``None`` when tokens or model are missing, or the model is unknown.
"""

from __future__ import annotations

from collections.abc import Mapping
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

# Public list USD per 1M tokens. Longest model-id prefix wins so
# ``gpt-4o-mini`` is not billed as ``gpt-4o``.
_RATES_PER_MILLION: dict[str, tuple[Decimal, Decimal]] = {
    "gpt-4o-mini": (Decimal("0.15"), Decimal("0.60")),
    "gpt-4o": (Decimal("2.50"), Decimal("10.00")),
    "gpt-4.1-nano": (Decimal("0.10"), Decimal("0.40")),
    "gpt-4.1-mini": (Decimal("0.40"), Decimal("1.60")),
    "gpt-4.1": (Decimal("2.00"), Decimal("8.00")),
    "gpt-4-turbo": (Decimal("10.00"), Decimal("30.00")),
    "gpt-4": (Decimal("30.00"), Decimal("60.00")),
    "gpt-3.5-turbo": (Decimal("0.50"), Decimal("1.50")),
    "gpt-5-mini": (Decimal("0.25"), Decimal("2.00")),
    "gpt-5.1": (Decimal("1.25"), Decimal("10.00")),
    "gpt-5": (Decimal("1.25"), Decimal("10.00")),
    "o1-mini": (Decimal("1.10"), Decimal("4.40")),
    "o1": (Decimal("15.00"), Decimal("60.00")),
    "o3-mini": (Decimal("1.10"), Decimal("4.40")),
    "o3": (Decimal("10.00"), Decimal("40.00")),
    "o4-mini": (Decimal("1.10"), Decimal("4.40")),
}

_RATES_BY_PREFIX = tuple(sorted(_RATES_PER_MILLION.items(), key=lambda item: len(item[0]), reverse=True))

_MODEL_KEYS = (
    "gen_ai.response.model",
    "gen_ai.request.model",
    "llm.model_name",
    "llm.response.model_name",
    "llm.request.model_name",
)
_PROMPT_KEYS = ("llm.token_count.prompt", "gen_ai.usage.input_tokens")
_COMPLETION_KEYS = ("llm.token_count.completion", "gen_ai.usage.output_tokens")
_RECORDED_COST_KEYS = ("llm.cost.total", "gen_ai.usage.cost", "gen_ai.cost.total")

_MILLION = Decimal("1000000")
_QUANTUM = Decimal("0.000001")


def _as_text(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _as_non_negative_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, float) and value >= 0 and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _as_non_negative_decimal(value: object) -> Decimal | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        parsed = Decimal(str(value))
    elif isinstance(value, str):
        text = value.strip().lstrip("$")
        if not text:
            return None
        try:
            parsed = Decimal(text)
        except Exception:  # noqa: BLE001 — refuse unparseable recorded costs
            return None
    else:
        return None
    # NaN/sNaN/Infinity all parse successfully but aren't a usable cost — and
    # comparing a Decimal NaN with `>=` raises InvalidOperation, so finiteness
    # must be checked before, not after, the sign check (short-circuits `or`).
    if not parsed.is_finite() or parsed < 0:
        return None
    return parsed


def span_model(attributes: Mapping[str, Any] | None) -> str | None:
    if not attributes:
        return None
    for key in _MODEL_KEYS:
        text = _as_text(attributes.get(key))
        if text:
            return text
    return None


def _token_count(attributes: Mapping[str, Any], keys: tuple[str, ...]) -> int | None:
    for key in keys:
        value = _as_non_negative_int(attributes.get(key))
        if value is not None:
            return value
    return None


def span_token_usage(attributes: Mapping[str, Any]) -> dict[str, int]:
    """Read this operation's recorded usage, preserving missing values and zero."""
    values = {
        "prompt_tokens": _token_count(attributes, _PROMPT_KEYS),
        "completion_tokens": _token_count(attributes, _COMPLETION_KEYS),
        "total_tokens": _token_count(attributes, ("llm.token_count.total", "gen_ai.usage.total_tokens")),
    }
    return {key: value for key, value in values.items() if value is not None}


def recorded_span_cost_usd(attributes: Mapping[str, Any] | None) -> float | None:
    """Return a producer-stamped cost when it is a non-negative number."""

    if not attributes:
        return None
    for key in _RECORDED_COST_KEYS:
        value = _as_non_negative_decimal(attributes.get(key))
        if value is None:
            continue
        try:
            return float(value.quantize(_QUANTUM, rounding=ROUND_HALF_UP))
        except InvalidOperation:
            # Finite but too large to quantize to the module's precision
            # (e.g. "1e100") — treat as unpriceable rather than raising.
            return None
    return None


def normalize_model_id(model: str) -> str:
    """Lowercase and strip a trailing dated snapshot (``gpt-4o-2024-08-06``)."""

    text = model.strip().lower()
    parts = text.rsplit("-", 3)
    if len(parts) == 4 and all(part.isdigit() for part in parts[1:]):
        return parts[0]
    return text


def rates_for_model(model: str) -> tuple[Decimal, Decimal] | None:
    identity = normalize_model_id(model)
    exact = _RATES_PER_MILLION.get(identity)
    if exact:
        return exact
    for prefix, rates in _RATES_BY_PREFIX:
        if identity == prefix or identity.startswith(f"{prefix}-") or identity.startswith(f"{prefix}."):
            return rates
    return None


def estimate_tokens_cost_usd(
    model: str | None,
    prompt_tokens: int | None,
    completion_tokens: int | None,
) -> float | None:
    """List-rate USD for a token pair, or None when the inputs cannot be priced."""

    if not model:
        return None
    rates = rates_for_model(model)
    if rates is None:
        return None
    prompt = prompt_tokens if prompt_tokens is not None else 0
    completion = completion_tokens if completion_tokens is not None else 0
    if prompt_tokens is None and completion_tokens is None:
        return None
    if prompt < 0 or completion < 0:
        return None
    input_rate, output_rate = rates
    total = (Decimal(prompt) * input_rate + Decimal(completion) * output_rate) / _MILLION
    return float(total.quantize(_QUANTUM, rounding=ROUND_HALF_UP))


def estimate_span_cost_usd(
    attributes: Mapping[str, Any] | None,
    *,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    model: str | None = None,
) -> float | None:
    """Recorded cost if present, otherwise a list-rate estimate from tokens."""

    recorded = recorded_span_cost_usd(attributes)
    if recorded is not None:
        return recorded
    attrs = attributes or {}
    return estimate_tokens_cost_usd(
        model if model is not None else span_model(attrs),
        prompt_tokens if prompt_tokens is not None else _token_count(attrs, _PROMPT_KEYS),
        completion_tokens if completion_tokens is not None else _token_count(attrs, _COMPLETION_KEYS),
    )


def sum_span_costs_usd(costs: list[float | None]) -> float | None:
    """Sum priced spans. None when no span could be priced."""

    priced = [value for value in costs if value is not None]
    if not priced:
        return None
    total = sum((Decimal(str(value)) for value in priced), Decimal("0"))
    return float(total.quantize(_QUANTUM, rounding=ROUND_HALF_UP))
