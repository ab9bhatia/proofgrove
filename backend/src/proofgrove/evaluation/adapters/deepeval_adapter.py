"""DeepEval adapter — answer-quality and safety metrics.

Uses DeepEval's ``GEval`` (rubric metrics), ``ToxicityMetric`` and
``HallucinationMetric``, driven by a custom :class:`DeepEvalBaseLLM` that reuses
the native judge's OpenAI-compatible client. This keeps all model traffic on the
configured backend (OpenAI / Azure / Compass / Proofgrove AI Gateway) rather than
DeepEval's default direct-to-OpenAI path.
"""

import json
import logging

from proofgrove.evaluation.adapters.scale import binary_label, unit_to_raw
from proofgrove.evaluation.enums import ScoringType
from proofgrove.evaluation.llm_judge import JudgeResult, LLMJudge
from proofgrove.evaluation.metrics import get_metric
from proofgrove.evaluation.models import EvaluationRow, EvaluatorConfig
from proofgrove.platform.quality_contract_templates import QUALITY_CONTRACT_TEMPLATES
from proofgrove.settings import Settings

logger = logging.getLogger(__name__)

# DeepEval reports these as a "badness" ratio (higher = worse), so the goodness
# unit is ``1 - score`` before scale conversion.
_INVERTED_METRICS = {"safety.general", "safety.ungrounded_attributes"}


def supported_metrics() -> set[str]:
    """Return the metric ids this adapter can score."""
    builtins = {
        "llm.correctness",
        "llm.relevance",
        "llm.coherence",
        "llm.fluency",
        "llm.guideline_adherence",
        "agent.tool_output_utilisation",
        "agent.task_adherence",
        "agent.response_completeness",
        "safety.general",
        "safety.ungrounded_attributes",
    }
    return builtins | {template.metric_id for template in QUALITY_CONTRACT_TEMPLATES}


class _GatewayDeepEvalModel:
    """DeepEval model that delegates generation to the native judge's client."""

    # Imported lazily so the module loads without deepeval installed.
    def __new__(cls, settings: Settings):
        from deepeval.models import DeepEvalBaseLLM

        class _Model(DeepEvalBaseLLM):
            def __init__(self, cfg: Settings) -> None:
                self._judge = LLMJudge(cfg)
                self._max_tokens = cfg.judge_max_tokens

            def load_model(self):
                return self

            def get_model_name(self) -> str:
                return self._judge.model

            def _complete(self, prompt: str, schema=None):
                request = self._judge._build_request(
                    self._judge.model,
                    [{"role": "user", "content": prompt}],
                    0.0,
                    self._max_tokens,
                )
                completion = self._judge.client.chat.completions.create(**request)
                content = completion.choices[0].message.content or "{}"
                if schema is not None:
                    return schema.model_validate(json.loads(content))
                return content

            def generate(self, prompt: str, schema=None, *args, **kwargs):
                return self._complete(prompt, schema)

            async def a_generate(self, prompt: str, schema=None, *args, **kwargs):
                return self._complete(prompt, schema)

        return _Model(settings)


def _score_anchors(anchors: dict) -> list | None:
    """Map declared score anchors onto DeepEval's ``Rubric``.

    Anchors are declared once per metric as ``{score: meaning}``. Keys arrive as
    integers in-process and as strings once the config has been through JSON, so
    both are accepted. G-Eval sorts and rejects overlapping ranges itself; one
    band per score point cannot overlap.
    """
    if not anchors:
        return None

    from deepeval.metrics.g_eval.g_eval import Rubric

    return [
        Rubric(score_range=(int(score), int(score)), expected_outcome=str(meaning))
        for score, meaning in sorted(anchors.items(), key=lambda item: int(item[0]))
    ]


def _deepeval_tool_calls(tool_calls: list) -> list | None:
    """Map captured calls onto DeepEval's ``ToolCall``.

    Only the fields both sides agree on: the name, the arguments it was called
    with, and what it returned. ``description`` and ``reasoning`` are DeepEval's
    own annotations and we have nothing truthful to put in them.
    """

    from deepeval.test_case import ToolCall

    mapped = [
        ToolCall(name=call.name, input_parameters=call.args or None, output=call.output)
        for call in tool_calls
        if getattr(call, "name", None)
    ]
    # [] and None are distinguishable to DeepEval, and they are different
    # claims: [] asserts the agent called no tools, None says we were not told.
    # A row with no captured calls cannot support the stronger one.
    return mapped or None


