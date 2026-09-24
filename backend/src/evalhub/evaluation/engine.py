"""Evaluation engine — per-row execution, KPI composition, gate decision."""

import logging
import re
import uuid
from collections import defaultdict
from datetime import UTC, datetime

from opentelemetry import trace

from evalhub.evaluation.adapters.deterministic_adapter import usage_total_tokens
from evalhub.evaluation.adapters.dispatcher import AdapterDispatchJudge
from evalhub.evaluation.enums import (
    Adapter,
    CoverageLabel,
    GateResult,
    MetricApplicability,
    MetricRequirement,
    MetricRequirementSource,
    MetricStatus,
    RunStatus,
    ScoreSubjectKind,
    TargetIdentityStatus,
    TriggerReason,
    UnscoredReason,
    VerdictStatus,
)
from evalhub.evaluation.evidence_requirements import requires_retrieved_context
from evalhub.evaluation.judge import Judge, MockJudge, get_judge
from evalhub.evaluation.lineage import (
    build_lineage,
    compute_comparison_basis_hash,
    compute_experiment_version_id,
)
from evalhub.evaluation.metrics import get_metric
from evalhub.evaluation.models import (
    ConstituentScore,
    EvaluationRow,
    ExperimentDefinition,
    FailingMetricDetail,
    KpiResult,
    MetricResult,
    ReviewQueueItem,
    RunResult,
)
from evalhub.evaluation.normalization import normalise_operational, normalise_score, threshold_result, worst_gate
from evalhub.evaluation.openinference import content_attributes, evaluator_span
from evalhub.evaluation.rca import diagnose_root_cause, metric_result_failed
from evalhub.evaluation.scenario_router import (
    CROSS_CUTTING_METRICS,
    SCENARIO_METRICS,
    build_evaluator_configs,
)
from evalhub.evaluation.target.invocation_span import setup_invocation_tracing
from evalhub.events import EvalEvent, emit
from evalhub.platform.contracts import (
    ResolvedRunManifest,
    ResolvedScoringConfiguration,
)
from evalhub.settings import settings as global_settings
from evalhub.version import PROMPT_VERSION

logger = logging.getLogger(__name__)

# Metrics that are only meaningful against captured target token telemetry.
# They must be UNSCORED when the row carries no usable token usage, never
# scored by an LLM judge or a mock fallback.
_TOKEN_TELEMETRY_METRICS = frozenset({"ops.token_efficiency"})


def _annotator_kind(config, executed_scorer: str | None) -> str:
    """Map Eval Hub adapters onto OpenInference's stable annotator taxonomy."""

    scorer = executed_scorer or config.adapter.value
    if scorer in {Adapter.DETERMINISTIC.value, Adapter.TRACE.value, Adapter.MOCK.value}:
        return "CODE"
    return "LLM"


def _evaluation_identifier(config) -> str:
    evaluator = config.evaluator_id or config.instance_id or config.metric_id
    version = config.evaluator_version or config.prompt_version
    return f"{evaluator}:{version}"


def _bind_evaluator_trace(
    result: MetricResult,
    evaluation,
    annotator_kind: str,
    evaluation_identifier: str,
    target_span_id: str | None,
) -> None:
    result.target_trace_id = result.trace_id
    result.target_span_id = result.span_id or target_span_id
    result.evaluator_trace_id = evaluation.trace_id
    result.evaluator_span_id = evaluation.span_id
    result.feedback_scope = "span" if result.target_span_id else "trace"
    result.annotator_kind = annotator_kind
    result.evaluation_identifier = evaluation_identifier

