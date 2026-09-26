"""How often reviewers agreed with the judge — the counting rules.

This number is a trust signal, so its failure mode matters more than its
precision: a count that quietly rounds in the judge's favour is worse than no
count. These tests pin the two rules that decide that.
"""

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from proofgrove.db.models import (
    Base,
    EvaluationRunORM,
    ExperimentORM,
    FindingORM,
    MetricResultORM,
    ReviewDecisionORM,
    ReviewTaskORM,
)
from proofgrove.db.store import EvaluationStore

TENANT = "acme"


@pytest.fixture
async def store():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield EvaluationStore(session)
    await engine.dispose()


async def _case(store: EvaluationStore, metrics: dict[str, str]) -> str:
    """One run with one row, scoring each metric with the given execution status.

    A status of ``"measurement"`` records a scored row with no pass/fail
    threshold — what latency and token counts look like when nobody configured
    a limit for them.
    """
    session = store.session
    session.add(
        ExperimentORM(
            experiment_id="exp1",
            name="e",
            dataset_version="v1",
            target_endpoint="http://t",
            scenario="llm",
            tenant_id=TENANT,
        )
    )
    session.add(EvaluationRunORM(run_id="run1", experiment_id="exp1", status="completed"))
    for metric_id, execution_status in metrics.items():
        session.add(
            MetricResultORM(
                run_id="run1",
                metric_id=metric_id,
                evaluator_config_id="cfg",
                row_id="row1",
                dataset_version="v1",
                metric_status="scored",
                execution_status=("success" if execution_status == "measurement" else execution_status),
                score=4.0,
                normalised_score=0.8,
                threshold=0.5,
                threshold_result=(None if execution_status == "measurement" else "pass"),
                passed=(None if execution_status == "measurement" else True),
                executed_scorer="deepeval",
            )
        )
    await session.flush()
    return "run1"


async def _decide(store: EvaluationStore, metric_ids: list[str], outcome: str, *, suffix: str) -> None:
    session = store.session
    finding_id = f"f-{suffix}"
    session.add(
        FindingORM(
            finding_id=finding_id,
            run_id="run1",
            experiment_id="exp1",
            row_id="row1",
            metric_ids=metric_ids,
            gate_result="fail",
            severity="critical",
        )
    )
    session.add(ReviewTaskORM(task_id=f"t-{suffix}", finding_id=finding_id, tenant_id=TENANT))
    session.add(
        ReviewDecisionORM(
            decision_id=f"d-{suffix}",
            finding_id=finding_id,
            task_id=f"t-{suffix}",
            reviewer="someone",
            outcome=outcome,
            rationale="because",
        )
    )
    await session.flush()


@pytest.mark.asyncio
async def test_a_crashed_scorer_does_not_discard_other_metrics_on_the_same_row(store):
    """One broken scorer must not delete another metric's reviewed verdict.

    Excluding by (run, row) rather than (run, row, metric) dropped every finding
    on a row where anything errored — including a reviewer saying the judge was
    wrong about a metric that scored perfectly well. That silently moves the
    number in the judge's favour, which is the one direction it must not move.
    """
    await _case(store, {"llm.coherence": "success", "rag.retrieval_quality": "error"})
    await _decide(store, ["llm.coherence"], "disagree", suffix="coh")
    await _decide(store, ["rag.retrieval_quality"], "disagree", suffix="rq")

    by_metric = {row["metric_id"]: row for row in await store.judge_agreement_by_metric(TENANT)}

    # The reviewed disagreement on the metric that worked is counted...
    assert by_metric["llm.coherence"]["reviewed"] == 1
    assert by_metric["llm.coherence"]["agreed"] == 0
    # ...and the verdict on the crashed scorer is not evidence about the judge.
    assert "rag.retrieval_quality" not in by_metric


@pytest.mark.asyncio
async def test_abstaining_is_not_reported_as_a_multi_metric_exclusion(store):
    """An abstention has its own reason, and it is not "too many metrics".

    Counting it as ambiguous told the reader a true sentence about the wrong
    cause: the finding was skipped because the reviewer declined to judge, not
    because it covered more than one metric.
    """
    await _case(store, {"llm.coherence": "success", "llm.fluency": "success"})
    await _decide(store, ["llm.coherence", "llm.fluency"], "abstain", suffix="ab")

    assert await store.judge_agreement_by_metric(TENANT) == []


@pytest.mark.asyncio
async def test_a_case_opened_for_review_records_what_it_scored(store):
    """The review sheet reads `normalised_score`, so the finding must carry it.

    Writing the normalised value into `score` instead left every case sent for
    review reading "score not recorded" — the one number that separates
    "barely missed" from "nowhere near", and the whole reason a reviewer can
    judge the call without opening the run.
    """
    await _case(store, {"llm.coherence": "success"})

    finding, created = await store.open_case_for_review("run1", "row1", "llm.coherence")

    assert created is True
    detail = finding.evidence["failing_metric_details"][0]
    assert detail["metric_id"] == "llm.coherence"
    assert detail["normalised_score"] is not None
    assert detail["threshold"] is not None