def _build_metric(metric_id: str, model, adapter_config: dict | None = None):
    """Construct the DeepEval metric for a given proofgrove metric id."""
    from deepeval.metrics import GEval, HallucinationMetric, ToxicityMetric
    try:
        from deepeval.test_case import SingleTurnParams as P
    except ImportError:  # Older supported releases use the original name.
        from deepeval.test_case import LLMTestCaseParams as P

    common = {"model": model, "async_mode": False}

    definition = get_metric(metric_id)
    rubric = adapter_config or {}
    criteria = rubric.get("criteria") or (definition.criteria if definition else None)
    evaluation_steps = rubric.get("evaluation_steps") or (definition.evaluation_steps if definition else [])
    evaluation_params = rubric.get("evaluation_params") or (definition.evaluation_params if definition else [])

    # The metrics below carry a built-in rubric, but the router still resolves
    # criteria and evaluation steps from the metric definition. Let a supplied
    # rubric win so scoring guidance can be tuned as data; fall back to the
    # built-in wording when nothing is supplied. G-Eval accepts both fields
    # together and rejects only an empty string or an empty step list.
    steps = evaluation_steps or None
    anchors = _score_anchors(rubric.get("score_anchors") or (definition.score_anchors if definition else {}))

    if metric_id == "llm.correctness":
        return GEval(
            name="Correctness",
            criteria=criteria
            or "Determine whether the actual output is factually correct given the expected output.",
            evaluation_steps=steps,
            rubric=anchors,
            evaluation_params=[P.INPUT, P.ACTUAL_OUTPUT, P.EXPECTED_OUTPUT],
            threshold=0.5,
            **common,
        )
    if metric_id == "agent.task_adherence":
        # Trace-based: given a DeepEval trace it reads the trajectory, and
        # without one it falls to an input/actual_output/tools_called path
        # upstream marks for deprecation. We populate tools_called so that path
        # sees the calls rather than inferring completion from prose alone.
        from deepeval.metrics import TaskCompletionMetric

        return TaskCompletionMetric(threshold=rubric.get("threshold_pass", 0.5), **common)

    if metric_id == "agent.response_completeness":
        # No purpose-built equivalent in either framework; GEval is the same
        # generic judge the native path used. What it adds is enforcement: the
        # declared 1-5 bands become a Rubric with a real score_range, instead of
        # the judge reasoning on G-Eval's 0-10 default and being mapped as 1-5.
        return GEval(
            name="Response Completeness",
            criteria=criteria
            or "Assess how much of what the user asked for the actual output covers.",
            evaluation_steps=steps,
            rubric=anchors,
            evaluation_params=evaluation_params or [P.INPUT, P.ACTUAL_OUTPUT],
            **common,
        )

    if metric_id == "llm.relevance":
        return GEval(
            name="Relevance",
            criteria=criteria
            or "Assess how well the actual output addresses and stays relevant to the input query.",
            evaluation_steps=steps,
            rubric=anchors,
            evaluation_params=[P.INPUT, P.ACTUAL_OUTPUT],
            **common,
        )
    if metric_id == "llm.coherence":
        return GEval(
            name="Coherence",
            criteria=criteria or "Assess the logical structure, organisation and flow of the actual output.",
            evaluation_steps=steps,
            rubric=anchors,
            evaluation_params=[P.INPUT, P.ACTUAL_OUTPUT],
            **common,
        )
    if metric_id == "llm.fluency":
        return GEval(
            name="Fluency",
            criteria=criteria
            or "Assess the grammatical quality, readability and natural fluency of the actual output.",
            evaluation_steps=steps,
            rubric=anchors,
            evaluation_params=[P.ACTUAL_OUTPUT],
            **common,
        )
    if metric_id == "llm.guideline_adherence":
        return GEval(
            name="GuidelineAdherence",
            criteria=criteria
            or "Determine whether the actual output complies with organisational guidelines and policy.",
            evaluation_steps=steps,
            rubric=anchors,
            evaluation_params=[P.INPUT, P.ACTUAL_OUTPUT],
            threshold=0.5,
            **common,
        )
    if metric_id == "agent.tool_output_utilisation":
        return GEval(
            name="ToolOutputUtilisation",
            criteria=criteria
            or (
                "Assess whether the final answer correctly uses the material facts in the "
                "captured tool results, without ignoring or contradicting them."
            ),
            evaluation_steps=steps,
            rubric=anchors,
            evaluation_params=[P.INPUT, P.ACTUAL_OUTPUT, P.CONTEXT],
            **common,
        )
    if metric_id == "safety.general":
        return ToxicityMetric(include_reason=True, **common)
    if metric_id == "safety.ungrounded_attributes":
        return HallucinationMetric(include_reason=True, **common)

    if definition and criteria and definition.adapter_class == "deepeval.g_eval.quality_contract":
        parameter_map = {
            "input": P.INPUT,
            "actual_output": P.ACTUAL_OUTPUT,
            "expected_output": P.EXPECTED_OUTPUT,
            "context": P.CONTEXT,
        }
        return GEval(
            name=definition.name,
            criteria=criteria,
            evaluation_steps=steps,
            rubric=anchors,
            evaluation_params=[
                parameter_map[param]
                for param in evaluation_params
                if param in parameter_map
            ],
            threshold=float(rubric.get("threshold_pass", definition.default_threshold_pass)),
            **common,
        )

    raise ValueError(f"DeepEval adapter cannot score metric {metric_id}")


