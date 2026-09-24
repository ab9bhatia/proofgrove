"""Tests for the evaluator-adapter seam (scale conversion + dispatch fallback)."""

import pytest

from evalhub.evaluation.adapters.dispatcher import AdapterDispatchJudge
from evalhub.evaluation.adapters.scale import binary_label, unit_to_raw
from evalhub.evaluation.engine import EvaluationEngine
from evalhub.evaluation.enums import Adapter, MetricStatus, ScoringType
from evalhub.evaluation.llm_judge import JudgeResult
from evalhub.evaluation.metrics import METRIC_CATALOG, get_metric
from evalhub.evaluation.models import EvaluationRow, EvaluatorConfig
from evalhub.evaluation.normalization import normalise_score
from evalhub.evaluation.sample_data import SAMPLE_EXPERIMENTS, get_sample_rows
from evalhub.settings import Settings


def _config(metric_id: str, adapter: Adapter) -> EvaluatorConfig:
    metric = get_metric(metric_id)
    assert metric is not None
    return EvaluatorConfig(
        metric_id=metric_id,
        instance_id=f"{metric_id}-1",
        adapter=adapter,
        adapter_class=metric.adapter_class,
        scoring_type=metric.scoring_type,
        score_range=metric.score_range,
    )


def _row() -> EvaluationRow:
    return EvaluationRow(
        row_id="r1",
        query="q",
        response="a",
        expected_response="a",
        context=["ctx"],
    )


class _SentinelJudge:
    """Judge that records that it was called and returns a fixed result."""

    def __init__(self) -> None:
        self.calls = 0

    def evaluate(self, config: EvaluatorConfig, row: EvaluationRow) -> JudgeResult:
        self.calls += 1
        return JudgeResult(
            score=0.42,
            label=None,
            rationale="sentinel",
            prompt_tokens=0,
            completion_tokens=0,
        )


class _ExplodingJudge:
    def evaluate(self, config: EvaluatorConfig, row: EvaluationRow) -> JudgeResult:
        raise RuntimeError("scorer exploded")


@pytest.mark.parametrize(
    ("unit", "scoring_type", "score_range", "expected_normalised"),
    [
        (0.9, ScoringType.BINARY, None, 1.0),
        (0.4, ScoringType.BINARY, None, 0.0),
        (0.5, ScoringType.SCALE, (1, 5), 0.5),
        (1.0, ScoringType.SCALE, (1, 5), 1.0),
        (0.75, ScoringType.FLOAT, (0, 1), 0.75),
        (1.0, ScoringType.SEVERITY, (0, 7), 1.0),
        (0.0, ScoringType.SEVERITY, (0, 7), 0.0),
    ],
)
def test_unit_to_raw_round_trips_through_normalisation(unit, scoring_type, score_range, expected_normalised):
    raw = unit_to_raw(unit, scoring_type, score_range)
    normalised = normalise_score(raw, scoring_type, score_range)
    assert normalised == pytest.approx(expected_normalised, abs=1e-6)


def test_binary_label():
    assert binary_label(0.6) == "yes"
    assert binary_label(0.4) == "no"


def test_dispatch_mock_mode_never_imports_frameworks():
    """In mock mode a RAGAS-adapter metric still scores via the mock judge."""
    judge = AdapterDispatchJudge(Settings(judge_mode="mock"))
    result = judge.evaluate(_config("rag.groundedness", Adapter.RAGAS), _row())
    assert isinstance(result, JudgeResult)
    assert result.executed_scorer == Adapter.MOCK.value


def _boom():
    raise RuntimeError("framework exploded")


def test_dispatch_falls_back_to_native_when_framework_errors(monkeypatch):
    judge = AdapterDispatchJudge(Settings(judge_mode="llm", openai_api_key="x"))
    sentinel = _SentinelJudge()
    judge._native = sentinel  # non-mock native so adapters are attempted

    monkeypatch.setattr(judge, "_ragas_judge", _boom)
    result = judge.evaluate(_config("rag.groundedness", Adapter.RAGAS), _row())

    assert sentinel.calls == 1
    assert result.rationale == "sentinel"
    assert result.execution_status == "fallback"
    assert result.error_code == "EVALUATOR_FALLBACK"
    assert result.fallback_from == Adapter.RAGAS.value
    assert result.executed_scorer == Adapter.NATIVE.value


def _forbidden_fallback_judge(monkeypatch) -> AdapterDispatchJudge:
    """Dispatch judge whose framework fails while native fallback is forbidden."""
    judge = AdapterDispatchJudge(Settings(judge_mode="llm", openai_api_key="x", evaluator_allow_native_fallback=False))
    judge._native = _SentinelJudge()  # non-mock native so adapters are attempted
    monkeypatch.setattr(judge, "_ragas_judge", _boom)
    return judge