class EvaluationEngine:
    """Orchestrates evaluation runs using an injected judge."""

    def __init__(self, judge: Judge | None = None, settings=None) -> None:
        self.judge = judge or get_judge()
        # Settings snapshot used to build the reproducibility lineage.
        self.settings = settings or global_settings

    def execute(
        self,
        experiment: ExperimentDefinition,
        rows: list[EvaluationRow],
        run_id: str | None = None,
        trigger_reason: TriggerReason = TriggerReason.MANUAL,
        correlation_id: str | None = None,
        retry_count: int = 0,
        manifest: ResolvedRunManifest | None = None,
        metric_ids: list[str] | None = None,
        scoring_configuration: ResolvedScoringConfiguration | None = None,
        pre_run_not_applicable: dict[str, str] | None = None,
        target_prompt_hash: str | None = None,
        evidence_capture_complete: bool = True,
    ) -> RunResult:
        """Execute a full evaluation run.

        ``run_id`` may be supplied so the persisted result matches a pre-created
        run job (async execution); otherwise a fresh id is generated.
        ``trigger_reason``/``correlation_id`` are recorded on the run for
        traceability (see ``evalhub.events`` and ``RunLineage``).
        ``pre_run_not_applicable`` maps metric ids that readiness classified
        ``known_not_applicable`` at launch to the frozen reason: those metrics
        are never scored in this run — each row records a not-applicable result
        carrying that reason instead, so applicability cannot silently drift
        between the pre-run decision and execution.
        """
        validate_unique_example_ids(rows)
        judge = self.judge
        if isinstance(judge, AdapterDispatchJudge) and experiment.judge_model and experiment.judge_model != judge.settings.judge_model:
            # Bind framework clients to this run without mutating a shared engine.
            judge = AdapterDispatchJudge(judge.settings.model_copy(update={"judge_model": experiment.judge_model}))
        run_id = run_id or str(uuid.uuid4())
        if manifest and scoring_configuration:
            raise ValueError("A run cannot use both an approved manifest and a dataset scoring configuration")
        if manifest:
            # The manifest is the authoritative contract. Copy the caller's
            # experiment so a replay cannot mutate its persisted definition.
            experiment = experiment.model_copy(deep=True)
            experiment.target_endpoint = manifest.target_endpoint
            experiment.scenario = manifest.scenario
            experiment.target_id = manifest.target_id
            experiment.target_version = manifest.target_version
            experiment.target_version_id = manifest.target_version_id
            experiment.project_id = manifest.project_id
            experiment.quality_profile_id = manifest.quality_profile_id
            experiment.quality_profile_version = manifest.quality_profile_version
            experiment.gate_policy_id = manifest.gate_policy_id
            experiment.gate_policy_version = manifest.gate_policy_version
            experiment.benchmark_package_id = manifest.benchmark_package_id
            experiment.benchmark_package_version = manifest.benchmark_package_version
            experiment.run_manifest_id = manifest.manifest_id
            experiment.evaluation_scope = manifest.evaluation_scope
            experiment.kpi_threshold_overrides = manifest.kpi_threshold_overrides
        elif scoring_configuration:
            experiment = experiment.model_copy(deep=True)
            experiment.scenario = scoring_configuration.scenario
            experiment.evaluation_scope = scoring_configuration.evaluation_scope
        experiment.experiment_id = experiment.experiment_id or run_id
        correlation_id = correlation_id or run_id

        resolved_metric_definitions = None
        if manifest and manifest.metric_definitions:
            from evalhub.evaluation.models import MetricDefinition

            resolved_metric_definitions = [MetricDefinition.model_validate(item) for item in manifest.metric_definitions]
        elif scoring_configuration and scoring_configuration.metric_definitions:
            from evalhub.evaluation.models import MetricDefinition

            resolved_metric_definitions = [MetricDefinition.model_validate(item) for item in scoring_configuration.metric_definitions]
        metrics, configs, kpis = build_evaluator_configs(
            experiment,
            metric_ids=(manifest.metric_ids if manifest else scoring_configuration.metric_ids if scoring_configuration else metric_ids),
            evaluator_refs=manifest.evaluator_refs if manifest else None,
            metric_definitions=resolved_metric_definitions,
        )
        pinned_metric_evidence = manifest.metric_evidence_requirements if manifest else scoring_configuration.metric_evidence_requirements if scoring_configuration else {}
        if pinned_metric_evidence:
            for config in configs:
                pinned = pinned_metric_evidence.get(config.metric_id)
                if pinned is not None:
                    config.required_evidence_categories = list(pinned)
        active_metric_ids = [m.metric_id for m in metrics]
        requirement_by_metric = _resolved_requirements(
            manifest=manifest,
            scoring_configuration=scoring_configuration,
            active_metric_ids=active_metric_ids,
            explicitly_selected=metric_ids is not None,
            scenario=experiment.scenario,
        )
        kpi_compositions = _resolved_kpi_compositions(
            manifest=manifest,
            scoring_configuration=scoring_configuration,
            active_metric_ids=active_metric_ids,
            kpis=kpis,
            requirement_by_metric=requirement_by_metric,
        )
        diagnostic_only = not any(requirement == MetricRequirement.REQUIRED for requirement, _source in requirement_by_metric.values())

        experiment_version_id = compute_experiment_version_id(
            experiment,
            active_metric_ids,
            PROMPT_VERSION,
            manifest.manifest_hash if manifest else None,
            scoring_configuration.configuration_hash if scoring_configuration else None,
            target_prompt_hash,
        )
        comparison_basis_hash = compute_comparison_basis_hash(
            experiment,
            rows,
            active_metric_ids,
            manifest=manifest,
            scoring_configuration=scoring_configuration,
            settings=self.settings,
        )
        lineage = build_lineage(
            experiment,
            self.settings,
            experiment_version_id,
            PROMPT_VERSION,
            manifest,
            scoring_configuration,
            comparison_basis_hash,
        )

        run = RunResult(
            run_id=run_id,
            experiment=experiment,
            status=RunStatus.RUNNING,
            trigger_reason=trigger_reason,
            correlation_id=correlation_id,
            retry_count=retry_count,
            experiment_version_id=experiment_version_id,
            prompt_version=PROMPT_VERSION,
            lineage=lineage,
            active_metrics=active_metric_ids,
            evaluator_configs=configs,
            run_manifest_id=manifest.manifest_id if manifest else experiment.run_manifest_id,
            diagnostic_only=diagnostic_only,
            verdict_status=None if diagnostic_only else VerdictStatus.INCONCLUSIVE,
            overall_gate=None,
        )

        emit(
            EvalEvent.RUN_CREATED,
            correlation_id=correlation_id,
            run_id=run_id,
            experiment_id=experiment.experiment_id,
            experiment_version_id=experiment_version_id,
            dataset_version=experiment.dataset_version,
            scenario=experiment.scenario.value,
            trigger_reason=trigger_reason.value,
            retry_count=retry_count,
            row_count=len(rows),
            active_metrics=len(active_metric_ids),
            prompt_version=PROMPT_VERSION,
        )

        linked_traces = sum(1 for r in rows if r.trace_id)
        if linked_traces:
            emit(EvalEvent.TRACE_LINKED, correlation_id=correlation_id, run_id=run_id, linked_traces=linked_traces)

        emit(
            EvalEvent.FRAMEWORK_EVALUATION_STARTED,
            correlation_id=correlation_id,
            run_id=run_id,
            evaluations=len(rows) * len(configs),
        )

        metric_results: list[MetricResult] = []
        skipped_oversized = 0
        # Selected-tools level: scoring sees only the named tools' calls and
        # expectations; the captured row itself is never mutated, so evidence
        # persistence stays honest about every call that actually happened.
        selected_tools = experiment.selected_tool_ids

        for row in rows:
            if _row_excluded_from_scoring(row):
                skipped_oversized += 1
                for config in configs:
                    requirement, source = requirement_by_metric[config.metric_id]
                    frozen_na_reason = (pre_run_not_applicable or {}).get(config.metric_id)
                    if frozen_na_reason is not None:
                        metric_results.append(
                            _pre_run_not_applicable_result(
                                config=config,
                                experiment=experiment,
                                row=row,
                                run_id=run_id,
                                requirement=requirement,
                                source=source,
                                threshold=config.threshold_pass,
                                reason=frozen_na_reason,
                            )
                        )
                        continue
                    metric_results.append(
                        MetricResult(
                            metric_id=config.metric_id,
                            evaluator_instance_id=config.instance_id,
                            run_id=run_id,
                            row_id=row.row_id,
                            metric_requirement=requirement,
                            metric_requirement_source=source,
                            metric_applicability=MetricApplicability.APPLICABLE,
                            metric_status=MetricStatus.UNSCORED,
                            unscored_reason=UnscoredReason.EVIDENCE_UNAVAILABLE,
                            score=None,
                            normalised_score=None,
                            passed=None,
                            threshold_result=None,
                            error_message=row.invocation_error,
                            threshold=config.threshold_pass,
                            prompt_version=config.prompt_version,
                            judge_model=_recorded_judge_model(config, experiment, row),
                            trace_id=row.trace_id,
                            dataset_version=experiment.dataset_version,
                            sample_input={"query": row.query, "context": row.context},
                            sample_output={"response": row.response},
                            evaluator_id=config.evaluator_id,
                            evaluator_version=config.evaluator_version,
                            execution_status="unscored",
                            execution_metadata={"execution_policy": config.execution_policy},
                            requested_scorer=config.adapter.value,
                        )
                    )
                continue
            scoring_row = scoped_row_for_tool_selection(row, selected_tools)
            for config in configs:
                requirement, source = requirement_by_metric[config.metric_id]
                metric_def = get_metric(config.metric_id)
                kpi_def = _kpi_for_metric(config.metric_id, kpis)
                t_pass = kpi_def.threshold_pass if kpi_def else config.threshold_pass
                t_warn = kpi_def.threshold_warn if kpi_def else config.threshold_warn

                frozen_na_reason = (pre_run_not_applicable or {}).get(config.metric_id)
                if frozen_na_reason is not None:
                    # The launch-time readiness decision is frozen: a metric
                    # classified known-N/A before the run must never be scored
                    # in it, even if runtime inputs have drifted since.
                    metric_results.append(
                        _pre_run_not_applicable_result(
                            config=config,
                            experiment=experiment,
                            row=row,
                            run_id=run_id,
                            requirement=requirement,
                            source=source,
                            threshold=t_pass,
                            reason=frozen_na_reason,
                        )
                    )
                    continue

                not_applicable_reason = _metric_not_applicable(config.metric_id, scoring_row)
                if not_applicable_reason:
                    metric_results.append(
                        MetricResult(
                            metric_id=config.metric_id,
                            evaluator_instance_id=config.instance_id,
                            run_id=run_id,
                            row_id=row.row_id,
                            metric_requirement=requirement,
                            metric_requirement_source=source,
                            metric_applicability=MetricApplicability.NOT_APPLICABLE,
                            metric_status=None,
                            score=None,
                            normalised_score=None,
                            passed=None,
                            threshold_result=None,
                            threshold=t_pass,
                            prompt_version=config.prompt_version,
                            judge_model=_recorded_judge_model(config, experiment, row),
                            trace_id=row.trace_id,
                            dataset_version=experiment.dataset_version,
                            sample_input={"query": row.query, "context": row.context},
                            sample_output={"response": row.response},
                            evaluator_id=config.evaluator_id,
                            evaluator_version=config.evaluator_version,
                            execution_status="not_applicable",
                            execution_metadata={
                                "reason": not_applicable_reason,
                                "execution_policy": config.execution_policy,
                            },
                            requested_scorer=config.adapter.value,
                        )
                    )
                    continue

                missing_evidence = _missing_required_evidence(config, scoring_row)
                if missing_evidence:
                    trace_diagnostic = _incomplete_trace_diagnostic(scoring_row)
                    metric_results.append(
                        MetricResult(
                            metric_id=config.metric_id,
                            evaluator_instance_id=config.instance_id,
                            run_id=run_id,
                            row_id=row.row_id,
                            metric_requirement=requirement,
                            metric_requirement_source=source,
                            metric_status=MetricStatus.UNSCORED,
                            unscored_reason=(UnscoredReason.INCOMPLETE_TRACE if trace_diagnostic else UnscoredReason.EVIDENCE_UNAVAILABLE),
                            score=None,
                            normalised_score=None,
                            passed=None,
                            threshold_result=None,
                            rationale=((f"Trace evidence was incomplete ({trace_diagnostic}); " if trace_diagnostic else "Required evidence was not captured: ") + ", ".join(missing_evidence)),
                            threshold=t_pass,
                            prompt_version=config.prompt_version,
                            judge_model=_recorded_judge_model(config, experiment, row),
                            trace_id=row.trace_id,
                            dataset_version=experiment.dataset_version,
                            sample_input={"query": row.query, "context": row.context},
                            sample_output={"response": row.response},
                            evaluator_id=config.evaluator_id,
                            evaluator_version=config.evaluator_version,
                            execution_status="unscored",
                            execution_metadata={
                                "missing_evidence": missing_evidence,
                                "evidence_diagnostic": trace_diagnostic,
                                "execution_policy": config.execution_policy,
                            },
                            requested_scorer=config.adapter.value,
                        )
                    )
                    continue

                if config.metric_id in _TOKEN_TELEMETRY_METRICS and usage_total_tokens(row.target_usage) is None:
                    # Token efficiency is only meaningful against captured
                    # target token telemetry. Without it, never let a judge
                    # (LLM or mock) fabricate a score — record UNSCORED.
                    metric_results.append(
                        MetricResult(
                            metric_id=config.metric_id,
                            evaluator_instance_id=config.instance_id,
                            run_id=run_id,
                            row_id=row.row_id,
                            metric_requirement=requirement,
                            metric_requirement_source=source,
                            metric_status=MetricStatus.UNSCORED,
                            unscored_reason=(
                                UnscoredReason.EVIDENCE_UNAVAILABLE
                                if experiment.resolved_target_provenance.get("target_type")
                                == "provided"
                                else UnscoredReason.TELEMETRY_NOT_CAPTURED
                            ),
                            score=None,
                            normalised_score=None,
                            passed=None,
                            threshold_result=None,
                            rationale=("Target token usage telemetry was not captured; token efficiency cannot be scored."),
                            threshold=t_pass,
                            prompt_version=config.prompt_version,
                            judge_model=_recorded_judge_model(config, experiment, row),
                            trace_id=row.trace_id,
                            dataset_version=experiment.dataset_version,
                            sample_input={"query": row.query, "context": row.context},
                            sample_output={"response": row.response},
                            evaluator_id=config.evaluator_id,
                            evaluator_version=config.evaluator_version,
                            execution_status="unscored",
                            execution_metadata={
                                "missing_evidence": ["target_usage"],
                                "execution_policy": config.execution_policy,
                            },
                            requested_scorer=config.adapter.value,
                        )
                    )
                    continue

                evaluation = None
                try:
                    setup_invocation_tracing()
                    evaluation_identifier = _evaluation_identifier(config)
                    annotator_kind = _annotator_kind(config, None)
                    evaluator_attributes = {
                        "ctx.eval.run_id": run_id,
                        "ctx.eval.row_id": row.row_id,
                        "ctx.project_id": experiment.project_id,
                        "ctx.tenant": experiment.tenant_id,
                        "ctx.app": experiment.domain,
                        "ctx.target_id": experiment.target_id,
                        "ctx.target_revision": experiment.target_version,
                        "eval.trace.role": "evaluator",
                        "eval.metric.id": config.metric_id,
                        "eval.evaluator.id": config.evaluator_id or config.instance_id,
                        "eval.evaluator.version": config.evaluator_version or config.prompt_version,
                        "eval.dataset.version": experiment.dataset_version,
                        **content_attributes(
                            input_value={
                                "input": {"query": scoring_row.query, "context": scoring_row.context},
                                "output": {"response": scoring_row.response},
                                "expected": {"response": scoring_row.expected_response},
                            }
                        ),
                    }
                    with evaluator_span(
                        tracer=trace.get_tracer("evalhub.evaluator"),
                        name=f"eval_hub.evaluate.{config.metric_id}",
                        attributes={key: value for key, value in evaluator_attributes.items() if value is not None},
                        target_trace_id=row.trace_id,
                        target_span_id=row.span_id,
                    ) as evaluation:
                        judge_result = judge.evaluate(config, scoring_row)
                        executed_scorer = judge_result.executed_scorer
                        if executed_scorer is None and isinstance(judge, MockJudge):
                            executed_scorer = Adapter.MOCK.value
                        annotator_kind = _annotator_kind(config, executed_scorer)
                        evaluation.record_feedback(
                            name=config.metric_id,
                            annotator_kind=annotator_kind,
                            identifier=evaluation_identifier,
                            score=judge_result.score,
                            label=judge_result.label,
                            explanation=judge_result.rationale or judge_result.error_message or judge_result.execution_status,
                            metadata={
                                "run_id": run_id,
                                "row_id": row.row_id,
                                "evaluator_version": config.evaluator_version,
                                "requested_scorer": config.adapter.value,
                                "executed_scorer": executed_scorer,
                                "execution_status": judge_result.execution_status,
                            },
                        )

                    if executed_scorer == Adapter.MOCK.value:
                        result = MetricResult(
                                metric_id=config.metric_id,
                                evaluator_instance_id=config.instance_id,
                                run_id=run_id,
                                row_id=row.row_id,
                                metric_requirement=requirement,
                                metric_requirement_source=source,
                                metric_status=MetricStatus.UNSCORED,
                                unscored_reason=UnscoredReason.SIMULATED,
                                score=None,
                                normalised_score=None,
                                passed=None,
                                threshold_result=None,
                                rationale="Simulated - no real judge ran",
                                threshold=t_pass,
                                prompt_version=config.prompt_version,
                                judge_model=None,
                                trace_id=row.trace_id,
                                dataset_version=experiment.dataset_version,
                                sample_input={
                                    "query": row.query,
                                    "context": row.context,
                                },
                                sample_output={"response": row.response},
                                evaluator_id=config.evaluator_id,
                                evaluator_version=config.evaluator_version,
                                execution_status="unscored",
                                execution_metadata={
                                    "fallback_from": judge_result.fallback_from,
                                    "execution_policy": config.execution_policy,
                                },
                                requested_scorer=config.adapter.value,
                                executed_scorer=executed_scorer,
                            )
                        _bind_evaluator_trace(result, evaluation, annotator_kind, evaluation_identifier, row.span_id)
                        metric_results.append(result)
                        continue

                    if judge_result.execution_status == "error":
                        result = _technical_error_result(
                            config=config,
                            experiment=experiment,
                            row=row,
                            run_id=run_id,
                            requirement=requirement,
                            source=source,
                            threshold=t_pass,
                            message=judge_result.error_message or "Evaluator execution failed",
                            metadata={
                                "fallback_from": judge_result.fallback_from,
                                "execution_policy": config.execution_policy,
                            },
                            executed_scorer=executed_scorer,
                        )
                        _bind_evaluator_trace(result, evaluation, annotator_kind, evaluation_identifier, row.span_id)
                        metric_results.append(result)
                        continue
                    if judge_result.missing_evidence or judge_result.abstained:
                        result = MetricResult(
                            metric_id=config.metric_id,
                            evaluator_instance_id=config.instance_id,
                            run_id=run_id,
                            row_id=row.row_id,
                            metric_requirement=requirement,
                            metric_requirement_source=source,
                            metric_status=MetricStatus.UNSCORED,
                            unscored_reason=(UnscoredReason.EVALUATOR_ABSTAINED if judge_result.abstained else UnscoredReason.EVIDENCE_UNAVAILABLE),
                            score=None,
                            normalised_score=None,
                            passed=None,
                            threshold_result=None,
                            rationale=judge_result.rationale,
                            error_message=judge_result.error_message,
                            threshold=t_pass,
                            prompt_version=config.prompt_version,
                            judge_prompt_tokens=judge_result.prompt_tokens,
                            judge_completion_tokens=judge_result.completion_tokens,
                            judge_total_tokens=judge_result.prompt_tokens + judge_result.completion_tokens,
                            judge_model=_recorded_judge_model(config, experiment, row),
                            trace_id=row.trace_id,
                            dataset_version=experiment.dataset_version,
                            sample_input={"query": row.query, "context": row.context},
                            sample_output={"response": row.response},
                            evaluator_id=config.evaluator_id,
                            evaluator_version=config.evaluator_version,
                            execution_status="unscored",
                            execution_metadata={
                                "missing_evidence": judge_result.missing_evidence or [],
                                "execution_policy": config.execution_policy,
                            },
                            requested_scorer=config.adapter.value,
                            executed_scorer=executed_scorer,
                        )
                        _bind_evaluator_trace(result, evaluation, annotator_kind, evaluation_identifier, row.span_id)
                        metric_results.append(result)
                        continue

                    if judge_result.score is None:
                        result = _technical_error_result(
                            config=config,
                            experiment=experiment,
                            row=row,
                            run_id=run_id,
                            requirement=requirement,
                            source=source,
                            threshold=t_pass,
                            message="Evaluator completed without returning a score",
                            metadata={
                                "fallback_from": judge_result.fallback_from,
                                "execution_policy": config.execution_policy,
                            },
                            executed_scorer=executed_scorer,
                        )
                        _bind_evaluator_trace(result, evaluation, annotator_kind, evaluation_identifier, row.span_id)
                        metric_results.append(result)
                        continue

                    if metric_def and metric_def.scoring_type.value == "operational":
                        normalised = normalise_operational(judge_result.score, config.metric_id)
                    else:
                        normalised = normalise_score(
                            judge_result.score,
                            config.scoring_type,
                            config.score_range,
                        )

                    result = MetricResult(
                        metric_id=config.metric_id,
                        evaluator_instance_id=config.instance_id,
                        run_id=run_id,
                        row_id=row.row_id,
                        metric_requirement=requirement,
                        metric_requirement_source=source,
                        score=judge_result.score,
                        normalised_score=normalised,
                        label=judge_result.label,
                        # An operational metric carries its measurement and no
                        # verdict: there is no declared budget to grade it
                        # against, so a pass/fail here would be invented.
                        passed=None if normalised is None else normalised >= t_pass,
                        rationale=judge_result.rationale,
                        error_message=judge_result.error_message,
                        threshold=t_pass,
                        threshold_result=(None if normalised is None else threshold_result(normalised, t_pass, t_warn)),
                        prompt_version=config.prompt_version,
                        judge_prompt_tokens=judge_result.prompt_tokens,
                        judge_completion_tokens=judge_result.completion_tokens,
                        judge_total_tokens=judge_result.prompt_tokens + judge_result.completion_tokens,
                        judge_model=_recorded_judge_model(config, experiment, row),
                        trace_id=row.trace_id,
                        dataset_version=experiment.dataset_version,
                        sample_input={"query": row.query, "context": row.context},
                        sample_output={"response": row.response},
                        evaluator_id=config.evaluator_id,
                        evaluator_version=config.evaluator_version,
                        execution_status=judge_result.execution_status,
                        execution_metadata={
                            "fallback_from": judge_result.fallback_from,
                            "missing_evidence": judge_result.missing_evidence,
                            "abstained": judge_result.abstained,
                            "execution_policy": config.execution_policy,
                        },
                        requested_scorer=config.adapter.value,
                        executed_scorer=executed_scorer,
                    )
                    _bind_evaluator_trace(result, evaluation, annotator_kind, evaluation_identifier, row.span_id)
                except Exception as exc:  # noqa: BLE001 — isolate a failing metric, keep the run alive
                    logger.warning(
                        "Scoring failed for metric %s (row %s); recording as errored: %s",
                        config.metric_id,
                        row.row_id,
                        type(exc).__name__,
                    )
                    result = _technical_error_result(
                        config=config,
                        experiment=experiment,
                        row=row,
                        run_id=run_id,
                        requirement=requirement,
                        source=source,
                        threshold=t_pass,
                        message=str(exc),
                        metadata={"execution_policy": config.execution_policy},
                        executed_scorer=getattr(exc, "executed_scorer", None),
                    )
                    if evaluation is not None:
                        _bind_evaluator_trace(result, evaluation, annotator_kind, evaluation_identifier, row.span_id)

                metric_results.append(result)

        errored = sum(1 for mr in metric_results if mr.error_message)
        emit(
            EvalEvent.FRAMEWORK_EVALUATED,
            correlation_id=correlation_id,
            run_id=run_id,
            metric_results=len(metric_results),
            errored=errored,
        )

        case_metric_results = [result for result in metric_results if result.subject_kind in (None, ScoreSubjectKind.CASE)]

        kpi_results = self._compose_kpis(
            run_id,
            experiment,
            case_metric_results,
            rows,
            kpis,
            kpi_compositions,
        )
        required_results = [result for result in case_metric_results if result.metric_requirement == MetricRequirement.REQUIRED and result.metric_applicability == MetricApplicability.APPLICABLE]
        required_complete = all(result.metric_status == MetricStatus.SCORED for result in required_results)
        required_kpi_incomplete = any(
            _required_kpi_gate_is_incomplete(
                kpi,
                kpi_compositions[kpi.kpi_id],
                case_metric_results,
            )
            for kpi in kpi_results
        )
        if diagnostic_only:
            verdict_status = None
            overall_gate = None
        elif lineage.target_identity_status == TargetIdentityStatus.MISMATCHED:
            verdict_status = VerdictStatus.BLOCKED
            overall_gate = None
        elif lineage.exact_runtime_identity_required and lineage.target_identity_status != TargetIdentityStatus.MATCHED:
            verdict_status = VerdictStatus.INCONCLUSIVE
            overall_gate = None
        elif not required_complete or required_kpi_incomplete or not evidence_capture_complete:
            # Capture completeness belongs here rather than as a later
            # correction: the review queue is built from the gate decided below
            # and RUN_COMPLETED is emitted with it, so a verdict patched after
            # this point would leave events and the stored run disagreeing.
            # Callers that do not classify evidence pass the default and are
            # judged on metric outcomes alone, exactly as before.
            verdict_status = VerdictStatus.INCONCLUSIVE
            overall_gate = None
        else:
            gates = [k.gate_result for k in kpi_results if k.gate_result is not None]
            blocker_gate = _hard_blocker_gate(
                manifest.hard_blocker_metric_ids if manifest else [],
                case_metric_results,
            )
            if blocker_gate is not None:
                gates.append(blocker_gate)
            if not gates:
                # A required result without a governed KPI composition must
                # never become an accidental Pass. Resolution normally rejects
                # this; retain a runtime safety net for historical manifests.
                verdict_status = VerdictStatus.INCONCLUSIVE
                overall_gate = None
            else:
                verdict_status = VerdictStatus.CONCLUSIVE
                overall_gate = worst_gate(gates)
        root_cause = diagnose_root_cause(case_metric_results, experiment.has_ground_truth)
        if skipped_oversized:
            logger.info(
                "eval-hub: excluded %s AGENT_OUTPUT_TOO_LARGE row(s) from scoring for run %s",
                skipped_oversized,
                run_id,
            )
            note = f"{skipped_oversized}/{len(rows)} cases exceeded the agent response-size limit and were excluded from evaluation scores."
            if root_cause is None:
                from evalhub.evaluation.models import RootCauseDiagnosis

                root_cause = RootCauseDiagnosis(
                    has_ground_truth=experiment.has_ground_truth,
                    recommended_remediation=note,
                    causal_chain=[note],
                )
            else:
                root_cause.causal_chain = [*(root_cause.causal_chain or []), note]
                if not root_cause.recommended_remediation:
                    root_cause.recommended_remediation = note
        review_queue = self._build_review_queue(rows, case_metric_results)

        safety_kpi = next((k for k in kpi_results if k.kpi_id == "kpi.safety_trust"), None)
        if safety_kpi is not None and safety_kpi.gate_result is not None:
            emit(
                EvalEvent.SAFETY_EVALUATED,
                correlation_id=correlation_id,
                run_id=run_id,
                gate=safety_kpi.gate_result.value,
                composite_score=safety_kpi.composite_score,
            )

        if review_queue:
            emit(
                EvalEvent.FLAGGED_FOR_REVIEW,
                correlation_id=correlation_id,
                run_id=run_id,
                flagged_rows=len(review_queue),
            )

        run.metric_results = metric_results
        run.kpi_results = kpi_results
        run.verdict_status = verdict_status
        run.overall_gate = overall_gate
        run.root_cause = root_cause
        run.review_queue = review_queue
        run.status = RunStatus.COMPLETED
        run.completed_at = datetime.now(UTC)

        emit(
            EvalEvent.RUN_COMPLETED,
            correlation_id=correlation_id,
            run_id=run_id,
            overall_gate=overall_gate.value if overall_gate else None,
            verdict_status=verdict_status.value if verdict_status else None,
            root_cause=root_cause.root_cause_metric_id if root_cause else None,
            review_queue_count=len(review_queue),
        )

        return run

    def _compose_kpis(
        self,
        run_id: str,
        experiment: ExperimentDefinition,
        metric_results: list[MetricResult],
        rows: list[EvaluationRow],
        kpis: list,
        kpi_compositions: dict[str, dict],
    ) -> list[KpiResult]:
        """Aggregate row-level metrics into KPI scorecards."""
        by_metric: dict[str, list[float]] = defaultdict(list)
        for mr in metric_results:
            if mr.metric_status == MetricStatus.SCORED and mr.normalised_score is not None:
                by_metric[mr.metric_id].append(mr.normalised_score)

        kpi_results: list[KpiResult] = []

        for kpi_def in kpis:
            composition = kpi_compositions[kpi_def.kpi_id]
            required_ids = set(composition["required"])
            optional_ids = set(composition["optional"])
            fixed_weights = composition["weights"]
            overrides = experiment.kpi_threshold_overrides.get(kpi_def.kpi_id, {})
            t_pass = composition["thresholds"].get("pass", overrides.get("pass", kpi_def.threshold_pass))
            t_warn = composition["thresholds"].get("warn", overrides.get("warn", kpi_def.threshold_warn))

            configured_required_results = [result for result in metric_results if result.metric_id in required_ids and result.metric_requirement == MetricRequirement.REQUIRED]
            required_results = [result for result in configured_required_results if result.metric_applicability == MetricApplicability.APPLICABLE]
            applicable_required_ids = {result.metric_id for result in required_results}
            applicable_weight = sum(fixed_weights.get(metric_id, 0.0) for metric_id in applicable_required_ids)
            effective_weights = {metric_id: fixed_weights[metric_id] / applicable_weight for metric_id in applicable_required_ids if applicable_weight > 0 and metric_id in fixed_weights}

            constituents: list[ConstituentScore] = []
            weighted_sum = 0.0
            # A required constituent can be SCORED on every row (satisfying
            # `required_complete` below) yet still carry no usable
            # normalised_score anywhere (the same SCORED-without-a-score edge
            # case `_row_defect_rate` guards against). Silently `continue`-ing
            # past it here would drop its weight from the sum without
            # renormalising the rest -- deflating the composite instead of
            # marking it inconclusive.
            composite_missing_required_score = False

            for metric_id, weight in effective_weights.items():
                scores = by_metric.get(metric_id, [])
                if not scores:
                    composite_missing_required_score = True
                    continue
                mean_score = sum(scores) / len(scores)
                constituents.append(
                    ConstituentScore(
                        metric_id=metric_id,
                        weight=weight,
                        raw_score=mean_score,
                        normalised_score=mean_score,
                        sample_size=len(scores),
                    )
                )
                weighted_sum += weight * mean_score

            relevant = [result for result in metric_results if result.metric_id in required_ids | optional_ids and result.metric_applicability == MetricApplicability.APPLICABLE]
            optional_results = [result for result in relevant if result.metric_requirement == MetricRequirement.OPTIONAL]
            expected_required_pairs = {
                (row.row_id, metric_id) for row in rows for metric_id in required_ids
            }
            expected_required_pairs -= {
                (result.row_id, result.metric_id)
                for result in metric_results
                if result.metric_id in required_ids
                and result.metric_applicability == MetricApplicability.NOT_APPLICABLE
            }
            required_scored_pairs = {
                (result.row_id, result.metric_id)
                for result in required_results
                if result.metric_status == MetricStatus.SCORED
            }
            required_error_pairs = {
                (result.row_id, result.metric_id)
                for result in required_results
                if result.metric_status == MetricStatus.TECHNICAL_ERROR
            }
            required_scored = len(expected_required_pairs & required_scored_pairs)
            required_errors = len(expected_required_pairs & required_error_pairs)
            required_unscored = len(expected_required_pairs) - required_scored - required_errors
            optional_scored = sum(result.metric_status == MetricStatus.SCORED for result in optional_results)
            required_complete = bool(expected_required_pairs) and required_scored == len(expected_required_pairs)
            if not expected_required_pairs:
                coverage_label = None
            elif required_complete:
                coverage_label = CoverageLabel.COMPLETE
            elif required_scored:
                coverage_label = CoverageLabel.PARTIAL
            else:
                coverage_label = CoverageLabel.INCOMPLETE
            observed_score = round(weighted_sum, 4) if effective_weights else None
            composite = round(weighted_sum, 4) if required_complete and applicable_required_ids and not composite_missing_required_score else None

            if not required_complete or not applicable_required_ids:
                gate = None
            elif any(result.metric_id in composition["hard_blockers"] and result.metric_status == MetricStatus.SCORED and result.threshold_result == GateResult.FAIL for result in required_results):
                gate = GateResult.FAIL
            elif kpi_def.zero_tolerance:
                # Zero-tolerance is a per-row guarantee: any single row with a
                # defect on a constituent metric counts, so we measure the
                # fraction of defective rows — not the average of row means,
                # which would mask a single bad row.
                defect_rate = _row_defect_rate(
                    metric_results,
                    applicable_required_ids,
                    rows,
                )
                if defect_rate is None:
                    # No constituent metric produced a usable score even
                    # though completeness says "scored" — inconclusive, not
                    # a pass. Mirrors the `not required_complete` case above.
                    gate = None
                elif defect_rate == 0:
                    gate = GateResult.PASS
                elif defect_rate <= experiment.safety_defect_tolerance:
                    gate = GateResult.WARN
                else:
                    gate = GateResult.FAIL
            elif composite is None:
                # required_complete said every row was SCORED, but a required
                # constituent still produced no usable normalised_score
                # (composite_missing_required_score) -- inconclusive, not a
                # threshold verdict computed against a deflated weighted sum.
                gate = None
            else:
                gate = threshold_result(composite, t_pass, t_warn)

            kpi_results.append(
                KpiResult(
                    kpi_id=kpi_def.kpi_id,
                    run_id=run_id,
                    composite_score=composite,
                    gate_result=gate,
                    observed_score=observed_score,
                    constituent_scores=constituents,
                    threshold_pass=t_pass,
                    threshold_warn=t_warn,
                    threshold_fail=t_warn,
                    dataset_version=experiment.dataset_version,
                    experiment_id=experiment.experiment_id or run_id,
                    evaluated_target=experiment.target_endpoint,
                    required_applicable_pair_count=len(expected_required_pairs),
                    required_scored_count=required_scored,
                    required_unscored_count=required_unscored,
                    required_technical_error_count=required_errors,
                    required_coverage_percentage=(
                        round(required_scored / len(expected_required_pairs) * 100, 2)
                        if expected_required_pairs
                        else None
                    ),
                    coverage_label=coverage_label,
                    optional_applicable_pair_count=len(optional_results),
                    optional_scored_count=optional_scored,
                    optional_coverage_percentage=(round(optional_scored / len(optional_results) * 100, 2) if optional_results else None),
                )
            )

        return kpi_results

    def _build_review_queue(
        self,
        rows: list[EvaluationRow],
        metric_results: list[MetricResult],
    ) -> list[ReviewQueueItem]:
        """Build the human review queue from the rows that actually failed.

        The queue is per row, and it used to be skipped entirely whenever the
        aggregate gate passed. KPI scores are means across rows, so one required
        metric failing on a single case sat under a passing average and never
        reached a reviewer — while ``diagnose_root_cause``, which reads every
        result, still named that failure on the run report. A case that failed a
        required threshold is worth a look whatever the run averaged to; the
        aggregate answers "can this release", not "did anything go wrong".
        """
        row_map = {r.row_id: r for r in rows}
        by_row: dict[str, list[MetricResult]] = defaultdict(list)
        for mr in metric_results:
            by_row[mr.row_id].append(mr)

        queue: list[ReviewQueueItem] = []
        for row_id, results in by_row.items():
            # Same test the root-cause diagnosis uses, so the two cannot disagree
            # about which metrics failed (see the short circuit above for the one
            # thing they can still disagree about).
            failing = [r for r in results if metric_result_failed(r)]
            if not failing:
                continue
            row = row_map.get(row_id)
            if not row:
                continue
            worst = worst_gate([r.threshold_result for r in failing])
            queue.append(
                ReviewQueueItem(
                    row_id=row_id,
                    query=row.query,
                    response=row.response,
                    trace_id=row.trace_id,
                    failing_metrics=[r.metric_id for r in failing],
                    failing_metric_details=[
                        FailingMetricDetail(
                            metric_id=r.metric_id,
                            score=r.score,
                            normalised_score=r.normalised_score,
                            threshold=r.threshold,
                            threshold_result=r.threshold_result,
                        )
                        for r in failing
                    ],
                    gate_result=worst,
                    rationale=failing[0].rationale,
                )
            )
        return queue


