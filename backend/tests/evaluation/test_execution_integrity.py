"""Execution-integrity guarantees: launch-frozen applicability, worker
revalidation of resolved requirements/provenance, and row_count-before-readiness.
"""

import logging

import pytest

from evalhub.evaluation import readiness as readiness_module
from evalhub.evaluation import run_service
from evalhub.evaluation.engine import EvaluationEngine
from evalhub.evaluation.enums import (
    EvaluationScope,
    EvidenceCaptureStatus,
    EvidenceCategoryStatus,
    MetricApplicability,
    MetricRequirement,
    MetricRequirementSource,
    MetricStatus,
    ProvenanceStatus,
    Scenario,
    UnscoredReason,
    VerdictStatus,
)
from evalhub.evaluation.llm_judge import JudgeResult
from evalhub.evaluation.models import EvaluationRow, EvidenceCategorySummary
from evalhub.evaluation.readiness import ReadinessBlockedError
from evalhub.evaluation.report import build_ci_callback
from evalhub.evaluation.run_service import execute_dataset_run
from evalhub.evaluation.sample_data import SAMPLE_EXPERIMENTS, get_sample_rows
from evalhub.evaluation.target.discovery import AgentSummary
from evalhub.platform.contracts import (
    ResolvedMetricRequirement,
    ResolvedScoringConfiguration,
)


class _FakeInfo:
    version_number = 1
    product_id = "product-x"
    tenant_id = "tenant-x"
    status = "PUBLISHED"


class _FakeRegistry:
    def __init__(self, records):
        self._records = records

    def get_dataset(self, name, tenant_id=None):
        return _FakeInfo()

    def get_records(self, name, tenant_id=None):
        return self._records


class _CaptureStore:
    def __init__(self):
        self.saved = None

    async def save_run(self, result, rows):
        self.saved = (result, rows)


class _ScoredTestJudge:
    def evaluate(self, config, row):
        return JudgeResult(1.0, None, "scored test result", 0, 0, executed_scorer="native")


def _engine() -> EvaluationEngine:
    return EvaluationEngine(judge=_ScoredTestJudge())


def _provided_records(n: int = 2) -> list[dict]:
    return [
        {
            "dataset_record_id": f"r{i}",
            "inputs": {"query": f"question {i}", "context": [f"context {i}"]},
            "expectations": {
                "response": f"provided answer {i}",
                "expected_output": f"expected answer {i}",
            },
        }
        for i in range(1, n + 1)
    ]


# ---------------------------------------------------------------------------
# 1. Pre-run applicability is frozen into scoring execution
# ---------------------------------------------------------------------------


def test_engine_excludes_pre_run_not_applicable_metrics_from_scoring():
    """A metric frozen as known-N/A at launch must not be scored, and the
    frozen reason must be recorded on its results."""

    engine = _engine()
    rows = get_sample_rows("exp-llm-core-v1")[:2]
    result = engine.execute(
        SAMPLE_EXPERIMENTS[0],
        rows,
        metric_ids=["llm.relevance", "rag.groundedness"],
        pre_run_not_applicable={"rag.groundedness": "No retrieval stage is present for this target."},
    )

    rag_results = [m for m in result.metric_results if m.metric_id == "rag.groundedness"]
    assert rag_results, "excluded metric must still be recorded per row"
    for mr in rag_results:
        assert mr.metric_applicability == MetricApplicability.NOT_APPLICABLE
        assert mr.metric_status is None
        assert mr.score is None
        assert mr.execution_status == "not_applicable"
        assert mr.execution_metadata["reason"] == "No retrieval stage is present for this target."
        assert mr.execution_metadata["applicability_source"] == "pre_run_readiness"

    relevance_results = [m for m in result.metric_results if m.metric_id == "llm.relevance"]
    assert relevance_results
    assert all(mr.metric_status == MetricStatus.SCORED for mr in relevance_results)