def test_dispatch_refuses_native_fallback_when_disallowed(monkeypatch):
    """A scorer that could not run must not borrow the native judge's answer."""
    judge = _forbidden_fallback_judge(monkeypatch)

    result = judge.evaluate(_config("rag.groundedness", Adapter.RAGAS), _row())

    assert judge._native.calls == 0
    assert result.execution_status == "error"
    assert result.error_code == "EVALUATOR_FAILURE"
    assert result.rationale != "sentinel"
    assert result.executed_scorer is None


def test_forbidden_fallback_records_no_score_rather_than_zero(monkeypatch):
    """The forbidden fallback must never look like a scorer that ran and scored 0."""
    result = EvaluationEngine(judge=_forbidden_fallback_judge(monkeypatch)).execute(
        SAMPLE_EXPERIMENTS[1],
        get_sample_rows("exp-rag-v1")[:1],
        metric_ids=["rag.groundedness"],
    )

    metric = result.metric_results[0]
    assert metric.metric_status == MetricStatus.TECHNICAL_ERROR
    assert metric.execution_status == "error"
    assert metric.score is None
    assert metric.normalised_score is None
    assert metric.passed is None
    assert metric.threshold_result is None


def test_forbidden_fallback_records_framework_that_failed_during_execution():
    judge = AdapterDispatchJudge(
        Settings(judge_mode="llm", openai_api_key="x", evaluator_allow_native_fallback=False)
    )
    judge._native = _SentinelJudge()
    judge._ragas = _ExplodingJudge()

    result = judge.evaluate(_config("rag.groundedness", Adapter.RAGAS), _row())

    assert result.execution_status == "error"
    assert result.executed_scorer == Adapter.RAGAS.value


def test_engine_records_scorer_that_raised():
    judge = AdapterDispatchJudge(Settings(judge_mode="mock"))
    judge._deterministic = _ExplodingJudge()

    run = EvaluationEngine(judge=judge).execute(
        SAMPLE_EXPERIMENTS[0],
        get_sample_rows("exp-llm-core-v1")[:1],
        metric_ids=["nlp.f1_score"],
    )

    metric = run.metric_results[0]
    assert metric.metric_status == MetricStatus.TECHNICAL_ERROR
    assert metric.requested_scorer == Adapter.DETERMINISTIC.value
    assert metric.executed_scorer == Adapter.DETERMINISTIC.value


def test_dispatch_frameworks_disabled_uses_native(monkeypatch):
    judge = AdapterDispatchJudge(Settings(judge_mode="llm", openai_api_key="x", judge_use_frameworks=False))
    sentinel = _SentinelJudge()
    judge._native = sentinel

    def _should_not_run():
        raise AssertionError("framework judge must not be built when disabled")

    monkeypatch.setattr(judge, "_deepeval_judge", _should_not_run)
    result = judge.evaluate(_config("safety.general", Adapter.DEEPEVAL), _row())

    assert sentinel.calls == 1
    assert result.rationale == "sentinel"
    assert result.executed_scorer == Adapter.NATIVE.value


def test_dispatch_records_framework_that_actually_ran():
    judge = AdapterDispatchJudge(Settings(judge_mode="llm", openai_api_key="x"))
    sentinel = _SentinelJudge()
    judge._ragas = sentinel

    result = judge.evaluate(_config("rag.groundedness", Adapter.RAGAS), _row())

    assert result.executed_scorer == Adapter.RAGAS.value


def test_dispatch_records_no_executed_scorer_when_custom_worker_is_unavailable():
    result = AdapterDispatchJudge(Settings(judge_mode="mock")).evaluate(_config("llm.correctness", Adapter.CUSTOM), _row())

    assert result.execution_status == "error"
    assert result.executed_scorer is None


def test_engine_preserves_requested_and_executed_fallback_provenance(monkeypatch):
    judge = AdapterDispatchJudge(Settings(judge_mode="llm", openai_api_key="x"))
    judge._native = _SentinelJudge()
    monkeypatch.setattr(judge, "_ragas_judge", _boom)

    run = EvaluationEngine(judge=judge).execute(
        SAMPLE_EXPERIMENTS[1],
        get_sample_rows("exp-rag-v1")[:1],
        metric_ids=["rag.groundedness"],
    )

    metric = run.metric_results[0]
    assert metric.requested_scorer == Adapter.RAGAS.value
    assert metric.executed_scorer == Adapter.NATIVE.value
    assert metric.execution_metadata["fallback_from"] == Adapter.RAGAS.value