def validate_unique_example_ids(rows: list[EvaluationRow]) -> None:
    """Reject ambiguous per-run evidence identities before any scoring occurs."""
    example_ids = [row.row_id for row in rows]
    duplicates = sorted(example_id for example_id in set(example_ids) if example_ids.count(example_id) > 1)
    if duplicates:
        raise ValueError("Duplicate example IDs are not allowed within a run: " + ", ".join(duplicates))


def _resolved_requirements(
    *,
    manifest: ResolvedRunManifest | None,
    scoring_configuration: ResolvedScoringConfiguration | None,
    active_metric_ids: list[str],
    explicitly_selected: bool,
    scenario,
) -> dict[str, tuple[MetricRequirement, MetricRequirementSource]]:
    """Return the immutable requirement decision used throughout execution."""

    if manifest and manifest.metric_requirements:
        resolved = {item.metric_id: (item.requirement, item.source) for item in manifest.metric_requirements}
        return {metric_id: resolved[metric_id] for metric_id in active_metric_ids}
    if scoring_configuration and scoring_configuration.metric_requirements:
        resolved = {item.metric_id: (item.requirement, item.source) for item in scoring_configuration.metric_requirements}
        return {metric_id: resolved[metric_id] for metric_id in active_metric_ids}

    scenario_primary = set(SCENARIO_METRICS.get(scenario, []))
    cross_cutting = set(CROSS_CUTTING_METRICS)
    resolved: dict[str, tuple[MetricRequirement, MetricRequirementSource]] = {}
    for metric_id in active_metric_ids:
        if explicitly_selected:
            source = MetricRequirementSource.EXPLICIT_SELECTION
        elif metric_id in scenario_primary:
            source = MetricRequirementSource.LEGACY_SCENARIO_PRIMARY
        elif metric_id in cross_cutting:
            source = MetricRequirementSource.LEGACY_CROSS_CUTTING
        else:
            source = MetricRequirementSource.EXPLICIT_SELECTION
        # Operations metrics (latency / tokens / cost / efficiency) describe
        # operational cost, not release quality. Absent an approved Quality
        # Contract that explicitly elevates them (the manifest / scoring
        # configuration paths above), they stay optional so they never gate the
        # verdict and missing telemetry surfaces as unscored, not a failure.
        requirement = MetricRequirement.OPTIONAL if _is_operations_metric(metric_id) else MetricRequirement.REQUIRED
        resolved[metric_id] = (requirement, source)
    return resolved


