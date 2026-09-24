"""Root-cause diagnosis — causal order from skills.md / TDD Appendix B."""

from evalhub.evaluation.enums import GateResult, MetricRequirement, MetricStatus
from evalhub.evaluation.metrics import get_metric
from evalhub.evaluation.models import MetricResult, RootCauseDiagnosis


def metric_result_failed(result: MetricResult) -> bool:
    """Did this metric actually return a failing verdict?

    Two things are not failures. A diagnostic metric has no budget to miss, and a
    metric with no threshold records ``threshold_result=None`` — an absent verdict,
    which ``!= PASS`` used to read as a failure. Between them they put every
    operational reading into the review queue and the root-cause diagnosis, so a
    correct answer that was merely slow arrived as a CRITICAL finding titled by
    token counts.

    The review queue and the diagnosis must agree on this, or the run report
    contradicts itself on one screen.
    """
    return (
        result.metric_status == MetricStatus.SCORED
        and result.metric_requirement != MetricRequirement.OPTIONAL
        and result.threshold_result in (GateResult.WARN, GateResult.FAIL)
    )


CAUSAL_ORDER_WITH_GT = [
    "rag.context_sufficiency",
    "rag.groundedness",
    "llm.correctness",
    "safety.general",
    "llm.guideline_adherence",
]

CAUSAL_ORDER_WITHOUT_GT = [
    "rag.chunk_relevance",
    "rag.groundedness",
    "llm.relevance",
    "safety.general",
    "llm.guideline_adherence",
]

REMEDIATION_MAP = {
    "rag.context_sufficiency": "Fix: Expand retriever recall or add missing documents to the knowledge base.",
    "rag.groundedness": "Fix: Improve prompt grounding instructions or tighten retriever precision.",
    "rag.chunk_relevance": "Fix: Retune embedding model or adjust chunking strategy for better retrieval precision.",
    "rag.document_recall": "Fix: Broaden retrieval (top-k, query expansion) so expected documents are retrieved.",
    "rag.retrieval_quality": "Fix: Review the end-to-end retrieval pipeline — indexing, chunking, and ranking.",
    "llm.correctness": "Fix: Review model selection, fine-tuning data, or prompt engineering for factual accuracy.",
    "llm.relevance": "Fix: Refine system prompt to ensure responses address the user query directly.",
    "llm.coherence": "Fix: Add structure/formatting guidance to the prompt to improve logical flow.",
    "llm.fluency": "Fix: Adjust decoding parameters or model choice to improve language quality.",
    "llm.similarity": "Fix: Align the response format and content with the expected answer style.",
    "safety.general": "Fix: Enable content safety filters and review system prompt for safety guidelines.",
    "safety.violence": "Fix: Strengthen violence safeguards, refusal behavior, and adversarial regression coverage.",
    "safety.sexual": "Fix: Strengthen sexual-content safeguards and age-sensitive refusal behavior.",
    "safety.self_harm": "Fix: Strengthen self-harm crisis handling, safe-completion guidance, and escalation paths.",
    "safety.hate_unfairness": "Fix: Review bias safeguards and expand protected-group fairness tests.",
    "safety.protected_material": "Fix: Add protected-material refusal and transformation limits to the system policy.",
    "safety.indirect_attack": "Fix: Treat retrieved and tool-provided instructions as untrusted data and tighten injection defenses.",
    "safety.code_vulnerability": "Fix: Add secure-coding constraints and static security validation for generated code.",
    "llm.guideline_adherence": "Fix: Update system prompt with explicit organisational guidelines and compliance rules.",
    "agent.task_adherence": "Fix: Review agent orchestration logic and task decomposition strategy.",
    "agent.intent_resolution": "Fix: Improve intent classification or add clarification steps to the agent workflow.",
    "agent.tool_call_accuracy": "Fix: Validate tool schemas and add retry/error-handling for tool invocations.",
    "agent.tool_selection": "Fix: Review tool descriptions and agent routing logic.",
    "agent.tool_input_accuracy": "Fix: Align generated tool arguments with the declared schema and golden action inputs.",
    "agent.tool_output_utilisation": "Fix: Require the agent to incorporate relevant tool results before composing its final response.",
    "agent.response_completeness": "Fix: Prompt the agent to fully address every part of the task before finishing.",
    "safety.ungrounded_attributes": "Fix: Add grounding constraints to prevent unsupported attribute claims.",
    "ops.latency": "Fix: Optimise slow calls — caching, smaller models, or reduced retrieval fan-out.",
    "ops.total_token_count": "Fix: Trim prompt/context size or cap max tokens to reduce token consumption.",
    "ops.input_token_count": "Fix: Reduce system instructions and retrieved context sent to the target model.",
    "ops.output_token_count": "Fix: Tighten response requirements and cap unnecessary target-model output.",
    "ops.token_efficiency": "Fix: Improve useful output per token — tighter prompts and less redundant context.",
    "nlp.f1_score": "Fix: Include the expected answer's key terms without adding unrelated text.",
    "nlp.bleu": "Fix: Align important wording and short phrases with the expected response where lexical fidelity matters.",
    "nlp.rouge": "Fix: Preserve the expected response's key content and ordering more completely.",
    "nlp.meteor": "Fix: Improve token-level coverage while keeping related terms in a coherent order.",
    "nlp.gleu": "Fix: Balance expected phrase coverage with precise, non-redundant wording.",
    "quality.task_completion": "Fix: Revisit task decomposition and ensure every explicit requirement is completed before responding.",
    "quality.tool_correctness": "Fix: Tighten tool selection guidance, argument validation, and use of returned evidence.",
    "quality.plan_quality": "Fix: Make dependencies explicit, remove contradictory steps, and adapt the plan to intermediate results.",
    "quality.groundedness": "Fix: Require claims to cite retrieved context or tool evidence and reject unsupported assertions.",
    "quality.safety_policy": "Fix: Strengthen refusal, authorization, and secret-handling policy in the system instructions.",
    "quality.error_recovery": "Fix: Add transparent retry, clarification, and failure-handling paths instead of assuming success.",
    "quality.response_clarity": "Fix: Simplify the response, state the outcome directly, and make next steps explicit.",
    "quality.action_efficiency": "Fix: Remove redundant calls and loops, and shorten the trajectory to the minimum useful steps.",
}