def test_metric_catalog_adapter_bindings():
    """Guard the framework routing declared in the metric catalog."""
    assert METRIC_CATALOG["rag.groundedness"].default_adapter == Adapter.RAGAS
    assert METRIC_CATALOG["rag.document_recall"].default_adapter == Adapter.DETERMINISTIC
    assert METRIC_CATALOG["llm.correctness"].default_adapter == Adapter.DEEPEVAL
    assert METRIC_CATALOG["safety.general"].default_adapter == Adapter.DEEPEVAL
    assert METRIC_CATALOG["rag.context_sufficiency"].adapter_class == "ragas.context_recall"
    assert METRIC_CATALOG["agent.tool_output_utilisation"].default_adapter == Adapter.DEEPEVAL
    assert METRIC_CATALOG["nlp.bleu"].default_adapter == Adapter.DETERMINISTIC
    assert METRIC_CATALOG["ops.latency"].default_adapter == Adapter.DETERMINISTIC
    assert METRIC_CATALOG["ops.input_token_count"].default_adapter == Adapter.DETERMINISTIC
    assert METRIC_CATALOG["ops.output_token_count"].default_adapter == Adapter.DETERMINISTIC
    # No metric should still point at the removed Azure AI Evaluation adapter.
    assert all(m.default_adapter != Adapter.AZURE_AI_EVAL for m in METRIC_CATALOG.values())


def test_every_inline_specialized_metric_has_an_executable_adapter():
    from evalhub.evaluation.adapters.deepeval_adapter import (
        supported_metrics as deepeval_metrics,
    )
    from evalhub.evaluation.adapters.deterministic_adapter import (
        supported_metrics as deterministic_metrics,
    )
    from evalhub.evaluation.adapters.ragas_adapter import (
        supported_metrics as ragas_metrics,
    )
    from evalhub.evaluation.adapters.trace_adapter import (
        supported_metrics as trace_metrics,
    )

    supported = {
        Adapter.DEEPEVAL: deepeval_metrics(),
        Adapter.DETERMINISTIC: deterministic_metrics(),
        Adapter.RAGAS: ragas_metrics(),
        Adapter.TRACE: trace_metrics(),
    }
    for metric in METRIC_CATALOG.values():
        if not metric.available_in_run or metric.default_adapter not in supported:
            continue
        assert metric.metric_id in supported[metric.default_adapter]


def test_a_framework_that_cannot_initialise_is_disabled_for_the_run(monkeypatch):
    """A framework that cannot start fails identically for every row.

    One of them writes a dot-directory on import, which raises OSError rather
    than ImportError on a read-only root filesystem — so it was installed, could
    never run, and was retried once per case. Treat "cannot start" the same as
    "not installed": disable once, and record it as unavailable rather than as a
    scoring failure.
    """

    def _readonly_fs(*args, **kwargs):
        raise OSError(30, "Read-only file system: '.deepeval'")

    judge = AdapterDispatchJudge(Settings(judge_mode="llm", openai_api_key="x"))
    sentinel = _SentinelJudge()
    judge._native = sentinel  # non-mock native so adapters are attempted
    monkeypatch.setattr(judge, "_deepeval_judge", _readonly_fs)

    first = judge.evaluate(_config("agent.tool_output_utilisation", Adapter.DEEPEVAL), _row())
    assert judge._deepeval_disabled is True
    assert "framework unavailable" in (first.error_message or "")

    # Undo the simulated-import-failure patch so the next call exercises the
    # real `_deepeval_judge`'s own disabled short-circuit (R8), not another
    # simulated import failure — that short-circuit used to raise a bare
    # RuntimeError, which missed both classifier branches in `evaluate()` and
    # fell into the catch-all as "framework failed" instead of "framework
    # unavailable".
    monkeypatch.undo()

    # Second row must not pay the same failure again, and must still be
    # classified the same way as the first.
    second = judge.evaluate(_config("agent.tool_output_utilisation", Adapter.DEEPEVAL), _row())
    assert sentinel.calls == 2
    assert (second.error_message or "").startswith("framework unavailable")


def test_no_rubric_demands_a_reference_it_never_judges_against():
    """A rubric that declares an input the case lacks is rejected outright.

    All eight quality rubrics shared one parameter list that included
    ``expected_output``, so on any dataset without reference answers every one
    of them raised and was silently substituted by the native judge — while the
    catalogue never marked them as needing ground truth. None of their criteria
    compare against a reference.
    """

    from evalhub.platform.quality_contract_templates import QUALITY_CONTRACT_TEMPLATES

    demanding = [template.metric_id for template in QUALITY_CONTRACT_TEMPLATES if "expected_output" in template.evaluation_params]
    assert demanding == []

    # And each still declares something to judge.
    for template in QUALITY_CONTRACT_TEMPLATES:
        assert template.evaluation_params, template.metric_id
        assert "actual_output" in template.evaluation_params, template.metric_id