@pytest.mark.asyncio
async def test_dataset_run_freezes_known_not_applicable_metrics():
    """A metric readiness classifies known-N/A at launch is excluded from
    scoring for the run and recorded with its reason."""

    store = _CaptureStore()
    await execute_dataset_run(
        run_id="run-frozen-na",
        dataset_name="ds",
        response_source="provided",
        agent=None,
        row_count=None,
        judge_model=None,
        resolved_active_metrics=["llm.relevance", "rag.groundedness", "nlp.f1_score"],
        enable_llm_judge=False,
        store=store,
        engine=_engine(),
        registry=_FakeRegistry(_provided_records()),
    )

    assert store.saved is not None
    result, rows = store.saved
    assert len(rows) == 2
    rag_results = [m for m in result.metric_results if m.metric_id == "rag.groundedness"]
    assert rag_results
    for mr in rag_results:
        assert mr.metric_applicability == MetricApplicability.NOT_APPLICABLE
        assert mr.score is None
        assert mr.execution_metadata["reason"] == "No retrieval stage is present for this target."
    relevance_results = [m for m in result.metric_results if m.metric_id == "llm.relevance"]
    assert relevance_results
    assert all(mr.metric_status == MetricStatus.UNSCORED for mr in relevance_results)
    assert all(mr.unscored_reason.value == "simulated" for mr in relevance_results)
    deterministic_results = [m for m in result.metric_results if m.metric_id == "nlp.f1_score"]
    assert deterministic_results
    assert all(mr.metric_status == MetricStatus.SCORED for mr in deterministic_results)
    assert all(mr.executed_scorer == "deterministic" for mr in deterministic_results)


@pytest.mark.asyncio
async def test_provided_run_uses_stored_responses_without_target_execution(monkeypatch):
    async def _must_not_invoke(*args, **kwargs):
        raise AssertionError("provided runs must not invoke a target")

    monkeypatch.setattr(run_service, "_run_agent_rows", _must_not_invoke)
    monkeypatch.setattr(run_service, "_run_llm_rows", _must_not_invoke)
    store = _CaptureStore()

    await execute_dataset_run(
        run_id="run-provided",
        dataset_name="ds",
        response_source="provided",
        agent=None,
        row_count=None,
        judge_model=None,
        resolved_active_metrics=[
            "nlp.f1_score",
            "ops.latency",
            "ops.total_token_count",
            "ops.token_efficiency",
        ],
        enable_llm_judge=False,
        store=store,
        engine=_engine(),
        registry=_FakeRegistry(_provided_records()),
    )

    assert store.saved is not None
    result, rows = store.saved
    assert [row.response for row in rows] == ["provided answer 1", "provided answer 2"]
    final_output = next(
        category for category in result.evidence_categories
        if category.category == "final_output"
    )
    assert final_output.provenance_status == ProvenanceStatus.SELF_REPORTED
    assert final_output.provenance_source == "dataset declaration"
    for metric in result.metric_results:
        if metric.metric_id.startswith("ops."):
            assert metric.metric_status == MetricStatus.UNSCORED
            assert metric.unscored_reason == UnscoredReason.EVIDENCE_UNAVAILABLE
            assert metric.score is None


# ---------------------------------------------------------------------------
# 2. Worker revalidation uses the resolved requirements and provenance
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_worker_revalidation_blocks_when_required_metric_is_not_applicable():
    """The frozen scoring configuration's REQUIRED classification must feed the
    worker's readiness revalidation: a required metric that is known-N/A blocks
    the run instead of being scored (or silently dropped)."""

    store = _CaptureStore()
    scoring_configuration = ResolvedScoringConfiguration(
        configuration_id="cfg-1",
        configuration_hash="hash-1",
        scenario=Scenario.LLM_CORE,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
        metric_ids=["llm.relevance", "rag.groundedness"],
        metric_requirements=[
            ResolvedMetricRequirement(
                metric_id="llm.relevance",
                requirement=MetricRequirement.REQUIRED,
                source=MetricRequirementSource.EXPLICIT_SELECTION,
            ),
            ResolvedMetricRequirement(
                metric_id="rag.groundedness",
                requirement=MetricRequirement.REQUIRED,
                source=MetricRequirementSource.QUALITY_CONTRACT,
            ),
        ],
    )

    with pytest.raises(ReadinessBlockedError) as excinfo:
        await execute_dataset_run(
            run_id="run-blocked-req",
            dataset_name="ds",
            response_source="provided",
            agent=None,
            row_count=None,
            judge_model=None,
            resolved_scoring_configuration=scoring_configuration.model_dump(mode="json"),
            enable_llm_judge=False,
            store=store,
            engine=_engine(),
            registry=_FakeRegistry(_provided_records()),
        )

    assert store.saved is None
    codes = {detail.code for detail in excinfo.value.readiness.details}
    assert "contract_metric_not_applicable" in codes


