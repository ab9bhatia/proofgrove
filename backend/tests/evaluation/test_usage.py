"""Usage dashboard aggregates (#3334).

Against the real store: day bucketing over the window, tenant scoping, model
filtering, failed launches counted from jobs, and the honesty rules — an
unpriceable model is counted as unpriced (never a zero cost), a quiet day is a
genuine zero-run day, and days with no measurements report null latency/cost.
"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from proofgrove.db.models import (
    Base,
    EvaluationRunItemORM,
    EvaluationRunORM,
    ExperimentORM,
    RunJobORM,
)
from proofgrove.db.store import EvaluationStore
from proofgrove.settings import settings

OWNER = "tenant-usage"
NOW = datetime.now(UTC)


@pytest.fixture
async def store():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield EvaluationStore(session)
    await engine.dispose()


def _experiment(experiment_id: str, tenant: str = OWNER, model: str | None = "gpt-4.1-mini") -> ExperimentORM:
    return ExperimentORM(
        experiment_id=experiment_id,
        name=experiment_id,
        dataset_version="ds.v1",
        target_endpoint="https://gateway/v1",
        scenario="llm_core",
        judge_model="mock",
        tenant_id=tenant,
        target_version=model,
    )


def _run(run_id: str, experiment_id: str, *, started_days_ago: int = 0, status: str = "completed") -> EvaluationRunORM:
    return EvaluationRunORM(
        run_id=run_id,
        experiment_id=experiment_id,
        status=status,
        started_at=NOW - timedelta(days=started_days_ago),
    )


def _item(run_id: str, example_id: str, *, latency: int | None, usage: dict | None) -> EvaluationRunItemORM:
    return EvaluationRunItemORM(
        run_id=run_id,
        example_id=example_id,
        sequence_position=int(example_id.split("-")[-1]),
        dataset_version="ds.v1",
        latency_ms=latency,
        target_usage=usage,
        evidence_ref=f"evidence-pack://{run_id}/items/{example_id}",
        redaction_enabled=False,
        max_persisted_string_size=20000,
    )


async def _seed(store: EvaluationStore) -> None:
    session = store.session
    session.add(_experiment("exp-a"))
    session.add(_experiment("exp-b", model="private-llm"))
    session.add(_experiment("exp-foreign", tenant="tenant-other"))
    session.add(_run("run-a", "exp-a", started_days_ago=0))
    session.add(_run("run-b", "exp-b", started_days_ago=1))
    session.add(_run("run-foreign", "exp-foreign", started_days_ago=0))
    # Priceable cases on run-a; an unpriceable model and a missing latency on run-b.
    session.add(_item("run-a", "ex-1", latency=400, usage={"prompt_tokens": 100, "completion_tokens": 20, "model": "gpt-4.1-mini"}))
    session.add(_item("run-a", "ex-2", latency=600, usage={"prompt_tokens": 50, "completion_tokens": 10, "model": "gpt-4.1-mini"}))
    session.add(_item("run-b", "ex-1", latency=None, usage={"prompt_tokens": 30, "completion_tokens": 5, "model": "private-llm"}))
    # A failed launch never becomes a run row; it must still count.
    session.add(
        RunJobORM(
            run_id="job-failed",
            kind="eval",
            status="failed",
            tenant_id=OWNER,
            dataset_name="ds",
            response_source="llm",
            params={"target_model": "gpt-4.1-mini"},
            created_at=NOW,
        )
    )
    session.add(
        RunJobORM(
            run_id="job-foreign",
            kind="eval",
            status="failed",
            tenant_id="tenant-other",
            dataset_name="ds",
            response_source="llm",
            params={},
            created_at=NOW,
        )
    )
    await session.commit()


async def test_totals_days_and_honesty_rules(store: EvaluationStore) -> None:
    await _seed(store)
    usage = await store.usage_overview(OWNER, days=7)

    assert usage["window_days"] == 7
    assert len(usage["days"]) == 7

    totals = usage["totals"]
    assert totals["runs"] == 2  # the foreign tenant's run is invisible
    assert totals["failed_runs"] == 1
    assert totals["cases"] == 3
    assert totals["prompt_tokens"] == 180
    assert totals["completion_tokens"] == 35
    # gpt cases priced; the private-llm case counted, never zero-priced.
    assert totals["estimated_cost_usd"] is not None and totals["estimated_cost_usd"] > 0
    assert totals["unpriced_cases"] == 1
    assert totals["latency_ms_p50"] is not None

    today = NOW.date().isoformat()
    today_bucket = next(day for day in usage["days"] if day["date"] == today)
    assert today_bucket["runs"] == 1
    assert today_bucket["failed_runs"] == 1
    assert today_bucket["cases"] == 2
    assert today_bucket["latency_ms_p50"] == 500
    assert today_bucket["latency_ms_p90"] >= 500

    # A quiet day is a real zero-run day with null measurements, not zeros.
    quiet = next(day for day in usage["days"] if day["runs"] == 0 and day["failed_runs"] == 0)
    assert quiet["cases"] == 0
    assert quiet["latency_ms_p50"] is None
    assert quiet["estimated_cost_usd"] is None

    assert usage["models"] == ["gpt-4.1-mini", "private-llm"]
    assert [run["run_id"] for run in usage["recent_runs"]] == ["run-a", "run-b"]
    assert [job["run_id"] for job in usage["failed_launches"]] == ["job-failed"]


async def test_model_filter_narrows_every_figure(store: EvaluationStore) -> None:
    await _seed(store)
    usage = await store.usage_overview(OWNER, days=7, target_model="private-llm")
    totals = usage["totals"]
    assert totals["runs"] == 1
    assert [run["run_id"] for run in usage["recent_runs"]] == ["run-b"]
    assert usage["failed_launches"] == []
    assert totals["failed_runs"] == 0  # the failed job named gpt-4.1-mini
    assert totals["cases"] == 1
    assert totals["estimated_cost_usd"] is None  # nothing priceable in this slice
    assert totals["unpriced_cases"] == 1
    assert totals["latency_ms_p50"] is None  # its only case has no latency


async def test_unpriced_day_reports_null_cost_not_zero(store: EvaluationStore) -> None:
    await _seed(store)
    usage = await store.usage_overview(OWNER, days=7, target_model="private-llm")
    yesterday = (NOW - timedelta(days=1)).date().isoformat()
    bucket = next(day for day in usage["days"] if day["date"] == yesterday)
    assert bucket["cases"] == 1
    assert bucket["estimated_cost_usd"] is None
    assert bucket["unpriced_cases"] == 1


async def test_totals_equal_the_sum_of_days(store: EvaluationStore) -> None:
    """The invariant behind AC 6 — nothing counted in totals may miss every day bucket."""
    await _seed(store)
    session = store.session
    # A run at the very edge of the window must land in the earliest bucket.
    session.add(_experiment("exp-edge"))
    session.add(_run("run-edge", "exp-edge", started_days_ago=6))
    session.add(_item("run-edge", "ex-1", latency=100, usage={"prompt_tokens": 10, "completion_tokens": 2, "model": "gpt-4.1-mini"}))
    await session.commit()

    usage = await store.usage_overview(OWNER, days=7)
    for key in ("runs", "failed_runs", "cases", "prompt_tokens", "completion_tokens"):
        assert usage["totals"][key] == sum(day[key] for day in usage["days"]), key
    assert usage["totals"]["runs"] == 3


async def test_model_filter_never_collapses_the_model_list(store: EvaluationStore) -> None:
    await _seed(store)
    usage = await store.usage_overview(OWNER, days=7, target_model="private-llm")
    assert usage["models"] == ["gpt-4.1-mini", "private-llm"]


async def test_case_without_usage_is_counted_not_zeroed(store: EvaluationStore) -> None:
    await _seed(store)
    session = store.session
    session.add(_item("run-a", "ex-3", latency=200, usage=None))
    await session.commit()
    usage = await store.usage_overview(OWNER, days=7)
    assert usage["totals"]["cases_without_usage"] == 1
    assert usage["totals"]["prompt_tokens"] == 180  # unchanged by the unmeasured case


async def test_deferred_run_that_later_failed_is_not_double_counted(store: EvaluationStore) -> None:
    await _seed(store)
    session = store.session
    # The job shares its run_id with a persisted run row (deferred telemetry
    # path): it must not also count as a failed launch.
    session.add(
        RunJobORM(
            run_id="run-a",
            kind="eval",
            status="failed",
            tenant_id=OWNER,
            dataset_name="ds",
            response_source="llm",
            params={"target_model": "gpt-4.1-mini"},
            created_at=NOW,
        )
    )
    await session.commit()
    usage = await store.usage_overview(OWNER, days=7)
    assert usage["totals"]["failed_runs"] == 1  # only the genuine failed launch


async def test_empty_window_is_all_zero_days(store: EvaluationStore) -> None:
    usage = await store.usage_overview(OWNER, days=3)
    assert usage["totals"]["runs"] == 0
    assert usage["totals"]["estimated_cost_usd"] is None
    assert all(day["runs"] == 0 and day["latency_ms_p50"] is None for day in usage["days"])
    assert usage["models"] == []


async def test_24h_window_buckets_hourly_and_totals_still_sum(store: EvaluationStore) -> None:
    await _seed(store)
    usage = await store.usage_overview(OWNER, window="24h")

    assert usage["window"] == "24h"
    assert usage["bucket"] == "hour"
    assert len(usage["days"]) == 24
    # Hour keys, and the newest bucket is the current hour.
    assert all(len(day["date"]) == 16 and day["date"][13:] == ":00" for day in usage["days"])
    assert usage["days"][-1]["date"] == NOW.strftime("%Y-%m-%dT%H:00")
    # run-b started ~24h ago and may fall outside the hour-anchored window;
    # whatever is counted must land in a bucket — the sum invariant holds hourly.
    for key in ("runs", "failed_runs", "cases", "prompt_tokens", "completion_tokens"):
        assert usage["totals"][key] == sum(day[key] for day in usage["days"]), key
    assert usage["totals"]["failed_runs"] == 1  # today's failed launch is inside 24h


async def test_previous_period_totals_do_not_overlap(store: EvaluationStore) -> None:
    await _seed(store)
    session = store.session
    # Plant activity squarely in the previous 7-day window (8-13 days ago).
    session.add(_experiment("exp-prev"))
    session.add(_run("run-prev", "exp-prev", started_days_ago=9))
    session.add(_item("run-prev", "ex-1", latency=300, usage={"prompt_tokens": 40, "completion_tokens": 8, "model": "gpt-4.1-mini"}))
    await session.commit()

    usage = await store.usage_overview(OWNER, window="7d")
    assert usage["totals"]["runs"] == 2  # run-prev is not in the current window
    assert usage["previous_totals"]["runs"] == 1
    assert usage["previous_totals"]["cases"] == 1
    assert usage["previous_totals"]["prompt_tokens"] == 40
    # And a window with an empty predecessor reports honest zeros, not None rows.
    wide = await store.usage_overview(OWNER, window="90d")
    assert wide["previous_totals"]["runs"] == 0
    assert wide["previous_totals"]["estimated_cost_usd"] is None


async def test_deferred_dedup_holds_in_previous_window(store: EvaluationStore) -> None:
    session = store.session
    session.add(_experiment("exp-prev"))
    session.add(_run("run-prev", "exp-prev", started_days_ago=9))
    # Deferred job sharing the previous-window run's id: not a failed launch there either.
    session.add(
        RunJobORM(
            run_id="run-prev",
            kind="eval",
            status="failed",
            tenant_id=OWNER,
            dataset_name="ds-prev",
            response_source="llm",
            params={},
            created_at=NOW - timedelta(days=9),
        )
    )
    await session.commit()
    usage = await store.usage_overview(OWNER, window="7d")
    assert usage["previous_totals"]["runs"] == 1
    assert usage["previous_totals"]["failed_runs"] == 0


async def test_leaderboards_rank_cap_and_skip_null_agent(store: EvaluationStore) -> None:
    await _seed(store)
    session = store.session
    # Seven distinct datasets to exercise the top-5 cap; two carry agents.
    for index in range(7):
        session.add(
            RunJobORM(
                run_id=f"job-ds-{index}",
                kind="eval",
                status="completed" if index % 2 else "failed",
                tenant_id=OWNER,
                dataset_name=f"dataset-{index}",
                response_source="agent" if index < 2 else "llm",
                agent=f"tenant/agent-{index}" if index < 2 else None,
                params={},
                created_at=NOW - timedelta(hours=index),
            )
        )
    await session.commit()

    usage = await store.usage_overview(OWNER, window="7d")
    top_datasets = usage["top_datasets"]
    assert len(top_datasets["rows"]) == 5
    assert top_datasets["others"] >= 2  # dataset-5, dataset-6 and the seed's "ds" compete
    assert all(row["attempts"] >= 1 for row in top_datasets["rows"])
    # Null-agent jobs are skipped, not rendered as an "unknown" row.
    agent_names = [row["name"] for row in usage["top_agents"]["rows"]]
    assert agent_names == ["tenant/agent-0", "tenant/agent-1"]
    failed_by_name = {row["name"]: row["failed_attempts"] for row in usage["top_datasets"]["rows"]}
    assert failed_by_name.get("dataset-0") == 1  # status=failed counted as failed attempt

    top_models = usage["top_models"]
    assert [row["name"] for row in top_models["rows"]][0] == "gpt-4.1-mini"
    gpt = top_models["rows"][0]
    assert gpt["cases"] == 2 and gpt["tokens"] == 180 and gpt["estimated_cost_usd"] is not None
    assert gpt["unpriced_cases"] == 0
    private = next(row for row in top_models["rows"] if row["name"] == "private-llm")
    assert private["estimated_cost_usd"] is None  # unpriceable stays null, never zero
    assert private["unpriced_cases"] == 1


async def test_provider_reported_model_variant_does_not_split_the_leaderboard(store: EvaluationStore) -> None:
    """Providers return dated ids ("gpt-4.1-mini-2025-04-14"); rows key on the configured model."""
    await _seed(store)
    session = store.session
    session.add(_item("run-a", "ex-9", latency=150, usage={"prompt_tokens": 10, "completion_tokens": 5, "model": "gpt-4.1-mini-2025-04-14"}))
    await session.commit()

    usage = await store.usage_overview(OWNER, window="7d")
    names = [row["name"] for row in usage["top_models"]["rows"]]
    assert "gpt-4.1-mini-2025-04-14" not in names  # pricing detail, never a row key
    gpt = next(row for row in usage["top_models"]["rows"] if row["name"] == "gpt-4.1-mini")
    assert gpt["cases"] == 3  # the dated-variant case counts under its configured model
    # And every leaderboard name exists in the filter dropdown's vocabulary.
    assert set(names) <= set(usage["models"])


async def test_deferred_failed_job_is_not_a_failed_attempt_in_breakdowns(store: EvaluationStore) -> None:
    await _seed(store)
    session = store.session
    session.add(
        RunJobORM(
            run_id="run-a",  # shares its id with a persisted run row
            kind="eval",
            status="failed",
            tenant_id=OWNER,
            dataset_name="ds-deferred",
            response_source="llm",
            params={},
            created_at=NOW,
        )
    )
    await session.commit()
    usage = await store.usage_overview(OWNER, window="7d")
    deferred = next(row for row in usage["top_datasets"]["rows"] if row["name"] == "ds-deferred")
    assert deferred["attempts"] == 1
    assert deferred["failed_attempts"] == 0  # its run row exists — not a failure


async def test_leaderboards_follow_the_model_filter(store: EvaluationStore) -> None:
    await _seed(store)
    usage = await store.usage_overview(OWNER, days=7, target_model="private-llm")
    names = [row["name"] for row in usage["top_models"]["rows"]]
    assert names == ["private-llm"]
    assert usage["top_datasets"]["rows"] == []
    assert usage["top_agents"]["rows"] == []
    assert usage["totals"]["runs"] == 1  # the filter still narrows the totals


async def test_measured_zero_is_distinct_from_missing_token_half(store: EvaluationStore) -> None:
    session = store.session
    session.add(_experiment("exp-zero"))
    session.add(_run("run-zero", "exp-zero"))
    session.add(_item("run-zero", "ex-1", latency=0, usage={"prompt_tokens": 0}))
    await session.commit()
    totals = (await store.usage_overview(OWNER, window="7d"))["totals"]
    assert totals["prompt_measured_cases"] == 1
    assert totals["completion_measured_cases"] == 0
    assert totals["prompt_tokens"] == 0
    assert totals["estimated_cost_usd"] is None


async def test_daily_counts_match_paginated_history_for_tenant_aliases(store: EvaluationStore, monkeypatch) -> None:
    """History and usage include both accepted tenant spellings, never outsiders."""
    monkeypatch.setattr(settings, "pod_namespace", OWNER)
    await _seed(store)
    store.session.add(_experiment("exp-alias", tenant="usage"))
    store.session.add(_run("run-alias", "exp-alias"))
    await store.session.commit()
    runs = []
    while True:
        page, total = await store.list_runs_page(tenant_id=OWNER, limit=1, offset=len(runs))
        runs.extend(page)
        if len(runs) >= total:
            break
        assert page
    assert {run.run_id for run in runs} == {"run-a", "run-b", "run-alias"}
    for model in (None, "gpt-4.1-mini", "private-llm"):
        usage = await store.usage_overview(OWNER, window="7d", target_model=model)
        for bucket in usage["days"]:
            expected = sum(
                run.started_at.date().isoformat() == bucket["date"]
                and (model is None or run.experiment.target_version == model)
                for run in runs
            )
            assert bucket["runs"] == expected