def test_a_metric_that_judges_tool_choice_receives_the_calls():
    """Tool results are not tool calls.

    Hydration flattens tool *output* into context as plain text. A rubric asking
    whether the right tool was called with plausible arguments cannot answer
    that from output alone, so the calls themselves are passed through.
    """

    from evalhub.evaluation.adapters.deepeval_adapter import _tool_call_descriptions
    from evalhub.evaluation.models import ToolCall

    rendered = _tool_call_descriptions(
        [
            ToolCall(name="search", args={"q": "capital of France"}, output="Paris"),
            ToolCall(name="calculator", args={}, output="4"),
        ]
    )

    assert any("search" in line and "capital of France" in line for line in rendered)
    assert any("calculator" in line and "no arguments" in line for line in rendered)


def test_chunk_relevance_is_scored_by_the_query_only_scorer():
    """A retrieval metric must not move when only the answer changes.

    The same-API alternative, ``LLMContextPrecisionWithoutReference``, declares
    ``response`` among its required columns and returns it from
    ``_get_row_attributes`` — "without reference" means without a gold answer,
    not without the model's output. Measured against a real judge on an
    identical query and identical chunks: that scorer returned 5.0 then 1.0,
    while ``ContextRelevance`` returned 5.0 and 5.0.
    """

    from evalhub.evaluation.adapters.ragas_adapter import (
        _COLLECTIONS_API,
        _RAGAS_METRIC_NAMES,
    )
    from evalhub.evaluation.metrics import METRIC_CATALOG

    # RAGAS owns the RAG metrics.
    assert METRIC_CATALOG["rag.chunk_relevance"].default_adapter == Adapter.RAGAS
    assert _RAGAS_METRIC_NAMES["rag.chunk_relevance"] == "ContextRelevance"

    # And it is scored from the query and chunks alone — no response.
    assert _COLLECTIONS_API["rag.chunk_relevance"] == (
        "user_input",
        "retrieved_contexts",
    )


def test_efficiency_requires_the_calls_it_judges_but_not_every_result():
    """Redundant calls are visible from the calls alone.

    Demanding every result too would leave the metric unscored on one
    uncaptured result while the redundancy it grades was fully observable.
    """

    from evalhub.evaluation.metrics import METRIC_CATALOG

    assert METRIC_CATALOG["quality.action_efficiency"].required_evidence_categories == ["tool_calls"]
    assert METRIC_CATALOG["quality.tool_correctness"].required_evidence_categories == [
        "tool_calls",
        "tool_results",
    ]


def test_ground_truth_requirement_has_one_source_of_truth():
    """The router's exclusion set is derived, not restated.

    It used to be a hand-written list beside the catalogue's own
    ``requires_ground_truth`` flag, and the two drifted: a metric whose scorer
    needs a reference was declared in the catalogue but missing from the list,
    so the legacy path kept selecting it on reference-less datasets and it
    failed into a substitute scorer instead of being excluded.
    """

    from evalhub.evaluation.metrics import METRIC_CATALOG
    from evalhub.evaluation.scenario_router import GROUND_TRUTH_METRICS

    declared = {metric_id for metric_id, definition in METRIC_CATALOG.items() if definition.requires_ground_truth}
    assert GROUND_TRUTH_METRICS == declared
    assert "rag.context_sufficiency" in declared


def test_a_supplied_rubric_reaches_the_built_in_deepeval_metrics():
    """Scoring guidance is data, not something the adapter may discard.

    The router resolves ``criteria`` and ``evaluation_steps`` from the metric
    definition into ``adapter_config`` for every metric. The built-in G-Eval
    branches used to return before that value was ever read, so the guidance was
    silently dropped for eight metrics and a rubric could only be changed by
    editing the adapter. Tuning a rubric is exactly the cheap lever a collapsed
    score distribution calls for, so it must survive the trip.
    """

    from deepeval.models import DeepEvalBaseLLM

    from evalhub.evaluation.adapters.deepeval_adapter import _build_metric

    class _StubModel(DeepEvalBaseLLM):
        """Stands in for the judge so construction needs no API key."""

        def load_model(self):
            return self

        def generate(self, *args, **kwargs):
            return ""

        async def a_generate(self, *args, **kwargs):
            return ""

        def get_model_name(self):
            return "stub"

    model = _StubModel()

    # A metric that declares no rubric of its own keeps the adapter's wording.
    built_in = _build_metric("llm.fluency", model, None)
    assert "grammatical quality" in built_in.criteria
    assert built_in.evaluation_steps is None

    tuned = _build_metric(
        "llm.relevance",
        model,
        {
            "criteria": "Score 1 when the answer ignores the query; 5 when it fully resolves it.",
            "evaluation_steps": ["Identify what the query asks for.", "Judge only that."],
        },
    )
    assert tuned.criteria.startswith("Score 1 when")
    assert tuned.evaluation_steps == [
        "Identify what the query asks for.",
        "Judge only that.",
    ]


