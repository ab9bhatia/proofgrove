"""Backend-owned release eligibility for evaluation runs.

Eligibility is derived at read/decision time — never stored. A release-governed
configuration alone never implies release-eligible. Diagnostic and standardized
(profile, no gate) runs are never release evidence.
"""

from __future__ import annotations

from typing import Any

from evalhub.evaluation.enums import (
    EvidenceCaptureStatus,
    EvidenceCategoryStatus,
    GateResult,
    RunStatus,
    VerdictStatus,
)


def release_gate_violation(run: Any) -> dict[str, str] | None:
    """Why this run cannot receive a release decision, or ``None`` if it can.

    Fail closed: unfinished execution, inconclusive verdict, incomplete required
    evidence, and any non-PASS gate outcome (including WARN) all block. WARN/FAIL
    exceptions are not modelled here.
    """

    if getattr(run, "diagnostic_only", False):
        return {
            "code": "diagnostic_run_not_releasable",
            "message": "This run is diagnostic-only and cannot be used as release evidence.",
        }
    if not (getattr(run, "quality_profile_id", None) and getattr(run, "gate_policy_id", None)):
        return {
            "code": "run_not_governed",
            "message": (
                "This run is not release-governed: no quality profile and gate "
                "policy were resolved for it, so it cannot receive a release decision."
            ),
        }

    status = getattr(run, "status", None)
    status_value = status.value if hasattr(status, "value") else status
    if status_value != RunStatus.COMPLETED.value:
        return {
            "code": "run_not_completed",
            "message": (
                f"The run status is {status_value or 'missing'}; only a completed "
                "run can receive a release decision."
            ),
        }

    verdict = getattr(run, "verdict_status", None)
    if verdict != VerdictStatus.CONCLUSIVE:
        verdict_label = verdict.value if hasattr(verdict, "value") else (verdict or "missing")
        return {
            "code": "verdict_not_conclusive",
            "message": (
                f"The run verdict is {verdict_label}; only a conclusive run can "
                "receive a release decision."
            ),
        }

    missing_required = sorted(
        category.category
        for category in (getattr(run, "evidence_categories", None) or [])
        if category.required and category.status != EvidenceCategoryStatus.CAPTURED
    )
    # Fails closed on the status alone. Requiring a *named* missing category as
    # well read absence as sufficiency: a run that never classified its evidence
    # carries UNKNOWN with an empty category list, so there was nothing to name
    # and the release proceeded on evidence no one had examined.
    if getattr(run, "evidence_capture_status", None) != EvidenceCaptureStatus.COMPLETE:
        return {
            "code": "evidence_incomplete",
            "message": (
                "Required evidence is incomplete for this run: "
                f"{', '.join(missing_required)}."
                if missing_required
                else (
                    "Evidence capture was never confirmed for this run, so it "
                    "cannot receive a release decision."
                )
            ),
        }

    overall_gate = getattr(run, "overall_gate", None)
    if overall_gate != GateResult.PASS:
        gate_label = (
            overall_gate.value if hasattr(overall_gate, "value") else (overall_gate or "missing")
        )
        return {
            "code": "gate_outcome_blocks_release",
            "message": (
                f"The release gate outcome is {gate_label}; only a PASS gate "
                "permits a release decision."
            ),
        }
    return None


def release_eligibility(run: Any) -> dict[str, str | None]:
    """Single backend-derived eligibility object for run and report responses."""

    violation = release_gate_violation(run)
    if violation is None:
        return {"status": "eligible", "code": None, "message": None}
    return {
        "status": "ineligible",
        "code": violation["code"],
        "message": violation["message"],
    }