def _tool_call_descriptions(tool_calls: list) -> list[str]:
    """Render each captured call as one line the rubric can reason about.

    Names and arguments, not just results — those are what "the right tool with
    plausible arguments" is a claim about.
    """

    lines: list[str] = []
    for call in tool_calls:
        name = getattr(call, "name", None) or "unnamed tool"
        args = getattr(call, "args", None)
        rendered = json.dumps(args, default=str, sort_keys=True) if args else "no arguments"
        lines.append(f"Tool call: {name} with {rendered}")
    return lines


class DeepEvalJudge:
    """Judge implementation backed by DeepEval metrics."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._model = _GatewayDeepEvalModel(settings)
        self._metrics: dict[str, object] = {}

    def _metric(self, config: EvaluatorConfig):
        cache_key = f"{config.metric_id}:{hash(json.dumps(config.adapter_config, sort_keys=True, default=str))}"
        if cache_key not in self._metrics:
            rubric = {**config.adapter_config, "threshold_pass": config.threshold_pass}
            self._metrics[cache_key] = _build_metric(config.metric_id, self._model, rubric)
        return self._metrics[cache_key]

    def evaluate(self, config: EvaluatorConfig, row: EvaluationRow) -> JudgeResult:
        from deepeval.test_case import LLMTestCase

        metric_def = get_metric(config.metric_id)
        if metric_def is None or config.metric_id not in supported_metrics():
            raise ValueError(f"DeepEval adapter cannot score metric {config.metric_id}")

        contexts = list(row.context) if row.context else None
        if config.metric_id == "safety.ungrounded_attributes" and not contexts:
            raise ValueError("HallucinationMetric requires context")
        # A metric that judges *which* tools ran cannot do it from tool output
        # alone. Hydration flattens tool results into ``context`` as plain text,
        # so a rubric asking whether the right tool was called with plausible
        # arguments never saw the call — only what it returned. Metrics that
        # declare tool_calls as required evidence get the calls themselves.
        if "tool_calls" in (metric_def.required_evidence_categories or []) and row.tool_calls:
            contexts = [*(contexts or []), *_tool_call_descriptions(row.tool_calls)]

        test_case = LLMTestCase(
            input=row.query,
            actual_output=row.response,
            expected_output=row.expected_response,
            retrieval_context=contexts,
            context=contexts,
            tools_called=_deepeval_tool_calls(row.tool_calls),
        )

        metric = self._metric(config)
        metric.measure(test_case)

        if metric.score is None:
            # No opinion is not a 0.0. Defaulting it here previously turned a
            # metric DeepEval failed to compute into a real score — and for an
            # inverted safety metric (badness -> goodness = 1 - score), that
            # default reported the *safest possible* verdict for content the
            # scorer never actually judged.
            raise ValueError(f"DeepEval metric {config.metric_id} returned no score")

        raw_unit = float(metric.score)
        unit = (1.0 - raw_unit) if config.metric_id in _INVERTED_METRICS else raw_unit

        scaled = unit_to_raw(unit, metric_def.scoring_type, metric_def.score_range)
        label = binary_label(unit) if metric_def.scoring_type == ScoringType.BINARY else None
        rationale = getattr(metric, "reason", None) or f"DeepEval score: {raw_unit:.3f}."

        return JudgeResult(
            score=scaled,
            label=label,
            rationale=str(rationale),
            prompt_tokens=0,
            completion_tokens=0,
        )