def test_declared_score_anchors_become_a_deepeval_rubric():
    """A scale metric should be scored on the scale it declares.

    Without anchors G-Eval judges on its own 0-10 range and the adapter maps the
    normalised result back, so a 1-5 metric returns values like 3.8 that are not
    scale points at all. Declared anchors set the range G-Eval scores on and tell
    it what each point means. Keys survive a JSON round trip through job
    parameters as strings, so both forms must map.
    """

    from deepeval.models import DeepEvalBaseLLM

    from evalhub.evaluation.adapters.deepeval_adapter import _build_metric

    class _StubModel(DeepEvalBaseLLM):
        def load_model(self):
            return self

        def generate(self, *args, **kwargs):
            return ""

        async def a_generate(self, *args, **kwargs):
            return ""

        def get_model_name(self):
            return "stub"

    from evalhub.evaluation.adapters.deepeval_adapter import _score_anchors

    model = _StubModel()
    anchors = {1: "no discernible structure", 3: "disconnected blocks", 5: "one connected whole"}

    # Declaring nothing leaves G-Eval on its own 0-10 range, which is what
    # produced raw scores like 3.8 for a metric whose scale stops at 5.
    assert _score_anchors({}) is None
    assert _build_metric("llm.correctness", model, None).score_range == (0, 10)

    anchored = _build_metric("llm.coherence", model, {"score_anchors": anchors})
    assert anchored.score_range == (1, 5)
    assert [r.score_range for r in anchored.rubric] == [(1, 1), (3, 3), (5, 5)]

    round_tripped = _build_metric(
        "llm.coherence",
        model,
        {"score_anchors": {str(score): text for score, text in anchors.items()}},
    )
    assert round_tripped.score_range == (1, 5)
    assert [r.expected_outcome for r in round_tripped.rubric] == list(anchors.values())


def test_coherence_grades_structure_on_its_declared_scale():
    """Coherence had been answering relevance's question on someone else's scale.

    A response the judge itself called "logically structured and the flow is
    clear" scored 2 out of 5, because it did not address the query. Separately,
    90% of its scores sat at 5 while the judge actually reasoned on G-Eval's
    0-10 default. The metric now declares what each band means and says the
    quality it does not grade, and both must survive with no per-run config.
    """

    from deepeval.models import DeepEvalBaseLLM

    from evalhub.evaluation.adapters.deepeval_adapter import _build_metric
    from evalhub.evaluation.metrics import get_metric

    class _StubModel(DeepEvalBaseLLM):
        def load_model(self):
            return self

        def generate(self, *args, **kwargs):
            return ""

        async def a_generate(self, *args, **kwargs):
            return ""

        def get_model_name(self):
            return "stub"

    definition = get_metric("llm.coherence")
    assert sorted(definition.score_anchors) == [1, 2, 3, 4, 5]

    built = _build_metric("llm.coherence", _StubModel(), None)
    assert built.score_range == definition.score_range
    assert [r.score_range for r in built.rubric] == [(1, 1), (2, 2), (3, 3), (4, 4), (5, 5)]
    assert "do not lower the score for being off topic" in built.criteria


def test_a_grounding_metric_is_unscored_when_no_context_was_retrieved(monkeypatch):
    """The substitute cannot supply evidence the run never captured.

    When the declared scorer refused a context-free row, the native judge scored
    it anyway and a groundedness verdict reached the report with nothing to
    check the answer against. Ten rows in the local database carry such a score.
    Absent evidence is an unscored row, not a number.
    """

    judge = AdapterDispatchJudge(Settings(judge_mode="llm", openai_api_key="x"))
    sentinel = _SentinelJudge()
    judge._native = sentinel

    monkeypatch.setattr(judge, "_ragas_judge", _boom)
    contextless = _row().model_copy(update={"context": []})
    result = judge.evaluate(_config("rag.groundedness", Adapter.RAGAS), contextless)

    assert sentinel.calls == 0, "the substitute must not be asked to guess"
    assert result.score is None
    assert result.missing_evidence == ["retrieval"]
    assert result.fallback_from == Adapter.RAGAS.value

    # A metric that needs no retrieval still falls back normally.
    monkeypatch.setattr(judge, "_deepeval_judge", _boom)
    relevance = judge.evaluate(_config("llm.relevance", Adapter.DEEPEVAL), contextless)
    assert sentinel.calls == 1
    assert relevance.execution_status == "fallback"


