"""Scenario router — metric set selection based on scenario and ground truth."""

from proofgrove.evaluation.enums import Scenario
from proofgrove.evaluation.evidence_requirements import metric_evidence_categories
from proofgrove.evaluation.kpis import KPI_SCENARIO_MAP, get_kpis_for_scenario
from proofgrove.evaluation.metrics import METRIC_CATALOG, MetricDefinition
from proofgrove.evaluation.models import EvaluatorConfig, ExperimentDefinition, KpiDefinition
from proofgrove.platform.evaluators import execution_mode_for_adapter, execution_policy_for_mode

# Scenario-specific primary metrics
SCENARIO_METRICS: dict[Scenario, list[str]] = {
    Scenario.LLM_CORE: [
        "llm.correctness",
        "llm.relevance",
        "llm.coherence",
        "llm.fluency",
        "llm.similarity",
    ],
    Scenario.RAG: [
        "rag.groundedness",
        "rag.chunk_relevance",
        "rag.context_sufficiency",
        "rag.document_recall",
        "rag.retrieval_quality",
        "llm.relevance",
        "llm.coherence",
    ],
    Scenario.AGENTIC: [
        "agent.task_adherence",
        "agent.intent_resolution",
        "agent.tool_call_accuracy",
        "agent.tool_selection",
        "agent.response_completeness",
        "rag.groundedness",
        "llm.relevance",
    ],
}

# Always-on cross-cutting metrics
CROSS_CUTTING_METRICS = [
    "safety.general",
    "safety.ungrounded_attributes",
    "llm.guideline_adherence",
    "ops.latency",
    "ops.total_token_count",
    # The halves the total is made of. All three read the same usage the target
    # reported, so reporting only the sum withheld the breakdown at no saving --
    # and the breakdown is what an expensive run needs: a large prompt and a
    # large answer are different problems with different fixes.
    "ops.input_token_count",
    "ops.output_token_count",
    "ops.token_efficiency",
]

# Ground-truth-only metrics, derived from the catalogue rather than restated.
# These were two lists of the same fact and they drifted: a metric declared
# ``requires_ground_truth`` in the catalogue stayed absent here, so the legacy
# path kept selecting it on reference-less datasets and it failed into a
# substitute scorer instead of being excluded.
GROUND_TRUTH_METRICS = {
    metric_id
    for metric_id, definition in METRIC_CATALOG.items()
    if definition.requires_ground_truth
}


def select_metrics(
    scenario: Scenario,
    has_ground_truth: bool = True,
    metric_ids: list[str] | None = None,
    metric_definitions: list[MetricDefinition] | None = None,
) -> list[MetricDefinition]:
    """Return a profile-selected metric set or the legacy scenario battery."""
    selected_ids = set(metric_ids) if metric_ids is not None else set(SCENARIO_METRICS.get(scenario, []))
    if metric_ids is None:
        selected_ids.update(CROSS_CUTTING_METRICS)

    if not has_ground_truth:
        selected_ids -= GROUND_TRUTH_METRICS

    catalog = dict(METRIC_CATALOG)
    catalog.update({metric.metric_id: metric for metric in metric_definitions or []})
    return [catalog[mid] for mid in sorted(selected_ids) if mid in catalog]


def select_kpis(scenario: Scenario) -> list[KpiDefinition]:
    """Return applicable KPIs for a scenario."""
    return get_kpis_for_scenario(scenario)


def build_evaluator_configs(
    experiment: ExperimentDefinition,
    metric_ids: list[str] | None = None,
    evaluator_refs: dict[str, str] | None = None,
    metric_definitions: list[MetricDefinition] | None = None,
) -> tuple[list[MetricDefinition], list[EvaluatorConfig], list[KpiDefinition]]:
    """Build profile-selected or legacy scenario evaluator configs and KPIs."""
    metrics = select_metrics(experiment.scenario, experiment.has_ground_truth, metric_ids, metric_definitions)
    selected_metric_ids = {metric.metric_id for metric in metrics}
    kpis = [
        kpi
        for kpi in select_kpis(experiment.scenario)
        if selected_metric_ids.intersection(kpi.constituent_metrics)
    ]

    configs: list[EvaluatorConfig] = []
    for metric in metrics:
        reference = (evaluator_refs or {}).get(metric.metric_id)
        evaluator_id, evaluator_version = _evaluator_reference(reference, metric.default_adapter.value)
        execution_mode = execution_mode_for_adapter(metric.default_adapter)
        configs.append(
            EvaluatorConfig(
                metric_id=metric.metric_id,
                instance_id=f"{metric.metric_id}::{experiment.experiment_id or 'default'}",
                adapter=metric.default_adapter,
                adapter_class=metric.adapter_class,
                scoring_type=metric.scoring_type,
                score_range=metric.score_range,
                normalisation_formula=metric.normalisation_formula,
                adapter_config={
                    "criteria": metric.criteria,
                    "evaluation_steps": metric.evaluation_steps,
                    "evaluation_params": metric.evaluation_params,
                    "score_anchors": metric.score_anchors,
                },
                requires_ground_truth=metric.requires_ground_truth,
                requires_trace=metric.requires_trace,
                required_evidence_categories=metric_evidence_categories(metric),
                judge_model=experiment.judge_model,
                judge_temperature=experiment.judge_temperature,
                threshold_pass=metric.default_threshold_pass,
                threshold_warn=metric.default_threshold_warn,
                threshold_fail=metric.default_threshold_warn,
                required_inputs=metric.evaluation_params or _required_inputs(metric.metric_id),
                evaluator_id=evaluator_id,
                evaluator_version=evaluator_version,
                execution_mode=execution_mode.value,
                execution_policy=execution_policy_for_mode(execution_mode),
            )
        )

    return metrics, configs, kpis


def _evaluator_reference(reference: str | None, adapter: str) -> tuple[str, str]:
    if reference and "@" in reference:
        evaluator_id, version = reference.rsplit("@", 1)
        if evaluator_id and version:
            return evaluator_id, version
    return f"builtin.{adapter}", "1.0.0"


def _required_inputs(metric_id: str) -> list[str]:
    """Return required input fields for a metric."""
    base = ["query", "response"]
    if metric_id.startswith("rag."):
        base.append("context")
    if metric_id.startswith("agent."):
        base.append("trace")
    if metric_id in GROUND_TRUTH_METRICS:
        base.append("expected_response")
    return base


def get_scenario_info() -> list[dict]:
    """Return scenario metadata for API."""
    return [
        {
            "id": Scenario.LLM_CORE,
            "name": "LLM Core",
            "description": "Direct LLM response quality evaluation",
            "primary_kpis": [k for k, m in KPI_SCENARIO_MAP.items() if Scenario.LLM_CORE in m and m[Scenario.LLM_CORE] == "primary"],
        },
        {
            "id": Scenario.RAG,
            "name": "RAG",
            "description": "Retrieval-augmented generation pipeline evaluation",
            "primary_kpis": [k for k, m in KPI_SCENARIO_MAP.items() if Scenario.RAG in m and m[Scenario.RAG] == "primary"],
        },
        {
            "id": Scenario.AGENTIC,
            "name": "Agentic",
            "description": "Agent task execution and tool use evaluation",
            "primary_kpis": [k for k, m in KPI_SCENARIO_MAP.items() if Scenario.AGENTIC in m and m[Scenario.AGENTIC] == "primary"],
        },
    ]
