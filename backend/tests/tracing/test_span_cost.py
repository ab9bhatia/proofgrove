"""List-rate span cost: recorded attributes win, then tokens × price book."""

import pytest

from evalhub.evaluation.models import ArchivedTraceSpan
from evalhub.tracing.cost import (
    estimate_span_cost_usd,
    estimate_tokens_cost_usd,
    normalize_model_id,
    rates_for_model,
    recorded_span_cost_usd,
    sum_span_costs_usd,
)
from evalhub.tracing.models import span_index_rows_from_spans, trace_stats_from_spans


def _span(
    trace_id: str,
    span_id: str,
    *,
    name: str = "span",
    attributes: dict | None = None,
    start_time_unix_nano: str | None = "1766000000000000000",
    end_time_unix_nano: str | None = "1766000001500000000",
) -> ArchivedTraceSpan:
    return ArchivedTraceSpan(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=None,
        name=name,
        kind=2,
        start_time_unix_nano=start_time_unix_nano,
        end_time_unix_nano=end_time_unix_nano,
        duration_ms=1500,
        status={"code": 1},
        attributes=attributes or {},
    )


def test_gpt4o_mini_is_not_priced_as_gpt4o():
    mini = rates_for_model("gpt-4o-mini")
    full = rates_for_model("gpt-4o")
    assert mini is not None and full is not None
    assert mini[0] < full[0]


def test_dated_snapshot_normalises_to_family():
    assert normalize_model_id("gpt-4o-2024-08-06") == "gpt-4o"
    assert rates_for_model("gpt-4o-2024-08-06") == rates_for_model("gpt-4o")


def test_unknown_model_is_unpriced():
    assert estimate_tokens_cost_usd("unknown-lab-model", 100, 10) is None


def test_tokens_times_rate_matches_list_price():
    # gpt-4o-mini: $0.15 / $0.60 per 1M → 1M in + 1M out = $0.75
    assert estimate_tokens_cost_usd("gpt-4o-mini", 1_000_000, 1_000_000) == 0.75


def test_recorded_cost_wins_over_the_price_book():
    attrs = {
        "gen_ai.request.model": "gpt-4o-mini",
        "gen_ai.usage.input_tokens": 1_000_000,
        "gen_ai.usage.output_tokens": 1_000_000,
        "llm.cost.total": "0.01",
    }
    assert recorded_span_cost_usd(attrs) == 0.01
    assert estimate_span_cost_usd(attrs) == 0.01


def test_span_index_row_stores_estimated_cost():
    span = _span(
        "t",
        "s",
        name="generate_content",
        attributes={
            "gen_ai.operation.name": "generate_content",
            "gen_ai.request.model": "gpt-4o-mini",
            "gen_ai.usage.input_tokens": "1000000",
            "gen_ai.usage.output_tokens": "1000000",
        },
    )
    row = span_index_rows_from_spans([span], limit=10)[0]
    assert row["estimated_cost_usd"] == 0.75


def test_trace_stats_sum_priced_spans_only():
    priced = _span(
        "t",
        "llm",
        attributes={
            "openinference.span.kind": "LLM",
            "gen_ai.request.model": "gpt-4o-mini",
            "gen_ai.usage.input_tokens": 1_000_000,
            "gen_ai.usage.output_tokens": 0,
        },
    )
    plumbing = _span("t", "http", name="connect", attributes={})
    stats = trace_stats_from_spans([priced, plumbing])
    assert stats.estimated_cost_usd == 0.15


def test_sum_none_when_nothing_priced():
    assert sum_span_costs_usd([None, None]) is None
    assert sum_span_costs_usd([0.01, None, 0.02]) == 0.03


# R3 — a recorded cost that parses but is non-finite (NaN/Infinity) or too
# large to quantize must be priced as "unavailable", never raise.
@pytest.mark.parametrize("raw", ["NaN", "sNaN", "Infinity", "-Infinity", "1e100"])
def test_non_finite_or_unquantizable_recorded_cost_strings_yield_no_cost(raw):
    attrs = {"llm.cost.total": raw}
    assert recorded_span_cost_usd(attrs) is None
    assert estimate_span_cost_usd(attrs) is None


@pytest.mark.parametrize("raw", [float("inf"), float("nan")])
def test_non_finite_float_recorded_cost_yields_no_cost(raw):
    assert recorded_span_cost_usd({"llm.cost.total": raw}) is None


def test_a_normal_recorded_cost_still_round_trips():
    assert recorded_span_cost_usd({"llm.cost.total": "1.23"}) == 1.23


def test_non_finite_recorded_cost_does_not_crash_trace_stats_or_span_index():
    span = _span("t", "s", attributes={"openinference.span.kind": "LLM", "llm.cost.total": "NaN"})
    stats = trace_stats_from_spans([span])
    assert stats.estimated_cost_usd is None
    rows = span_index_rows_from_spans([span], limit=10)
    assert rows[0]["estimated_cost_usd"] is None


# R4 — a producer-supplied start_time_unix_nano that a float-serialising OTLP
# exporter mangled (e.g. "1.7579e+18") or that is outright garbage must not
# abort the trace read, and must never be coerced into a fabricated instant.
def test_trace_stats_excludes_unparseable_start_timestamp_from_duration():
    good = _span("t", "a", attributes={"openinference.span.kind": "LLM"})
    bad = _span(
        "t",
        "b",
        attributes={"openinference.span.kind": "LLM"},
        start_time_unix_nano="1.7579e+18",
        end_time_unix_nano="garbage",
    )
    stats = trace_stats_from_spans([good, bad])
    assert stats.span_count == 2
    # Duration derives from the one parseable span only — a coerced 0 start
    # for the bad span would have fabricated a much larger duration instead.
    assert stats.duration_ms == 1500.0
