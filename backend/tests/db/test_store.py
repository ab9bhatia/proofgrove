"""Tests for EvaluationStore persistence."""

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from proofgrove.db.models import Base, CapturedTraceIndexORM, EvaluationRunItemORM, EvaluationRunORM, ExperimentORM, MetricResultORM
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.evaluation.enums import MetricApplicability
from proofgrove.evaluation.judge import MockJudge
from proofgrove.evaluation.models import EvaluationRow
from proofgrove.evaluation.sample_data import SAMPLE_EXPERIMENTS, get_sample_rows
from proofgrove.platform.contracts import EvaluationProject


@pytest.fixture
async def store():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        s = EvaluationStore(session)
        await s.seed_definitions()
        yield s
    await engine.dispose()


@pytest.mark.asyncio
async def test_save_and_get_run(store: EvaluationStore):
    engine = EvaluationEngine(judge=MockJudge())
    exp = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    run = engine.execute(exp, rows)
    await store.save_run(run, rows)

    loaded = await store.get_run(run.run_id)
    assert loaded is not None
    assert loaded.run_id == run.run_id
    assert len(loaded.metric_results) == len(run.metric_results)
    assert loaded.overall_gate == run.overall_gate
    assert loaded.metric_results[0].requested_scorer == run.metric_results[0].requested_scorer
    assert loaded.metric_results[0].executed_scorer == run.metric_results[0].executed_scorer
    assert loaded.kpi_results[0].coverage_label == run.kpi_results[0].coverage_label


@pytest.mark.asyncio
async def test_historical_null_provenance_and_coverage_remain_not_recorded(
    store: EvaluationStore,
):
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    run = EvaluationEngine(judge=MockJudge()).execute(SAMPLE_EXPERIMENTS[0], rows)
    for metric in run.metric_results:
        metric.requested_scorer = None
        metric.executed_scorer = None
    for kpi in run.kpi_results:
        kpi.coverage_label = None
    await store.save_run(run, rows)

    loaded = await store.get_run(run.run_id)
    assert loaded is not None
    assert all(metric.requested_scorer is None for metric in loaded.metric_results)
    assert all(metric.executed_scorer is None for metric in loaded.metric_results)
    assert all(kpi.coverage_label is None for kpi in loaded.kpi_results)


@pytest.mark.asyncio
async def test_run_labels_round_trip_through_save_and_load(store: EvaluationStore):
    engine = EvaluationEngine(judge=MockJudge())
    exp = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    run = engine.execute(exp, rows)
    run.labels = ["candidate", "smoke", "release"]
    await store.save_run(run, rows)

    loaded = await store.get_run(run.run_id)
    assert loaded is not None
    assert loaded.labels == ["candidate", "smoke", "release"]
    assert loaded.label == "candidate"
    page, total = await store.list_runs_page(search="smoke")
    assert total == 1
    assert [item.run_id for item in page] == [run.run_id]


@pytest.mark.asyncio
async def test_legacy_run_label_reads_as_one_label(store: EvaluationStore):
    engine = EvaluationEngine(judge=MockJudge())
    exp = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    run = engine.execute(exp, rows)
    run.label = "Candidate"
    await store.save_run(run, rows)

    orm = await store.session.get(EvaluationRunORM, run.run_id)
    assert orm is not None
    orm.labels = []
    await store.session.commit()

    loaded = await store.get_run(run.run_id)
    assert loaded is not None
    assert loaded.label == "Candidate"
    assert loaded.labels == ["Candidate"]


@pytest.mark.asyncio
async def test_an_unlabelled_run_does_not_inherit_the_experiment_label(
    store: EvaluationStore,
):
    """The experiment row is shared by every compatible rerun, and its label tag is
    only ever written, never cleared. Reading a run's label from it handed a later
    unlabelled run whatever an earlier run happened to be called."""
    engine = EvaluationEngine(judge=MockJudge())
    exp = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows("exp-llm-core-v1")[:1]

    labelled = engine.execute(exp, rows)
    labelled.labels = ["release-candidate"]
    await store.save_run(labelled, rows)

    unlabelled = engine.execute(exp, rows)
    unlabelled.label = None
    unlabelled.labels = []
    await store.save_run(unlabelled, rows)

    loaded = await store.get_run(unlabelled.run_id)
    assert loaded is not None
    assert loaded.labels == []
    assert loaded.label is None