def test_declared_anchors_survive_the_fallback_to_the_native_judge():
    """Anchors were rendered for DeepEval's ``Rubric`` and nowhere else.

    Every route back to the native judge — mock mode, ``judge_use_frameworks``
    off, a framework that failed or could not import — dropped them silently, so
    an anchored metric was graded by the fallback on exactly the undefined scale
    the anchors exist to replace. The router already puts ``score_anchors`` in
    ``adapter_config`` for every metric; only the native side ignored it.
    """

    from evalhub.evaluation.prompts import build_judge_messages

    definition = get_metric("llm.coherence")
    assert definition.score_anchors, "fixture depends on coherence staying anchored"

    rubric = build_judge_messages("llm.coherence", "q", "r")[1]["content"]
    for score, meaning in definition.score_anchors.items():
        assert f"{score}: {meaning}" in rubric

    # Per-run tuning reaches the native path too, and string keys survive the
    # round trip through JSON job parameters.
    tuned = build_judge_messages(
        "llm.coherence", "q", "r", score_anchors={"2": "tuned band", "1": "lowest band"}
    )[1]["content"]
    assert "1: lowest band\n2: tuned band" in tuned
    assert definition.score_anchors[5] not in tuned


def test_every_judged_metric_is_claimed_by_an_adapter():
    """Six metrics used to default to NATIVE because no ``supported_metrics()`` named them.

    That was an unclaimed default, not an implementation: they reached the
    generic judge with a single sentence from ``METRIC_RUBRICS`` and no anchors
    — the same undefined-scale defect that collapsed relevance and coherence
    onto 5. Each is now claimed by the framework that scores its question
    directly. ``ops.token_efficiency`` stays native and is the only one that
    should: it is arithmetic on token counts, not a judged opinion, so no
    rubric applies and no reviewer can overrule it.
    """

    from evalhub.evaluation.adapters.deepeval_adapter import supported_metrics as deepeval_claims
    from evalhub.evaluation.adapters.ragas_adapter import supported_metrics as ragas_claims

    native = sorted(
        metric_id
        for metric_id, metric in METRIC_CATALOG.items()
        if metric.default_adapter == Adapter.NATIVE
    )
    assert native == ["ops.token_efficiency"]

    claimed = {
        "llm.similarity": ragas_claims(),
        "rag.retrieval_quality": ragas_claims(),
        "agent.intent_resolution": ragas_claims(),
        "agent.task_adherence": deepeval_claims(),
        "agent.response_completeness": deepeval_claims(),
    }
    for metric_id, supported in claimed.items():
        # A default adapter whose supported_metrics() does not name the metric
        # falls straight back through the dispatcher to the native judge, which
        # is the bug this closes — repointing alone would not have fixed it.
        assert metric_id in supported, f"{metric_id} repointed but unclaimed"


def test_the_reclaimed_metrics_keep_a_real_fallback_rubric():
    """Repointing does not retire the native prompt — it demotes it to the fallback.

    Every one of these still reaches the native judge whenever the framework
    cannot run: frameworks disabled, an import failure, or an id the AI Gateway
    will not route (the local Kind override trims modelRoutes to one model, so
    the embedding metric falls back there every time). The fallback must not be
    the one-line default it was.
    """

    from evalhub.evaluation.prompts import METRIC_RUBRICS, build_judge_messages

    reclaimed = [
        "agent.intent_resolution",
        "agent.response_completeness",
        "agent.task_adherence",
        "llm.similarity",
        "rag.retrieval_quality",
    ]
    for metric_id in reclaimed:
        rubric = build_judge_messages(metric_id, "q", "r")[1]["content"]
        assert METRIC_RUBRICS[metric_id] not in rubric, f"{metric_id} still on the one-line default"
        assert get_metric(metric_id).criteria

    # The two agent metrics share their evidence and had near-identical
    # one-liners; they must now grade different things. task_adherence asks
    # whether the agent followed its instructions; agent.intent_resolution —
    # named "Goal Achievement" since it is scored by RAGAS AgentGoalAccuracy —
    # asks whether the user ended up with what they wanted.
    assert "Judge completion, not quality" in get_metric("agent.task_adherence").criteria
    assert "Judge the outcome, not the effort" in get_metric("agent.intent_resolution").criteria
    # The fallback rubric must ask the primary scorer's question, or a row's
    # meaning depends on whether the framework happened to be reachable.
    assert "achieved" in get_metric("agent.intent_resolution").criteria

    # Only the discrete scale can carry anchors; a 0-1 continuum has no integer
    # points to key on, so its bands are stated in the criteria instead.
    assert sorted(get_metric("agent.response_completeness").score_anchors) == [1, 2, 3, 4, 5]
    assert not get_metric("llm.similarity").score_anchors
    assert "0.8-1.0" in get_metric("llm.similarity").criteria


