"""Report export and CI/CD gate callback payloads."""

from datetime import UTC, datetime
from typing import Any

from proofgrove.evaluation.enums import GateResult
from proofgrove.evaluation.models import RunResult
from proofgrove.evaluation.release_eligibility import release_eligibility, release_gate_violation

# Fallback for ungoverned (and historical) runs whose lineage carries no
# resolved review triggers; mirrors the gate-policy / quality-profile default.
_DEFAULT_REVIEW_TRIGGER_GATES = (GateResult.WARN, GateResult.FAIL)


def _review_required(run: RunResult) -> bool:
    """Whether the resolved policy flags this run's gate for human review."""
    if run.overall_gate is None:
        return False
    gates = (run.lineage.review_trigger_gates if run.lineage else None) or _DEFAULT_REVIEW_TRIGGER_GATES
    return run.overall_gate in gates


def build_report(run: RunResult) -> dict[str, Any]:
    """Build a JSON report export payload."""
    return {
        "report_version": "1.0",
        "generated_at": datetime.now(UTC).isoformat(),
        "run_id": run.run_id,
        "run_number": run.run_number,
        "run_type": run.run_type.value if run.run_type else None,
        "role": run.role.value if run.role else None,
        "experiment": run.experiment.model_dump(mode="json"),
        "trigger_reason": run.trigger_reason.value,
        "correlation_id": run.correlation_id,
        "retry_count": run.retry_count,
        "experiment_version_id": run.experiment_version_id,
        "prompt_version": run.prompt_version,
        "lineage": run.lineage.model_dump(mode="json") if run.lineage else None,
        "verdict_status": run.verdict_status.value if run.verdict_status else None,
        "overall_gate": run.overall_gate.value if run.overall_gate else None,
        "release_eligibility": release_eligibility(run),
        "diagnostic_only": run.diagnostic_only,
        "evidence_readiness": (
            run.evidence_readiness.model_dump(mode="json")
            if run.evidence_readiness
            else None
        ),
        "evidence_capture_status": run.evidence_capture_status.value,
        "evidence_categories": [
            category.model_dump(mode="json") for category in run.evidence_categories
        ],
        "status": run.status.value,
        "created_by": run.created_by,
        "git_sha": run.git_sha,
        "build_id": run.build_id,
        "deployment_id": run.deployment_id,
        "duration_ms": run.duration_ms,
        "artifact_refs": run.artifact_refs,
        "kpi_scorecards": [
            {
                "kpi_id": k.kpi_id,
                "composite_score": k.composite_score,
                "gate_result": k.gate_result.value if k.gate_result else None,
                "observed_score": k.observed_score,
                "required_applicable_pair_count": k.required_applicable_pair_count,
                "required_scored_count": k.required_scored_count,
                "required_unscored_count": k.required_unscored_count,
                "required_technical_error_count": k.required_technical_error_count,
                "required_coverage_percentage": k.required_coverage_percentage,
                "coverage_label": k.coverage_label.value if k.coverage_label else None,
                "optional_applicable_pair_count": k.optional_applicable_pair_count,
                "optional_scored_count": k.optional_scored_count,
                "optional_coverage_percentage": k.optional_coverage_percentage,
                "threshold_pass": k.threshold_pass,
                "threshold_warn": k.threshold_warn,
                "constituent_scores": [c.model_dump() for c in k.constituent_scores],
            }
            for k in run.kpi_results
        ],
        "metric_summary": _metric_summary(run),
        "scorer_provenance": _scorer_provenance(run),
        "root_cause": run.root_cause.model_dump() if run.root_cause else None,
        "review_queue_count": len(run.review_queue),
        "review_queue": [r.model_dump() for r in run.review_queue],
        "active_metrics": run.active_metrics,
        "started_at": run.started_at.isoformat(),
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
    }


def build_ci_callback(run: RunResult) -> dict[str, Any]:
    """Build a CI/CD gate callback payload."""
    return {
        "event": "evaluation.gate_decision",
        "timestamp": datetime.now(UTC).isoformat(),
        "run_id": run.run_id,
        "experiment_id": run.experiment.experiment_id,
        "experiment_name": run.experiment.name,
        "experiment_version_id": run.experiment_version_id,
        "correlation_id": run.correlation_id,
        "trigger_reason": run.trigger_reason.value,
        "prompt_version": run.prompt_version,
        "target_endpoint": run.experiment.target_endpoint,
        "dataset_version": run.experiment.dataset_version,
        "scenario": run.experiment.scenario.value,
        "domain": run.experiment.domain,
        "verdict_status": run.verdict_status.value if run.verdict_status else None,
        "gate_decision": run.overall_gate.value if run.overall_gate else None,
        # Derived from release_gate_violation, the single source of truth for release
        # eligibility (see release_eligibility.py) -- the prior inline verdict+gate
        # check missed diagnostic-only runs, ungoverned runs, and incomplete evidence,
        # all of which must block release regardless of the verdict/gate values alone.
        "release_allowed": release_gate_violation(run) is None,
        "kpi_gates": {
            k.kpi_id: {
                "score": k.composite_score,
                "gate": k.gate_result.value if k.gate_result else None,
            }
            for k in run.kpi_results
        },
        "root_cause": run.root_cause.root_cause_metric_id if run.root_cause else None,
        "remediation": run.root_cause.recommended_remediation if run.root_cause else None,
        "review_required": _review_required(run),
        "review_queue_count": len(run.review_queue),
    }


def _scorer_provenance(run: RunResult) -> list[dict[str, Any]]:
    """Disclose which scorer was asked for and which one actually ran, per result.

    Identifiers and result state only — the report is an aggregate document and
    deliberately carries no case text.
    """
    return [
        {
            "metric_id": mr.metric_id,
            "row_id": mr.row_id,
            "requested_scorer": mr.requested_scorer,
            "executed_scorer": mr.executed_scorer,
            "metric_status": mr.metric_status.value if mr.metric_status else None,
            "unscored_reason": mr.unscored_reason.value if mr.unscored_reason else None,
        }
        for mr in run.metric_results
    ]

def _metric_summary(run: RunResult) -> dict[str, dict[str, float]]:
    """Aggregate metric scores across all rows."""
    by_metric: dict[str, list[float]] = {}
    for mr in run.metric_results:
        if mr.normalised_score is not None:
            by_metric.setdefault(mr.metric_id, []).append(mr.normalised_score)

    return {
        mid: {
            "mean": round(sum(scores) / len(scores), 4),
            "min": round(min(scores), 4),
            "max": round(max(scores), 4),
            "count": len(scores),
        }
        for mid, scores in by_metric.items()
    }