@pytest.mark.asyncio
async def test_metric_result_span_id_survives_save_and_load(store: EvaluationStore):
    """Historical case evidence keeps its old span link without rewriting identity."""
    engine = EvaluationEngine(judge=MockJudge())
    exp = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    run = engine.execute(exp, rows)
    run.metric_results[0].subject_kind = None
    run.metric_results[0].span_id = "span-abc"
    await store.save_run(run, rows)

    loaded = await store.get_run(run.run_id)
    assert loaded is not None
    by_metric = {mr.metric_id: mr for mr in loaded.metric_results}
    assert by_metric[run.metric_results[0].metric_id].span_id == "span-abc"
    assert sum(mr.span_id == "span-abc" for mr in loaded.metric_results) == 1


@pytest.mark.asyncio
async def test_openinference_evaluator_identity_survives_save_and_load(store: EvaluationStore):
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    run = EvaluationEngine(judge=MockJudge()).execute(SAMPLE_EXPERIMENTS[0], rows)
    result = run.metric_results[0]
    result.target_trace_id = "0123456789abcdef0123456789abcdef"
    result.target_span_id = "0123456789abcdef"
    result.evaluator_trace_id = "fedcba9876543210fedcba9876543210"
    result.evaluator_span_id = "fedcba9876543210"
    result.annotator_kind = "CODE"
    result.evaluation_identifier = "exact-match:v1"
    await store.save_run(run, rows)

    loaded = await store.get_run(run.run_id)
    assert loaded is not None
    restored = loaded.metric_results[0]
    assert restored.target_trace_id == result.target_trace_id
    assert restored.target_span_id == result.target_span_id
    assert restored.evaluator_trace_id == result.evaluator_trace_id
    assert restored.evaluator_span_id == result.evaluator_span_id
    assert restored.annotator_kind == "CODE"
    assert restored.evaluation_identifier == "exact-match:v1"


@pytest.mark.asyncio
async def test_create_run_job_stores_canonical_labels_and_legacy_alias(
    store: EvaluationStore,
):
    run_id = await store.create_run_job(
        dataset_name="exp-llm-core-v1",
        response_source="baseline",
        agent=None,
        row_count=1,
        judge_model=None,
        label="legacy",
        labels=[" candidate ", "release"],
    )

    job = await store.get_run_job(run_id)
    assert job is not None
    assert job.params["labels"] == ["candidate", "release"]
    assert job.params["label"] == "candidate"
    assert job.params["name"] == "candidate"


@pytest.mark.asyncio
async def test_list_runs(store: EvaluationStore):
    engine = EvaluationEngine(judge=MockJudge())
    exp = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    run = engine.execute(exp, rows)
    await store.save_run(run, rows)

    runs = await store.list_runs()
    assert len(runs) >= 1


@pytest.mark.asyncio
async def test_store_run_reads_are_tenant_scoped(store: EvaluationStore):
    """list_runs / get_run / run_exists / run-item reads filter by tenant."""
    engine = EvaluationEngine(judge=MockJudge())
    base = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    example_id = rows[0].row_id

    exp_a = base.model_copy(update={"experiment_id": "exp-iso-a", "tenant_id": "tenant-a"})
    exp_b = base.model_copy(update={"experiment_id": "exp-iso-b", "tenant_id": "tenant-b"})
    run_a = engine.execute(exp_a, rows)
    run_b = engine.execute(exp_b, rows)
    await store.save_run(run_a, rows)
    await store.save_run(run_b, rows)

    # list_runs is scoped to the requested tenant.
    a_ids = {run.run_id for run in await store.list_runs(tenant_id="tenant-a")}
    assert run_a.run_id in a_ids
    assert run_b.run_id not in a_ids

    # get_run / run_exists never resolve another tenant's run.
    assert await store.get_run(run_a.run_id, tenant_id="tenant-a") is not None
    assert await store.get_run(run_a.run_id, tenant_id="tenant-b") is None
    assert await store.run_exists(run_a.run_id, "tenant-a") is True
    assert await store.run_exists(run_a.run_id, "tenant-b") is False

    # run-item reads are scoped too.
    assert await store.list_run_items(run_a.run_id, tenant_id="tenant-a")
    assert await store.list_run_items(run_a.run_id, tenant_id="tenant-b") == []
    assert await store.get_run_item(run_a.run_id, example_id, tenant_id="tenant-a") is not None
    assert await store.get_run_item(run_a.run_id, example_id, tenant_id="tenant-b") is None

    # An unscoped read (tenant_id=None) preserves existing behaviour.
    assert await store.get_run(run_a.run_id) is not None