@pytest.mark.asyncio
async def test_verdicts_are_split_by_the_scorer_that_produced_them(store):
    """"The judge" is not one thing over time.

    A metric that moves from the native judge to a framework keeps its id, so
    pooling by metric alone lets verdicts about the old implementation vouch
    for the new one — a metric could read "agreed 1 of 1" without a single one
    of those cases having been scored by the code running today.
    """
    await _case(store, {"llm.coherence": "success"})
    # A second scored result for the same metric, from a different scorer.
    session = store.session
    session.add(
        MetricResultORM(
            run_id="run1",
            metric_id="llm.coherence",
            evaluator_config_id="cfg",
            row_id="row2",
            dataset_version="v1",
            metric_status="scored",
            execution_status="success",
            executed_scorer="native",
            score=4.0,
            normalised_score=0.8,
            threshold=0.5,
            threshold_result="pass",
            passed=True,
        )
    )
    await session.flush()

    await _decide(store, ["llm.coherence"], "agree", suffix="deep")
    finding_id = "f-native"
    session.add(
        FindingORM(
            finding_id=finding_id,
            run_id="run1",
            experiment_id="exp1",
            row_id="row2",
            metric_ids=["llm.coherence"],
            gate_result="fail",
            severity="critical",
        )
    )
    session.add(ReviewTaskORM(task_id="t-native", finding_id=finding_id, tenant_id=TENANT))
    session.add(
        ReviewDecisionORM(
            decision_id="d-native",
            finding_id=finding_id,
            task_id="t-native",
            reviewer="someone",
            outcome="disagree",
            rationale="because",
        )
    )
    await session.flush()

    rows = await store.judge_agreement_by_metric(TENANT)
    by_scorer = {row["executed_scorer"]: row for row in rows}

    assert by_scorer["deepeval"]["agreed"] == 1
    assert by_scorer["deepeval"]["reviewed"] == 1
    assert by_scorer["native"]["agreed"] == 0
    assert by_scorer["native"]["reviewed"] == 1


@pytest.mark.asyncio
async def test_a_measurement_cannot_be_sent_for_review(store):
    """1.007 seconds is not right or wrong.

    Latency and token counts are recorded facts; a metric only carries a
    verdict when a threshold was configured for it. Opening one for review
    derived its gate from ``bool(None)`` — so a live audit turned a 1.007s
    latency reading into a CRITICAL failure of a check nobody had set.
    """
    await _case(store, {"ops.latency": "measurement"})

    with pytest.raises(ValueError, match="no pass/fail threshold"):
        await store.open_case_for_review("run1", "row1", "ops.latency")


@pytest.mark.asyncio
async def test_an_operational_check_with_a_real_threshold_stays_reviewable(store):
    """The guard refuses metrics with nothing to review, not operational ones.

    An operational metric someone configured a threshold for has a genuine
    verdict, and disagreeing with it is a real opinion about the judgement.
    """
    await _case(store, {"ops.latency": "success"})

    finding, created = await store.open_case_for_review("run1", "row1", "ops.latency")

    assert created is True
    assert finding.gate_result.value == "pass"


@pytest.mark.asyncio
async def test_a_verdict_on_a_measurement_is_not_counted_as_agreement(store):
    """Findings recorded before the guard existed must not move the figure."""
    await _case(store, {"ops.latency": "measurement"})
    await _decide(store, ["ops.latency"], "disagree", suffix="meas")

    assert await store.judge_agreement_by_metric(TENANT) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("span_first", [False, True])
async def test_case_review_and_agreement_ignore_span_scores(store, legacy, span_first):
    await _case(store, {"llm.coherence": "success"})
    case = (await store.session.scalars(select(MetricResultORM))).one()
    case.subject_kind = None if legacy else "case"
    case.span_id = "historical-span" if legacy else None
    case.rationale = "whole-case rationale"
    await store.session.flush()
    baseline, created = await store.open_case_for_review("run1", "row1", "llm.coherence")
    assert created
    expected_evidence = baseline.evidence
    # Remove only this test's task/finding so the mixed query must choose again.
    for task in (await store.session.scalars(select(ReviewTaskORM))).all():
        await store.session.delete(task)
    await store.session.delete(await store.session.get(FindingORM, baseline.finding_id))
    await store.session.flush()
    case_values = {column.name: getattr(case, column.name) for column in MetricResultORM.__table__.columns if column.name != "result_id"}
    await store.session.delete(case)
    await store.session.flush()
    span = MetricResultORM(**{**case_values, "subject_kind": "span", "trace_id": "trace", "span_id": "span",
                              "executed_scorer": "native", "score": 0.0, "normalised_score": 0.0,
                              "passed": False, "threshold_result": "fail", "rationale": "span rationale"})
    replacement_case = MetricResultORM(**case_values)
    for result in ([span, replacement_case] if span_first else [replacement_case, span]):
        store.session.add(result)
        await store.session.flush()
    finding, created = await store.open_case_for_review("run1", "row1", "llm.coherence")
    assert created
    assert finding.evidence == expected_evidence
    await _decide(store, ["llm.coherence"], "disagree", suffix="span-isolation")
    expected = [{"metric_id": "llm.coherence", "executed_scorer": "deepeval", "agreed": 0, "reviewed": 1, "ambiguous": 0}]
    assert await store.judge_agreement_by_metric(TENANT) == expected
    span.execution_status = "error"
    span.threshold_result = None
    await store.session.flush()
    assert await store.judge_agreement_by_metric(TENANT) == expected


@pytest.mark.asyncio
async def test_span_only_result_cannot_open_case_review(store):
    await _case(store, {"llm.coherence": "success"})
    span = (await store.session.scalars(select(MetricResultORM))).one()
    span.subject_kind, span.trace_id, span.span_id = "span", "trace", "span"
    await store.session.flush()
    with pytest.raises(ValueError, match="was not scored"):
        await store.open_case_for_review("run1", "row1", "llm.coherence")
    for model in (FindingORM, ReviewTaskORM):
        assert await store.session.scalar(select(func.count()).select_from(model)) == 0