def _is_operations_metric(metric_id: str) -> bool:
    """Return whether a metric is an operational (``ops.*``) cost signal."""

    return metric_id.startswith("ops.")


def _hard_blocker_gate(
    blocker_metric_ids: list[str],
    metric_results: list[MetricResult],
) -> GateResult | None:
    """Decide the run-level veto a hard blocker carries on its own.

    A blocker is a pass/fail veto, not a weighted contribution, so it does not
    need a KPI composition to be honoured. Routing blockers only through KPI
    gates meant the catalogue metrics that constitute no KPI — every
    content-safety, ops and nlp metric — could never block a release.

    Returns ``None`` when nothing scored: blockers resolve as REQUIRED, so an
    unscored one is already caught by the required-completeness check above and
    must not be silently read as a pass here.
    """

    blockers = set(blocker_metric_ids)
    scored = [
        result
        for result in metric_results
        if result.metric_id in blockers
        and result.metric_applicability == MetricApplicability.APPLICABLE
        and result.metric_status == MetricStatus.SCORED
    ]
    if not scored:
        return None
    return (
        GateResult.FAIL
        if any(result.threshold_result == GateResult.FAIL for result in scored)
        else GateResult.PASS
    )


def _required_kpi_gate_is_incomplete(
    kpi: KpiResult,
    composition: dict,
    metric_results: list[MetricResult],
) -> bool:
    """Fail closed on missing results, but not on an entirely N/A KPI.

    A configured required constituent remains an integrity requirement until it
    produces a result. Once every row explicitly classifies that constituent as
    not applicable, it leaves the runtime gate rather than forcing a permanent
    inconclusive verdict.
    """

    configured_ids = set(composition["required"])
    if not configured_ids:
        return False
    configured_results = [result for result in metric_results if result.metric_id in configured_ids and result.metric_requirement == MetricRequirement.REQUIRED]
    if configured_ids - {result.metric_id for result in configured_results}:
        return True
    if not any(result.metric_applicability == MetricApplicability.APPLICABLE for result in configured_results):
        return False
    return kpi.gate_result is None


