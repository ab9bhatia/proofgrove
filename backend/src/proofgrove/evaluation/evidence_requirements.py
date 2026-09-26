"""Deterministic evidence requirements shared by resolution and execution."""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from proofgrove.evaluation.enums import EvaluationScope
from proofgrove.evaluation.models import MetricDefinition

CAPTURE_EVIDENCE_CATEGORIES = (
    "input",
    "final_output",
    "tool_calls",
    "tool_results",
    "trace",
    "retrieval",
    "model_usage",
    "lifecycle_events",
)
_CATEGORY_ORDER = CAPTURE_EVIDENCE_CATEGORIES

# DeepEval judge params and older UI labels that name the same capture facts.
_CAPTURE_EVIDENCE_ALIASES = {
    "actual_output": "final_output",
    "retrieval_context": "retrieval",
    "context": "retrieval",
}

_SCOPE_REQUIREMENTS: dict[EvaluationScope, tuple[str, ...]] = {
    EvaluationScope.FINAL_RESPONSE: ("input", "final_output"),
    EvaluationScope.TOOL_INTERACTIONS: (
        "input",
        "final_output",
        "tool_calls",
        "tool_results",
    ),
    EvaluationScope.FULL_EXECUTION: _CATEGORY_ORDER,
}


def requires_retrieved_context(metric_id: str) -> bool:
    """Whether a metric cannot be scored without retrieved context.

    Derived from the catalogue rather than restated: every RAGAS-bound scorer
    rejects an empty context list outright, and one safety metric judges claims
    against context by definition. Hand-listing these is how such a list drifted
    from the catalogue it duplicated once already.
    """
    from proofgrove.evaluation.enums import Adapter
    from proofgrove.evaluation.metrics import METRIC_CATALOG

    if metric_id == "safety.ungrounded_attributes":
        return True
    definition = METRIC_CATALOG.get(metric_id)
    return bool(definition and definition.default_adapter == Adapter.RAGAS)


def metric_evidence_categories(metric: MetricDefinition) -> list[str]:
    """Return one metric's canonical evidence dependencies.

    ``requires_trace`` predates explicit evidence categories. Preserve its
    legacy call-and-result semantics when reading older metric definitions.
    """

    categories = metric.required_evidence_categories or (
        ["tool_calls", "tool_results"] if metric.requires_trace else []
    )
    return canonical_evidence_categories(categories)


def resolve_metric_evidence_requirements(
    metrics: Iterable[MetricDefinition],
) -> dict[str, list[str]]:
    """Pin evidence dependencies for every selected metric."""

    return {
        metric.metric_id: metric_evidence_categories(metric)
        for metric in sorted(metrics, key=lambda item: item.metric_id)
    }


def resolve_effective_evidence_requirements(
    evaluation_scope: EvaluationScope,
    metric_requirements: Mapping[str, Iterable[str]],
) -> list[str]:
    """Return the fixed scope-plus-metrics evidence union."""

    categories = list(_SCOPE_REQUIREMENTS[evaluation_scope])
    for metric_id in sorted(metric_requirements):
        categories.extend(metric_requirements[metric_id])
    return canonical_evidence_categories(categories)


def resolve_evaluation_scope(
    requested_scope: EvaluationScope,
    effective_requirements: Iterable[str],
) -> EvaluationScope:
    """Promote a requested scope to the evidence its configuration requires."""

    categories = set(effective_requirements)
    if categories.intersection({"trace", "retrieval", "model_usage", "lifecycle_events"}):
        required_scope = EvaluationScope.FULL_EXECUTION
    elif categories.intersection({"tool_calls", "tool_results"}):
        required_scope = EvaluationScope.TOOL_INTERACTIONS
    else:
        required_scope = EvaluationScope.FINAL_RESPONSE
    order = {
        EvaluationScope.FINAL_RESPONSE: 0,
        EvaluationScope.TOOL_INTERACTIONS: 1,
        EvaluationScope.FULL_EXECUTION: 2,
    }
    return required_scope if order[required_scope] > order[requested_scope] else requested_scope


def scope_promotion_reasons(
    requested_scope: EvaluationScope,
    resolved_scope: EvaluationScope,
    metric_requirements: Mapping[str, Iterable[str]],
) -> list[dict[str, str]]:
    """Explain which metric evidence dependencies promoted the scope."""

    if requested_scope == resolved_scope:
        return []
    requested_categories = set(_SCOPE_REQUIREMENTS[requested_scope])
    reasons: list[dict[str, str]] = []
    for metric_id in sorted(metric_requirements):
        for category in canonical_evidence_categories(metric_requirements[metric_id]):
            if category not in requested_categories:
                reasons.append(
                    {
                        "source_type": "metric",
                        "source_id": metric_id,
                        "evidence_category": category,
                    }
                )
    return reasons


def canonical_evidence_categories(categories: Iterable[str]) -> list[str]:
    """Deduplicate evidence categories with stable known-first ordering."""

    unique = {str(category).strip() for category in categories if str(category).strip()}
    known = [category for category in _CATEGORY_ORDER if category in unique]
    return [*known, *sorted(unique - set(_CATEGORY_ORDER))]


def recognized_capture_categories(categories: Iterable[str]) -> list[str]:
    """Return only evidence categories represented by the capture contract.

    Quality Contracts may also name review artifacts (for example a gate
    report). Those remain immutable contract evidence requirements, but they
    must not silently expand the runtime capture scope.
    """

    unique = {str(category).strip() for category in categories if str(category).strip()}
    return [category for category in _CATEGORY_ORDER if category in unique]


def canonicalize_capture_requirements(categories: Iterable[str]) -> list[str]:
    """Map known aliases and reject names the runtime capture contract cannot enforce.

    Manual or human-review artifacts are an open product decision. Until that
    decision lands, required evidence on a Profile or Gate Policy must be a
    canonical capture category so the stored list is the same list execution
    can actually require.
    """

    mapped: list[str] = []
    unknown: list[str] = []
    seen: set[str] = set()
    for raw in categories:
        name = str(raw).strip()
        if not name:
            continue
        category = _CAPTURE_EVIDENCE_ALIASES.get(name, name)
        if category not in _CATEGORY_ORDER:
            unknown.append(name)
            continue
        if category not in seen:
            seen.add(category)
            mapped.append(category)
    if unknown:
        allowed = ", ".join(_CATEGORY_ORDER)
        raise ValueError(
            "required evidence must use canonical runtime capture categories "
            f"({allowed}); unrecognised: {', '.join(sorted(set(unknown)))}"
        )
    return [category for category in _CATEGORY_ORDER if category in seen]