@pytest.mark.asyncio
async def test_worker_revalidation_blocks_on_target_revision_drift(monkeypatch):
    """The launch-resolved provenance (agent revision) must anchor the worker's
    drift check; a revision change between launch and execution blocks the run
    before the target is invoked."""

    async def _fake_list(*args, **kwargs):
        return [
            AgentSummary(
                id="ns/agent-a",
                name="agent-a",
                namespace="ns",
                ready=True,
                accepted=True,
                agent_type="Declarative",
                revision="rev-2",
                tools=["some-tool"],
            )
        ]

    monkeypatch.setattr(readiness_module, "list_tenant_agents", _fake_list)

    async def _must_not_invoke(*args, **kwargs):
        raise AssertionError("target must not be invoked when provenance drifted")

    monkeypatch.setattr(run_service, "run_agent_target", _must_not_invoke)

    records = [
        {
            "dataset_record_id": "r1",
            "inputs": {"query": "question 1"},
            "expectations": {"expected_output": "answer 1"},
        }
    ]
    store = _CaptureStore()
    with pytest.raises(ReadinessBlockedError) as excinfo:
        await execute_dataset_run(
            run_id="run-drift",
            dataset_name="ds",
            response_source="agent",
            agent="ns/agent-a",
            row_count=None,
            judge_model=None,
            resolved_active_metrics=["llm.relevance"],
            enable_llm_judge=False,
            store=store,
            engine=_engine(),
            registry=_FakeRegistry(records),
            evidence_readiness_snapshot={
                "resolved_provenance": {
                    "target_type": "agent",
                    "identifier": "ns/agent-a",
                    "revision": "rev-1",
                    "status": "attested",
                }
            },
            requested_provenance={
                "target_type": "agent",
                "identifier": "ns/agent-a",
                "revision": None,
            },
        )

    assert store.saved is None
    codes = {detail.code for detail in excinfo.value.readiness.details}
    assert "target_drift" in codes


# ---------------------------------------------------------------------------
# 3. row_count is applied before readiness analysis
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_row_count_limits_rows_before_readiness_analysis():
    """Readiness must analyze exactly the rows that will execute: a defective
    record beyond the row_count limit must not block the run."""

    records = [
        {
            "dataset_record_id": "r1",
            "inputs": {"query": "question 1"},
            "expectations": {"expected_output": "answer 1"},
        },
        {
            "dataset_record_id": "r2",
            "inputs": {"query": "question 2"},
            "expectations": {"expected_output": "answer 2"},
        },
        {
            # No query: blocks readiness if analyzed, but is outside row_count.
            "dataset_record_id": "r3",
            "inputs": {},
            "expectations": {"expected_output": "answer 3"},
        },
    ]
    store = _CaptureStore()
    await execute_dataset_run(
        run_id="run-rowcount",
        dataset_name="ds",
        response_source="baseline",
        agent=None,
        row_count=2,
        judge_model=None,
        resolved_active_metrics=["llm.relevance"],
        enable_llm_judge=False,
        store=store,
        engine=_engine(),
        registry=_FakeRegistry(records),
    )

    assert store.saved is not None
    result, rows = store.saved
    assert len(rows) == 2
    assert {row.row_id for row in rows} == {"r1", "r2"}
    assert result.experiment.row_count == 2