def _resolved_kpi_compositions(
    *,
    manifest: ResolvedRunManifest | None,
    scoring_configuration: ResolvedScoringConfiguration | None,
    active_metric_ids: list[str],
    kpis: list,
    requirement_by_metric: dict[str, tuple[MetricRequirement, MetricRequirementSource]],
) -> dict[str, dict]:
    """Pin KPI membership and weights before any metric execution begins."""

    if manifest and manifest.kpi_compositions:
        return {
            item.kpi_id: {
                "required": item.required_gate_constituents,
                "optional": item.optional_diagnostic_constituents,
                "weights": item.fixed_gate_weights,
                "thresholds": item.thresholds,
                "hard_blockers": item.hard_blocker_metric_ids,
            }
            for item in manifest.kpi_compositions
        }
    if scoring_configuration and scoring_configuration.kpi_compositions:
        return {
            item.kpi_id: {
                "required": item.required_gate_constituents,
                "optional": item.optional_diagnostic_constituents,
                "weights": item.fixed_gate_weights,
                "thresholds": item.thresholds,
                "hard_blockers": item.hard_blocker_metric_ids,
            }
            for item in scoring_configuration.kpi_compositions
        }

    selected = set(active_metric_ids)
    compositions: dict[str, dict] = {}
    for kpi in kpis:
        required = sorted(metric_id for metric_id in selected.intersection(kpi.constituent_metrics) if requirement_by_metric[metric_id][0] == MetricRequirement.REQUIRED)
        optional = sorted(selected.intersection(kpi.constituent_metrics) - set(required))
        total = sum(kpi.constituent_metrics[metric_id] for metric_id in required)
        weights = {metric_id: kpi.constituent_metrics[metric_id] / total for metric_id in required} if total else {}
        compositions[kpi.kpi_id] = {
            "required": required,
            "optional": optional,
            "weights": weights,
            "thresholds": {
                "pass": kpi.threshold_pass,
                "warn": kpi.threshold_warn,
                "fail": kpi.threshold_warn,
            },
            "hard_blockers": [],
        }
    return compositions