def diagnose_root_cause(
    metric_results: list[MetricResult],
    has_ground_truth: bool = True,
) -> RootCauseDiagnosis:
    """Identify the likely root cause from failing metrics in causal order."""
    causal_order = CAUSAL_ORDER_WITH_GT if has_ground_truth else CAUSAL_ORDER_WITHOUT_GT

    failing_by_metric: dict[str, list[MetricResult]] = {}
    for mr in metric_results:
        if metric_result_failed(mr):
            failing_by_metric.setdefault(mr.metric_id, []).append(mr)

    failing_ids = list(failing_by_metric.keys())
    if not failing_ids:
        return RootCauseDiagnosis(
            has_ground_truth=has_ground_truth,
            causal_chain=causal_order,
        )

    root_cause_id: str | None = None
    for metric_id in causal_order:
        if metric_id in failing_by_metric:
            root_cause_id = metric_id
            break

    if root_cause_id is None:
        root_cause_id = failing_ids[0]

    return RootCauseDiagnosis(
        root_cause_metric_id=root_cause_id,
        root_cause_label=_metric_label(root_cause_id),
        causal_chain=causal_order,
        failing_metrics=failing_ids,
        recommended_remediation=REMEDIATION_MAP.get(
            root_cause_id,
            f"Review failing metric: {root_cause_id}",
        ),
        has_ground_truth=has_ground_truth,
    )


def _metric_label(metric_id: str) -> str:
    """Human-readable metric label sourced from the metric catalog."""
    metric = get_metric(metric_id)
    return metric.name if metric else metric_id