# ---------------------------------------------------------------------------
# Incomplete required evidence yields no verdict and no gate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_partial_required_evidence_cannot_produce_a_conclusive_verdict(monkeypatch, caplog):
    """A run may not pass on evidence it only partly captured.

    Only a metric that *declares* a missing category is downgraded on its own,
    so without capture completeness as an input a run could report a conclusive
    pass while a required category was never captured — the report saying Pass
    while the release gate, reading the same categories, refused it.

    Capture classification is exercised in test_readiness; here it is pinned so
    the verdict decision is what is under test, including the emitted event.
    """

    def _partial(rows, **kwargs):  # noqa: ARG001
        return (
            EvidenceCaptureStatus.PARTIAL,
            [
                EvidenceCategorySummary(
                    category="trace",
                    required=True,
                    status=EvidenceCategoryStatus.UNKNOWN,
                    provenance_status=ProvenanceStatus.UNAVAILABLE,
                )
            ],
        )

    monkeypatch.setattr(run_service, "classify_evidence_capture", _partial)

    store = _CaptureStore()
    caplog.set_level(logging.INFO, logger="evalhub.events")
    await execute_dataset_run(
        run_id="run-partial-evidence",
        dataset_name="ds",
        response_source="provided",
        agent=None,
        row_count=None,
        judge_model=None,
        resolved_active_metrics=["llm.relevance"],
        enable_llm_judge=False,
        store=store,
        engine=_engine(),
        registry=_FakeRegistry(_provided_records()),
    )

    assert store.saved is not None
    result, _ = store.saved
    assert result.evidence_capture_status == EvidenceCaptureStatus.PARTIAL
    assert result.verdict_status == VerdictStatus.INCONCLUSIVE
    assert result.overall_gate is None
    # The CI release signal is derived from the verdict, so it follows.
    assert build_ci_callback(result)["release_allowed"] is False

    # The event stream must not contradict the stored run. The engine emits
    # RUN_COMPLETED with the verdict it decided and builds the review queue from
    # the same gate, so deciding this after the fact would leave a consumer
    # seeing a pass the database disagrees with.
    completed = next(record for record in caplog.records if getattr(record, "eval_event", None) == "RUN_COMPLETED")
    emitted = completed.eval_fields
    assert emitted["verdict_status"] == VerdictStatus.INCONCLUSIVE.value
    # ``emit`` drops None fields, so an absent gate is the emitted "no gate".
    assert "overall_gate" not in emitted


def test_context_metrics_do_not_substitute_a_score_for_retrieval_that_never_happened():
    """A scorer that refuses for want of context must not be quietly replaced.

    Both context-dependent scorers reject an empty context outright, so on a
    target that retrieved nothing the run recorded a substitute score standing
    in for evidence that was never going to exist — the same absence the
    retrieval evidence category reports as expected. The read trace is what
    separates that from retrieval we simply failed to capture.
    """

    from evalhub.evaluation.engine import _metric_not_applicable

    def row(**kwargs):
        return EvaluationRow(row_id="r1", query="q", response="a", from_agent=True, **kwargs)

    for metric_id in ("rag.groundedness", "safety.ungrounded_attributes"):
        # Trace read and nothing retrieved: the absence is accounted for.
        reason = _metric_not_applicable(metric_id, row(trace_span_count=16))
        assert reason and "retrieved nothing" in reason

        # Retrieval happened: score it.
        assert _metric_not_applicable(metric_id, row(trace_span_count=16, context=["a doc"])) is None

        # No trace read: we cannot tell, so this must not claim an absence.
        assert _metric_not_applicable(metric_id, row()) is None

    # A metric that judges the answer alone is untouched by any of this.
    assert _metric_not_applicable("llm.relevance", row(trace_span_count=16)) is None


@pytest.mark.parametrize("metric_id,adapter_module,adapter_class", [
    ("llm.correctness", "deepeval_adapter", "DeepEvalJudge"),
    ("rag.groundedness", "ragas_adapter", "RagasJudge"),
])
def test_framework_scorers_use_the_run_model_without_changing_other_runs(monkeypatch, metric_id, adapter_module, adapter_class):
    import importlib

    from evalhub.evaluation.adapters.dispatcher import AdapterDispatchJudge
    from evalhub.settings import Settings

    seen = []

    class CapturingJudge:
        def __init__(self, settings):
            self.model = settings.judge_model

        def evaluate(self, config, row):
            seen.append((self.model, config.judge_model))
            return JudgeResult(1.0, None, "test scorer", 0, 0)

    monkeypatch.setattr(importlib.import_module(f"evalhub.evaluation.adapters.{adapter_module}"), adapter_class, CapturingJudge)
    settings = Settings(judge_mode="llm", openai_api_key="test-key", judge_model="default-model", judge_use_frameworks=True)
    dispatcher = AdapterDispatchJudge(settings)
    engine = EvaluationEngine(judge=dispatcher, settings=settings)
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    rows[0] = rows[0].model_copy(update={"context": ["Synthetic reference"]})
    for model in ("selected-model", "default-model"):
        experiment = SAMPLE_EXPERIMENTS[0].model_copy(update={"judge_model": model})
        result = engine.execute(experiment, rows, metric_ids=[metric_id])
        assert result.metric_results[0].judge_model == model
    assert seen == [("selected-model", "selected-model"), ("default-model", "default-model")]
    assert dispatcher.settings.judge_model == "default-model"