@pytest.mark.asyncio
async def test_evidence_pack_reads_and_writes_are_tenant_scoped(store: EvaluationStore):
    """get_evidence_pack / annotate_evidence_pack must not resolve another tenant's run."""
    engine = EvaluationEngine(judge=MockJudge())
    base = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows("exp-llm-core-v1")[:1]

    exp_a = base.model_copy(update={"experiment_id": "exp-evidence-a", "tenant_id": "tenant-a"})
    run_a = engine.execute(exp_a, rows)
    await store.save_run(run_a, rows)

    assert await store.get_evidence_pack(run_a.run_id, "tenant-a") is not None
    assert await store.get_evidence_pack(run_a.run_id, "tenant-b") is None

    assert await store.annotate_evidence_pack(run_a.run_id, "tenant-b", {"x": 1}) is None
    updated = await store.annotate_evidence_pack(run_a.run_id, "tenant-a", {"x": 1})
    assert updated is not None
    assert updated.contents.get("x") == 1


@pytest.mark.asyncio
async def test_historical_unclassified_projects_remain_discoverable(
    store: EvaluationStore,
):
    await store.save_project(
        EvaluationProject(
            project_id="historical-project",
            tenant_id="tenant-history",
            name="Historical evaluation workspace",
            system_type="agent",
            owner="quality",
            purpose=None,
        )
    )

    projects = await store.list_trace_projects("tenant-history")

    assert [project["project_id"] for project in projects] == ["historical-project"]
    assert projects[0]["classification_state"] == "unclassified_historical"


@pytest.mark.asyncio
async def test_not_applicable_metric_round_trips_and_remains_listable(
    store: EvaluationStore,
):
    row = EvaluationRow(
        row_id="no-tool-case",
        query="answer directly",
        response="done",
        expected_response="done",
        from_agent=True,
        trace_unavailable=False,
        tool_evidence_completion_attested=True,
        tool_calls=[],
    )
    run = EvaluationEngine(judge=MockJudge()).execute(
        SAMPLE_EXPERIMENTS[2],
        [row],
        metric_ids=["agent.tool_selection"],
    )

    await store.save_run(run, [row])

    loaded = await store.get_run(run.run_id)
    assert loaded is not None
    metric = loaded.metric_results[0]
    assert metric.metric_applicability == MetricApplicability.NOT_APPLICABLE
    assert metric.metric_status is None
    assert metric.unscored_reason is None
    assert metric.score is None
    assert metric.threshold_result is None
    assert any(item.run_id == run.run_id for item in await store.list_runs())