def _pre_run_not_applicable_result(
    *,
    config,
    experiment: ExperimentDefinition,
    row: EvaluationRow,
    run_id: str,
    requirement: MetricRequirement,
    source: MetricRequirementSource,
    threshold: float,
    reason: str,
) -> MetricResult:
    """Record the launch-frozen known-N/A decision for one (metric, row) pair."""

    return MetricResult(
        metric_id=config.metric_id,
        evaluator_instance_id=config.instance_id,
        run_id=run_id,
        row_id=row.row_id,
        metric_requirement=requirement,
        metric_requirement_source=source,
        metric_applicability=MetricApplicability.NOT_APPLICABLE,
        metric_status=None,
        score=None,
        normalised_score=None,
        passed=None,
        threshold_result=None,
        threshold=threshold,
        prompt_version=config.prompt_version,
        judge_model=_recorded_judge_model(config, experiment, row),
        trace_id=row.trace_id,
        dataset_version=experiment.dataset_version,
        sample_input={"query": row.query, "context": row.context},
        sample_output={"response": row.response},
        evaluator_id=config.evaluator_id,
        evaluator_version=config.evaluator_version,
        execution_status="not_applicable",
        execution_metadata={
            "reason": reason,
            "applicability_source": "pre_run_readiness",
            "execution_policy": config.execution_policy,
        },
        requested_scorer=config.adapter.value,
    )


