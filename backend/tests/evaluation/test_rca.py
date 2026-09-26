"""Tests for root-cause diagnosis."""

from proofgrove.evaluation.enums import GateResult
from proofgrove.evaluation.metrics import METRIC_CATALOG
from proofgrove.evaluation.models import MetricResult
from proofgrove.evaluation.rca import REMEDIATION_MAP, _metric_label, diagnose_root_cause


def _metric_result(metric_id: str, row_id: str, gate: GateResult) -> MetricResult:
    return MetricResult(
        metric_id=metric_id,
        evaluator_instance_id=f"{metric_id}::test",
        run_id="run-1",
        row_id=row_id,
        score=0.0 if gate == GateResult.FAIL else 1.0,
        normalised_score=0.0 if gate == GateResult.FAIL else 1.0,
        passed=gate == GateResult.PASS,
        threshold=0.8,
        threshold_result=gate,
        dataset_version="v1",
    )


def test_root_cause_follows_causal_order_with_gt():
    results = [
        _metric_result("llm.correctness", "r1", GateResult.FAIL),
        _metric_result("rag.context_sufficiency", "r1", GateResult.FAIL),
        _metric_result("safety.general", "r1", GateResult.FAIL),
    ]
    rca = diagnose_root_cause(results, has_ground_truth=True)
    assert rca.root_cause_metric_id == "rag.context_sufficiency"


def test_root_cause_without_gt():
    results = [
        _metric_result("llm.relevance", "r1", GateResult.FAIL),
        _metric_result("rag.chunk_relevance", "r1", GateResult.FAIL),
    ]
    rca = diagnose_root_cause(results, has_ground_truth=False)
    assert rca.root_cause_metric_id == "rag.chunk_relevance"


def test_no_failures_no_root_cause():
    results = [
        _metric_result("llm.correctness", "r1", GateResult.PASS),
    ]
    rca = diagnose_root_cause(results)
    assert rca.root_cause_metric_id is None


def test_remediation_covers_every_catalog_metric():
    # P1-11: every metric that can be a root cause has a concrete remediation.
    missing = [mid for mid in METRIC_CATALOG if mid not in REMEDIATION_MAP]
    assert missing == [], f"metrics without remediation: {missing}"


def test_metric_label_sourced_from_catalog():
    # P1-11: labels come from the catalog (no drift from a duplicate map).
    assert _metric_label("rag.context_sufficiency") == METRIC_CATALOG["rag.context_sufficiency"].name
    assert _metric_label("unknown.metric") == "unknown.metric"