def test_captured_calls_reach_deepeval_as_tool_calls():
    """TaskCompletionMetric reads the trajectory, and without one it infers.

    Given no DeepEval trace it falls to a path upstream marks for deprecation,
    which reads ``input``/``actual_output``/``tools_called``. Leaving
    ``tools_called`` empty there means completion is judged from prose alone —
    the response claiming success is taken as success. Only the three fields
    both sides agree on are mapped; DeepEval's ``description`` and ``reasoning``
    are its own annotations and we have nothing truthful to put in them.
    """

    from evalhub.evaluation.adapters.deepeval_adapter import _deepeval_tool_calls
    from evalhub.evaluation.models import ToolCall

    assert _deepeval_tool_calls([]) is None

    mapped = _deepeval_tool_calls(
        [
            ToolCall(name="search", args={"q": "AAPL"}, output={"hits": 2}),
            ToolCall(name="", args={"ignored": True}),
        ]
    )
    assert len(mapped) == 1, "a call with no name identifies nothing and is dropped"
    assert mapped[0].name == "search"
    assert mapped[0].input_parameters == {"q": "AAPL"}
    assert mapped[0].output == {"hits": 2}
    assert mapped[0].description is None and mapped[0].reasoning is None


def test_goal_accuracy_receives_the_trajectory_not_a_bare_exchange():
    """Goal accuracy reads what the agent did, not only what it said.

    The metric takes a message list rather than scalars. Our row is not a stored
    conversation but it holds the trajectory — the request, the calls made and
    what they returned, the answer given — and rendering those in order is a
    faithful account of the turn. A row reduced to question-and-answer would let
    a confident wrong answer score as a resolved intent.
    """

    from evalhub.evaluation.adapters.ragas_adapter import _goal_accuracy_messages
    from evalhub.evaluation.models import ToolCall

    row = EvaluationRow(
        row_id="r1",
        query="what is AAPL trading at",
        response="AAPL is at 195.",
        tool_calls=[
            ToolCall(name="quote", args={"symbol": "AAPL"}, output={"price": 195}),
            ToolCall(name="noop", args={}, output=None),
        ],
    )
    messages = _goal_accuracy_messages(row)

    # Order is the point: ask, call, results, answer. Attaching the answer to
    # the message carrying the calls put the conclusion before the evidence and
    # ended the trajectory on a tool result — and this metric decides whether
    # the goal was met by reading how the trajectory ends.
    assert [type(m).__name__ for m in messages] == [
        "HumanMessage",
        "AIMessage",
        "ToolMessage",
        "AIMessage",
    ]
    assert messages[0].content == "what is AAPL trading at"
    assert [call.name for call in messages[1].tool_calls] == ["quote", "noop"]
    # A call that returned nothing has no result to show; inventing an empty one
    # would read as "the tool returned nothing", which is a different claim.
    assert "195" in messages[2].content
    assert messages[-1].content == "AAPL is at 195."

    bare = _goal_accuracy_messages(EvaluationRow(row_id="r2", query="q", response="a"))
    assert [type(m).__name__ for m in bare] == ["HumanMessage", "AIMessage"]
    assert bare[1].tool_calls is None
    assert bare[1].content == "a"


def test_response_completeness_scores_on_its_declared_range_under_geval():
    """The gain here is enforcement, not a better judge.

    No purpose-built completeness metric exists in either framework, so this is
    the same generic judge the native path used. What GEval adds is the declared
    1-5 bands becoming a Rubric with a real score_range — instead of the judge
    reasoning on G-Eval's 0-10 default while the adapter maps the result as 1-5,
    which is the defect that collapsed coherence.
    """

    from deepeval.models import DeepEvalBaseLLM

    from evalhub.evaluation.adapters.deepeval_adapter import _build_metric

    class _StubModel(DeepEvalBaseLLM):
        def load_model(self):
            return self

        def generate(self, *args, **kwargs):
            return ""

        async def a_generate(self, *args, **kwargs):
            return ""

        def get_model_name(self):
            return "stub"

    definition = get_metric("agent.response_completeness")
    built = _build_metric("agent.response_completeness", _StubModel(), None)
    assert built.score_range == definition.score_range
    assert [r.score_range for r in built.rubric] == [(1, 1), (2, 2), (3, 3), (4, 4), (5, 5)]
    assert "Do not grade correctness" in built.criteria

    adherence = _build_metric("agent.task_adherence", _StubModel(), None)
    assert type(adherence).__name__ == "TaskCompletionMetric"