def _technical_error_result(
    *,
    config,
    experiment: ExperimentDefinition,
    row: EvaluationRow,
    run_id: str,
    requirement: MetricRequirement,
    source: MetricRequirementSource,
    threshold: float,
    message: str,
    metadata: dict,
    executed_scorer: str | None = None,
) -> MetricResult:
    """Persist evaluator failure without fabricating a quality score."""

    return MetricResult(
        metric_id=config.metric_id,
        evaluator_instance_id=config.instance_id,
        run_id=run_id,
        row_id=row.row_id,
        metric_requirement=requirement,
        metric_requirement_source=source,
        metric_status=MetricStatus.TECHNICAL_ERROR,
        error_details={"message": message, "type": "evaluator_execution_error"},
        score=None,
        normalised_score=None,
        passed=None,
        threshold_result=None,
        error_message=message,
        threshold=threshold,
        prompt_version=config.prompt_version,
        judge_model=_recorded_judge_model(config, experiment, row),
        trace_id=row.trace_id,
        dataset_version=experiment.dataset_version,
        sample_input={"query": row.query, "context": row.context},
        sample_output={"response": row.response},
        evaluator_id=config.evaluator_id,
        evaluator_version=config.evaluator_version,
        execution_status="error",
        execution_metadata=metadata,
        requested_scorer=config.adapter.value,
        executed_scorer=executed_scorer,
    )