@pytest.mark.asyncio
async def test_case_readers_exclude_persisted_spans_and_keep_legacy_subjects(store):
    from proofgrove.db.store import _metric_result_from_orm
    from proofgrove.evaluation.models import MetricResult
    from proofgrove.evaluation.report import build_report

    rows = get_sample_rows("exp-llm-core-v1")[:1]
    run = EvaluationEngine(judge=MockJudge()).execute(SAMPLE_EXPERIMENTS[0], rows)
    case = run.metric_results[0]
    case.subject_kind = None
    case.span_id = "legacy-span"
    await store.save_run(run, rows)
    expected_report = build_report(await store.get_run(run.run_id))
    expected_items = await store.list_run_items(run.run_id)
    expected_detail = await store.get_run_item(run.run_id, rows[0].row_id)
    expected_pack = (await store.get_evidence_pack(run.run_id, run.experiment.tenant_id)).contents
    candidate = EvaluationEngine(judge=MockJudge()).execute(SAMPLE_EXPERIMENTS[0], rows)
    await store.save_run(candidate, rows)
    expected_comparison = await store.compare_runs(run.experiment.experiment_id, run.run_id, candidate.run_id)
    span = MetricResult.model_validate({**case.model_dump(), "subject_kind": "span", "trace_id": "trace", "span_id": "future-span",
                                       "metric_status": "scored", "unscored_reason": None, "score": 0.0, "normalised_score": 0.0,
                                       "passed": False, "threshold_result": "fail", "rationale": "span-only failure"})
    run.metric_results.insert(0, span)
    span_measurement = MetricResult.model_validate({
        **span.model_dump(), "metric_id": "ops.latency", "score": 999999.0,
        "normalised_score": None, "passed": None, "threshold_result": None,
    })
    run.metric_results.append(span_measurement)
    # Replace the snapshot through the existing permitted partial-evidence seam.
    orm = await store.session.get(EvaluationRunORM, run.run_id)
    orm.status = "completed_with_partial_evidence"
    await store.session.commit()
    await store.save_run(run, rows, replace_existing=True)
    raw = (await store.session.scalars(select(MetricResultORM).where(MetricResultORM.run_id == run.run_id))).all()
    assert len(raw) == len(run.metric_results)
    assert {mr.subject_kind for mr in raw} == {None, "case", "span"}
    stored_span = next(mr for mr in raw if mr.subject_kind == "span")
    assert _metric_result_from_orm(stored_span).span_id == "future-span"
    assert _metric_result_from_orm(stored_span).subject_kind == "span"
    loaded = await store.get_run(run.run_id)
    assert len(loaded.metric_results) == len(run.metric_results) - 2
    assert all(mr.subject_kind in (None, "case") for mr in loaded.metric_results)
    historical = next(mr for mr in loaded.metric_results if mr.subject_kind is None)
    assert historical.span_id == "legacy-span"
    report = build_report(loaded)
    for field in ("generated_at", "started_at", "completed_at"):
        report.pop(field)
        expected_report.pop(field)
    assert report == expected_report
    assert (await store.get_evidence_pack(run.run_id, run.experiment.tenant_id)).contents == expected_pack
    assert await store.compare_runs(run.experiment.experiment_id, run.run_id, candidate.run_id) == expected_comparison
    assert await store.list_run_items(run.run_id) == expected_items
    detail = await store.get_run_item(run.run_id, rows[0].row_id)
    assert [mr.model_dump(exclude={"timestamp", "evaluator_instance_id"}) for mr in detail.scorer_results] == [
        mr.model_dump(exclude={"timestamp", "evaluator_instance_id"}) for mr in expected_detail.scorer_results
    ]


@pytest.mark.asyncio
async def test_create_run_response_uses_case_projection(store, monkeypatch):
    from proofgrove.api.v1.evaluation import create_run
    from proofgrove.evaluation.models import MetricResult

    engine = EvaluationEngine(judge=MockJudge())
    execute = engine.execute

    def execute_with_span(*args, **kwargs):
        run = execute(*args, **kwargs)
        run.metric_results.append(MetricResult.model_validate({
            **run.metric_results[0].model_dump(), "subject_kind": "span", "trace_id": "trace", "span_id": "span",
        }))
        return run

    monkeypatch.setattr(engine, "execute", execute_with_span)
    from starlette.requests import Request

    request = Request({"type": "http", "headers": [(b"x-evalai-tenant", SAMPLE_EXPERIMENTS[0].tenant_id.encode())]})
    response = await create_run(SAMPLE_EXPERIMENTS[0], request, store=store, engine=engine)
    assert response["metric_results"]
    assert all(result["subject_kind"] == "case" for result in response["metric_results"])
    raw = (await store.session.scalars(select(MetricResultORM).where(MetricResultORM.run_id == response["run_id"]))).all()
    assert len(raw) == len(response["metric_results"]) + 1