def test_every_anchored_metric_routes_to_a_scorer_that_reads_its_anchors():
    """Anchors are an input to some scorers and invisible to others.

    DeepEval turns them into G-Eval ``Rubric`` bands and the native judge
    renders them into the prompt. RAGAS has no concept of them at all: hand a
    RAGAS-routed metric a set of anchors and they are not rejected, not logged,
    simply ignored, and the metric is scored by RAGAS's own definition instead.
    Nothing about the run would say so.

    That is the same silent drift that put agent.intent_resolution on a scorer
    measuring goal achievement while its own criteria described understanding —
    found by a reviewer, not by us. This is the check that would have caught it.
    """
    from evalhub.evaluation.enums import Adapter
    from evalhub.evaluation.metrics import METRIC_CATALOG

    reads_anchors = {Adapter.DEEPEVAL, Adapter.NATIVE}
    ignored = {
        metric_id: metric.default_adapter.value
        for metric_id, metric in METRIC_CATALOG.items()
        if metric.score_anchors and metric.default_adapter not in reads_anchors
    }

    assert not ignored, (
        "these metrics declare score anchors that their scorer will silently "
        f"ignore: {ignored}"
    )


def test_no_operational_metric_carries_a_pass_or_fail():
    """Everything under ops.* is information, and information does not fail.

    Latency, token counts and token efficiency are measurements: 1.007 seconds
    is not right or wrong. Each carries a `default_threshold_pass` of 0.8 from
    a field default nobody chose for it, so any ops metric typed as a judged
    scoring type earns a verdict against a threshold that was never set — which
    is how a live audit turned a 1.007s reading into a CRITICAL failure.

    They stay comparable between runs on their own values; that is a different
    question from grading them.
    """
    from evalhub.evaluation.enums import ScoringType
    from evalhub.evaluation.metrics import METRIC_CATALOG

    judged = {
        metric_id: metric.scoring_type.value
        for metric_id, metric in METRIC_CATALOG.items()
        if metric_id.startswith("ops.") and metric.scoring_type is not ScoringType.OPERATIONAL
    }

    assert not judged, f"these operational metrics would be graded: {judged}"


@pytest.mark.parametrize("enum_name", ["SingleTurnParams", "LLMTestCaseParams"])
def test_deepeval_parameter_enum_names_remain_compatible(monkeypatch, enum_name):
    import sys
    from types import SimpleNamespace

    from evalhub.evaluation.adapters.deepeval_adapter import _build_metric

    params = SimpleNamespace(ACTUAL_OUTPUT="actual_output")
    monkeypatch.setitem(sys.modules, "deepeval.test_case", SimpleNamespace(**{enum_name: params}))
    monkeypatch.setitem(sys.modules, "deepeval.metrics", SimpleNamespace(
        GEval=lambda **kwargs: kwargs, HallucinationMetric=object, ToxicityMetric=object,
    ))
    metric = _build_metric("llm.fluency", object())
    assert metric["evaluation_params"] == [params.ACTUAL_OUTPUT]


@pytest.mark.parametrize("fallback_allowed", [False, True])
@pytest.mark.parametrize("failure", ["initialization", "unavailable", "scoring"])
def test_framework_failure_logs_omit_private_evidence(monkeypatch, caplog, fallback_allowed, failure):
    private = "private customer provider diagnostic"
    judge = AdapterDispatchJudge(Settings(
        judge_mode="llm", openai_api_key="x", evaluator_allow_native_fallback=fallback_allowed,
    ))
    judge._native = _SentinelJudge()

    def fail(*args):
        raise (ImportError if failure == "unavailable" else RuntimeError)(private)

    if failure == "scoring":
        framework = _SentinelJudge()
        monkeypatch.setattr(framework, "evaluate", fail)
        judge._ragas = framework
    else:
        monkeypatch.setattr(judge, "_ragas_judge", fail)
    result = judge.evaluate(_config("rag.groundedness", Adapter.RAGAS), _row())
    assert private in result.error_message
    assert result.execution_status == ("fallback" if fallback_allowed else "error")
    assert caplog.records
    assert private not in caplog.text