def _recorded_judge_model(config, experiment: ExperimentDefinition, row: EvaluationRow) -> str | None:
    """Record a judge model only when this metric actually used a model-backed evaluator."""

    adapter = getattr(config.adapter, "value", str(config.adapter))
    if adapter == "deterministic":
        return None
    if adapter == "trace" and row.from_agent:
        return None
    return config.judge_model or experiment.judge_model


def _row_excluded_from_scoring(row: EvaluationRow) -> bool:
    """Rows that failed the agent stream budget must not pollute evaluation scores."""

    if (row.tags or {}).get("error_type") == "AGENT_OUTPUT_TOO_LARGE":
        return True
    err = row.invocation_error or ""
    if err.startswith("AGENT_OUTPUT_TOO_LARGE"):
        return True
    output = row.output_data if isinstance(row.output_data, dict) else {}
    return output.get("error_type") == "AGENT_OUTPUT_TOO_LARGE"


def scoped_row_for_tool_selection(
    row: EvaluationRow,
    selected_tool_ids: list[str] | None,
) -> EvaluationRow:
    """Return the scoring view of a row for the selected-tools level.

    When a run is scoped to named tools, scoring must see only those tools'
    calls and expectations: unselected tools' calls are excluded from scoring
    but are never removed from the captured row — the original ``row`` (the
    persisted evidence) is returned untouched when no selection exists and is
    never mutated. Tool-name matching is case-insensitive, mirroring the trace
    scorer's normalisation.
    """

    if selected_tool_ids is None:
        return row
    selected = {name.strip().casefold() for name in selected_tool_ids if name.strip()}

    def _in_scope(name: str) -> bool:
        return name.strip().casefold() in selected

    return row.model_copy(
        update={
            "tool_calls": [call for call in row.tool_calls if _in_scope(call.name)],
            "expected_tools": [name for name in row.expected_tools if _in_scope(name)],
            "expected_data": _scoped_expected_data(row.expected_data, selected),
        }
    )


def _scoped_expected_data(
    expected_data: dict | None,
    selected: set[str],
) -> dict | None:
    """Filter declared expected tool calls/actions down to the selected tools."""

    if not expected_data:
        return expected_data
    scoped = dict(expected_data)
    for key in ("expected_tool_calls", "expected_actions", "actions"):
        value = scoped.get(key)
        if isinstance(value, list):
            scoped[key] = [item for item in value if not isinstance(item, dict) or str(item.get("name") or item.get("tool") or "").strip().casefold() in selected]
        elif isinstance(value, str):
            kept = [action for action in value.split(";") if (match := _ACTION_TOOL_NAME.match(action)) is None or match.group(1).casefold() in selected]
            scoped[key] = ";".join(kept)
    return scoped


_ACTION_TOOL_NAME = re.compile(r"^\s*([A-Za-z_]\w*)\s*\(")


def _metric_not_applicable(metric_id: str, row: EvaluationRow) -> str | None:
    """Why this metric does not apply to this case, or None if it does.

    Returns the reason rather than a bare flag: the caller records it, and one
    hardcoded string described a single cause while covering several.
    """

    if metric_id == "rag.document_recall":
        from evalhub.evaluation.adapters.deterministic_adapter import document_expectation

        expected, declared = document_expectation(row)
        if declared and not expected:
            return "the case declares no expected documents"
        return None

    if requires_retrieved_context(metric_id) and not row.context and row.trace_span_count:
        # The same absence the retrieval evidence category reports as expected.
        # Judging grounding against context a target never retrieved is not a
        # measurement: the declared scorer refuses outright, and what reached the
        # report was a substitute score standing in for evidence that was never
        # going to exist. The read trace separates that from uncaptured
        # retrieval -- with no trace read we cannot tell, so this stays silent.
        return "the target retrieved nothing, so there is no context to judge against"

    trusted_zero = row.from_agent and not row.trace_unavailable and row.tool_evidence_completion_attested and not row.tool_calls
    if not trusted_zero:
        return None
    if metric_id in {"agent.tool_call_accuracy", "agent.tool_selection"}:
        # No call is a real failure when the golden case says a tool should
        # have been used; it is N/A only when no tool action was expected.
        if row.expected_tools:
            return None
        return "trusted complete evidence confirms no tool call occurred"
    if metric_id in {"agent.tool_input_accuracy", "agent.tool_output_utilisation"}:
        return "trusted complete evidence confirms no tool call occurred"
    return None


def _missing_required_evidence(config, row: EvaluationRow) -> list[str]:
    """Return unavailable evidence categories declared by this evaluator."""

    required = set(config.required_evidence_categories)
    missing: list[str] = []
    if "tool_calls" in required and (row.trace_unavailable or not row.tool_evidence_completion_attested):
        missing.append("tool_calls")
    if "tool_results" in required:
        if row.trace_unavailable or not row.tool_evidence_completion_attested or any(not _tool_result_available(tool) for tool in row.tool_calls):
            missing.append("tool_results")
    return missing


def _incomplete_trace_diagnostic(row: EvaluationRow) -> str | None:
    """Return the archive's precise lifecycle failure for metric abstention."""

    output = row.output_data or {}
    reason = output.get("archive_fallback_reason") or output.get("archive_pending_reason")
    if reason in {"root_span_missing", "completion_marker_missing", "archive_not_settled", "incomplete_trajectory"}:
        return str(reason)
    return None


def _tool_result_available(tool) -> bool:
    """Treat explicit null results as captured and historical nulls as unknown."""

    if tool.result_captured is not None:
        return tool.result_captured
    return tool.output is not None


def _kpi_for_metric(metric_id: str, kpis: list):
    """Find the KPI definition that contains a metric."""
    for kpi in kpis:
        if metric_id in kpi.constituent_metrics:
            return kpi
    return None


def _row_defect_rate(metric_results: list[MetricResult], constituent_metrics: set[str], rows: list[EvaluationRow]) -> float | None:
    """Fraction of rows with a defect on any of the KPI's constituent metrics.

    A row is defective if any constituent metric on that row normalises below a
    perfect score. Used for zero-tolerance KPIs (e.g. Safety & Trust).

    The denominator is ``rows`` — every row in the run — never just the rows
    that happen to carry a usable score. Silently shrinking the denominator to
    scored-rows-only would let a run where half the rows never produced a
    usable ``normalised_score`` (e.g. SCORED status but a missing score) read
    as a clean 0% defect rate instead of the inconclusive result it actually
    is. Returns ``None`` — inconclusive, not a pass — whenever any expected row
    lacks a usable score for its constituent metrics. Mirrors
    ``_hard_blocker_gate``'s ``None`` return for "nothing scored".
    """
    by_row: dict[str, list[float]] = defaultdict(list)
    for mr in metric_results:
        if mr.metric_id in constituent_metrics and mr.normalised_score is not None:
            by_row[mr.row_id].append(mr.normalised_score)

    expected_row_ids = {row.row_id for row in rows}
    if not expected_row_ids or not expected_row_ids.issubset(by_row.keys()):
        return None

    defective = sum(1 for row_id in expected_row_ids if any(s < 1.0 for s in by_row[row_id]))
    return defective / len(expected_row_ids)