@pytest.mark.asyncio
async def test_bind_manifest_to_experiment_requires_caller_tenant_to_own_the_manifest(
    store: EvaluationStore,
):
    """Regression for the conditional store guard at bind_manifest_to_experiment.

    The tenant check used to fire only when ``exp.tenant_id`` was already set
    (``if exp.tenant_id and exp.tenant_id != manifest.tenant_id``), so an
    experiment with no tenant yet silently adopted whatever tenant the named
    manifest belonged to -- with no check that the CALLER was ever authorized
    for that tenant. The guard is now unconditional: it always compares the
    manifest's tenant against the caller's own authorized ``tenant_id``
    (resolved and enforced by the route), regardless of what the experiment
    currently carries.
    """
    from proofgrove.db.models import ExperimentORM, RunManifestORM

    store.session.add(
        ExperimentORM(
            experiment_id="exp-unbound",
            name="Candidate",
            dataset_version="v1",
            target_endpoint="http://placeholder",
            scenario="llm_core",
            tenant_id=None,
        )
    )
    manifest_json = {
        "manifest_id": "manifest-tenant-b",
        "manifest_hash": "hash-tenant-b",
        "tenant_id": "tenant-b",
        "project_id": "project-b",
        "target_version_id": "target-b",
        "target_id": "target-b",
        "target_version": "v1",
        "target_endpoint": "http://placeholder",
        "target_type": "application",
        "environment": "test",
        "quality_profile_id": "profile-b",
        "quality_profile_version": "1.0.0",
        "scenario": "llm_core",
        "metric_ids": ["llm.relevance"],
    }
    store.session.add(
        RunManifestORM(
            manifest_id="manifest-tenant-b",
            manifest_hash="hash-tenant-b",
            tenant_id="tenant-b",
            project_id="project-b",
            target_version_id="target-b",
            profile_id="profile-b",
            profile_version="1.0.0",
            manifest_json=manifest_json,
        )
    )
    await store.session.commit()

    # A caller authorized only for tenant-a must not be able to bind a
    # tenant-b manifest onto the tenant-less experiment, even though the
    # experiment itself carries no tenant to compare against.
    with pytest.raises(ValueError, match="tenant"):
        await store.bind_manifest_to_experiment("exp-unbound", "manifest-tenant-b", "tenant-a")

    # The manifest's own tenant may still bind it.
    bound = await store.bind_manifest_to_experiment("exp-unbound", "manifest-tenant-b", "tenant-b")
    assert bound is not None
    assert bound.tenant_id == "tenant-b"


@pytest.mark.asyncio
@pytest.mark.parametrize("namespace, owner, canonical, foreign", [
    ("tenant-foo", "foo", "tenant-foo", "tenant-tenant-foo"),
    ("tenant-tenant-foo", "tenant-foo", "tenant-tenant-foo", "foo"),
    ("", "tenant-foo", "tenant-foo", "foo"),
])
async def test_trace_index_join_preserves_tenant_identity(store, monkeypatch, namespace, owner, canonical, foreign):
    from proofgrove.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", namespace)
    session = store.session
    session.add_all([
        ExperimentORM(experiment_id="alias-exp", name="synthetic", dataset_version="v1", target_endpoint="agent", scenario="llm_core", tenant_id=owner),
        EvaluationRunORM(run_id="alias-run", experiment_id="alias-exp", status="completed"),
        EvaluationRunItemORM(run_id="alias-run", example_id="case", sequence_position=0, dataset_version="v1", trace_id="shared-trace", evidence_ref="synthetic", redaction_enabled=True, max_persisted_string_size=100),
        CapturedTraceIndexORM(tenant_id=foreign, trace_id="shared-trace", is_evaluated=False),
    ])
    await session.commit()
    assert await store.upsert_requested_traces_from_run_items(namespace) == 1
    assert await store.upsert_requested_traces_from_run_items(namespace) == 0
    records = (await session.execute(select(CapturedTraceIndexORM).where(CapturedTraceIndexORM.trace_id == "shared-trace"))).scalars().all()
    assert {row.tenant_id: row.is_evaluated for row in records} == {canonical: True, foreign: False}
