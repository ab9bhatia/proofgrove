"""Backend-owned release eligibility — derived, never stored."""

from types import SimpleNamespace

from evalhub.evaluation.enums import (
    EvidenceCaptureStatus,
    EvidenceCategoryStatus,
    GateResult,
    RunStatus,
    VerdictStatus,
)
from evalhub.evaluation.release_eligibility import (
    release_eligibility,
    release_gate_violation,
)


def _governed_complete(**overrides):
    base = dict(
        status=RunStatus.COMPLETED,
        diagnostic_only=False,
        quality_profile_id="qp-1",
        gate_policy_id="gate-1",
        verdict_status=VerdictStatus.CONCLUSIVE,
        overall_gate=GateResult.PASS,
        evidence_capture_status=EvidenceCaptureStatus.COMPLETE,
        evidence_categories=[
            SimpleNamespace(
                category="final_output",
                required=True,
                status=EvidenceCategoryStatus.CAPTURED,
            )
        ],
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_release_governed_complete_run_is_eligible():
    result = release_eligibility(_governed_complete())
    assert result == {"status": "eligible", "code": None, "message": None}
    assert release_gate_violation(_governed_complete()) is None


def test_diagnostic_and_standardized_never_eligible():
    diagnostic = release_eligibility(
        _governed_complete(diagnostic_only=True, quality_profile_id=None, gate_policy_id=None)
    )
    assert diagnostic["status"] == "ineligible"
    assert diagnostic["code"] == "diagnostic_run_not_releasable"

    standardized = release_eligibility(
        _governed_complete(gate_policy_id=None, quality_profile_id="qp-1")
    )
    assert standardized["status"] == "ineligible"
    assert standardized["code"] == "run_not_governed"


def test_unfinished_inconclusive_incomplete_and_non_pass_gate_block():
    unfinished = release_eligibility(_governed_complete(status=RunStatus.RUNNING))
    assert unfinished["code"] == "run_not_completed"

    inconclusive = release_eligibility(
        _governed_complete(verdict_status=VerdictStatus.INCONCLUSIVE)
    )
    assert inconclusive["code"] == "verdict_not_conclusive"

    incomplete = release_eligibility(
        _governed_complete(evidence_capture_status=EvidenceCaptureStatus.PARTIAL)
    )
    assert incomplete["code"] == "evidence_incomplete"

    warn = release_eligibility(_governed_complete(overall_gate=GateResult.WARN))
    assert warn["code"] == "gate_outcome_blocks_release"
    assert warn["status"] == "ineligible"

    failed = release_eligibility(_governed_complete(overall_gate=GateResult.FAIL))
    assert failed["code"] == "gate_outcome_blocks_release"

    missing_gate = release_eligibility(_governed_complete(overall_gate=None))
    assert missing_gate["code"] == "gate_outcome_blocks_release"


def test_build_report_includes_release_eligibility():
    from evalhub.evaluation.enums import Scenario
    from evalhub.evaluation.models import ExperimentDefinition, RunResult
    from evalhub.evaluation.report import build_report

    run = RunResult(
        run_id="run-elig-1",
        experiment=ExperimentDefinition(
            experiment_id="exp-1",
            name="Eligibility",
            dataset_version="ds-1",
            target_endpoint="https://example.test",
            scenario=Scenario.LLM_CORE,
        ),
        status=RunStatus.COMPLETED,
        diagnostic_only=True,
        verdict_status=VerdictStatus.CONCLUSIVE,
        overall_gate=GateResult.PASS,
        evidence_capture_status=EvidenceCaptureStatus.COMPLETE,
    )
    report = build_report(run)
    assert report["release_eligibility"]["status"] == "ineligible"
    assert report["release_eligibility"]["code"] == "diagnostic_run_not_releasable"


def test_build_ci_callback_reports_release_allowed_false_for_diagnostic_run():
    """A diagnostic-only run must never report release_allowed=true, even when
    its verdict is conclusive and its gate is a pass -- release_allowed must be
    derived from release_gate_violation (the single source of truth), not from
    an inline verdict+gate check that can't see diagnostic_only/governance/
    evidence-completeness at all."""

    from evalhub.evaluation.enums import Scenario
    from evalhub.evaluation.models import ExperimentDefinition, RunResult
    from evalhub.evaluation.report import build_ci_callback

    run = RunResult(
        run_id="run-elig-2",
        experiment=ExperimentDefinition(
            experiment_id="exp-2",
            name="Eligibility",
            dataset_version="ds-1",
            target_endpoint="https://example.test",
            scenario=Scenario.LLM_CORE,
        ),
        status=RunStatus.COMPLETED,
        diagnostic_only=True,
        verdict_status=VerdictStatus.CONCLUSIVE,
        overall_gate=GateResult.PASS,
        evidence_capture_status=EvidenceCaptureStatus.COMPLETE,
    )
    callback = build_ci_callback(run)
    assert callback["release_allowed"] is False


def test_build_ci_callback_reports_release_allowed_true_for_governed_complete_run():
    from evalhub.evaluation.enums import Scenario
    from evalhub.evaluation.models import ExperimentDefinition, RunResult
    from evalhub.evaluation.report import build_ci_callback

    run = RunResult(
        run_id="run-elig-3",
        experiment=ExperimentDefinition(
            experiment_id="exp-3",
            name="Eligibility",
            dataset_version="ds-1",
            target_endpoint="https://example.test",
            scenario=Scenario.LLM_CORE,
        ),
        status=RunStatus.COMPLETED,
        diagnostic_only=False,
        quality_profile_id="qp-1",
        gate_policy_id="gate-1",
        verdict_status=VerdictStatus.CONCLUSIVE,
        overall_gate=GateResult.PASS,
        evidence_capture_status=EvidenceCaptureStatus.COMPLETE,
    )
    callback = build_ci_callback(run)
    assert callback["release_allowed"] is True
