"""RAGAS adapter — retrieval-quality metrics for RAG scenarios.

Maps the proofgrove RAG metrics onto RAGAS single-turn metrics and routes every
LLM call through the same OpenAI-compatible endpoint the native judge uses
(OpenAI / Azure / Compass / Proofgrove AI Gateway), so no traffic leaves the
configured backend. Scores come back in ``[0, 1]`` and are converted to each
metric's raw scale via :func:`unit_to_raw`.
"""

import json
import logging

from proofgrove.evaluation.adapters.scale import binary_label, unit_to_raw
from proofgrove.evaluation.enums import ScoringType
from proofgrove.evaluation.llm_judge import JudgeResult
from proofgrove.evaluation.metrics import get_metric
from proofgrove.evaluation.models import EvaluationRow, EvaluatorConfig
from proofgrove.settings import Settings

logger = logging.getLogger(__name__)

# proofgrove metric_id -> RAGAS metric class name (in ragas.metrics)
_RAGAS_METRIC_NAMES: dict[str, str] = {
    "rag.groundedness": "Faithfulness",
    "rag.context_sufficiency": "LLMContextRecall",
    "rag.chunk_relevance": "ContextRelevance",
    "llm.similarity": "SemanticSimilarity",
    "rag.retrieval_quality": "ContextPrecision",
    "agent.intent_resolution": "AgentGoalAccuracyWithoutReference",
}

# Scorers on the newer collections API: constructed from an instructor-style LLM
# and scored with ``ascore(...)`` rather than ``single_turn_score(sample)``.
# ``ContextRelevance`` is the one that judges chunks against the query alone —
# the same-API alternative, ``LLMContextPrecisionWithoutReference``, declares
# ``response`` among its required columns and returns it from
# ``_get_row_attributes``, so an identical query over identical chunks scored
# differently when only the answer changed. "Without reference" means without a
# gold answer, not without the model's output.
_COLLECTIONS_API: dict[str, tuple[str, ...]] = {
    "rag.chunk_relevance": ("user_input", "retrieved_contexts"),
    "llm.similarity": ("reference", "response"),
    # Precision judges the retrieved set against the query and the gold answer.
    # The response is deliberately absent: the adapter already learned once that
    # a retrieval scorer shown the answer returns 5 then 1 for identical chunks
    # when only the answer changed.
    "rag.retrieval_quality": ("user_input", "reference", "retrieved_contexts"),
    # Takes the trajectory as one argument — a message list, not scalars — so it
    # is assembled by ``_goal_accuracy_messages`` rather than selected here.
    "agent.intent_resolution": ("user_input",),
}

#: Collections-API scorers built from an embedding model rather than an LLM.
#:
#: ``llm.similarity`` asks how close two texts are in meaning, which is a cosine
#: between two vectors, not an opinion. It had no adapter claiming it, so it
#: reached the native judge as "rate semantic similarity 0.0 to 1.0" — asking a
#: language model to produce a number it cannot actually compute.
_EMBEDDING_METRICS = frozenset({"llm.similarity"})

#: Metrics whose sole input is the agent trajectory rendered as RAGAS messages.
_TRAJECTORY_METRICS = frozenset({"agent.intent_resolution"})


def _wants(metric_id: str, argument: str) -> bool:
    """True when the metric's declared inputs include ``argument``.

    ``_COLLECTIONS_API`` already states exactly what each scorer is given, so
    "does this need retrieved context" and "does this need the gold answer" are
    read off that rather than restated in parallel sets that can drift from it.
    """
    return argument in _COLLECTIONS_API.get(metric_id, ())


def supported_metrics() -> set[str]:
    """Return the metric ids this adapter can score."""
    return set(_RAGAS_METRIC_NAMES)


def _build_ragas_llm(settings: Settings):
    """Wrap the configured chat backend in a RAGAS-compatible LLM."""
    from ragas.llms import LangchainLLMWrapper

    if settings.judge_provider == "azure":
        from langchain_openai import AzureChatOpenAI

        chat = AzureChatOpenAI(
            azure_endpoint=settings.azure_openai_endpoint,
            api_key=settings.azure_openai_api_key.get_secret_value(),
            azure_deployment=settings.azure_openai_deployment,
            api_version=settings.azure_openai_api_version,
            temperature=0.0,
        )
    else:
        # openai + compass share the OpenAI-compatible client shape.
        # Pin x-model-id to the configured default; per-row overrides go through
        # LLMJudge (native path), not this RAGAS wrapper.
        from langchain_openai import ChatOpenAI

        from proofgrove.evaluation.llm_judge import gateway_model_headers

        chat = ChatOpenAI(
            model=settings.judge_model,
            api_key=settings.openai_api_key.get_secret_value(),
            base_url=settings.openai_base_url,
            default_headers=gateway_model_headers(settings.judge_model),
            temperature=0.0,
        )
    return LangchainLLMWrapper(chat)


def _goal_accuracy_messages(row: EvaluationRow) -> list:
    """Render one evaluated row as the message list goal-accuracy scores.

    The metric asks whether the agent achieved what the user wanted, which it
    reads off the trajectory rather than off a single answer. Our row is not a
    stored conversation, but it holds that trajectory: the request, the calls
    the agent made and what they returned, and the answer it gave. Rendering
    those three in order is a faithful account of the turn, not a synthesised
    dialogue — and the metric requires trace evidence, so a row without calls
    is refused upstream rather than scored as a bare question and answer.
    """

    from ragas.messages import AIMessage, HumanMessage, ToolMessage
    from ragas.messages import ToolCall as RagasToolCall

    messages: list = [HumanMessage(content=row.query)]

    calls = [
        RagasToolCall(name=call.name, args=call.args or {})
        for call in row.tool_calls
        if call.name
    ]
    # The calls, then what they returned, then the answer. Attaching the answer
    # to the message that carries the calls put the agent's conclusion *before*
    # the tool outputs and left a tool result as the last thing in the
    # trajectory — the opposite of how the turn happened, for a metric that
    # reads the trajectory's ending to decide whether the goal was met.
    if calls:
        messages.append(AIMessage(content="", tool_calls=calls))
        for call in row.tool_calls:
            if call.output is None:
                continue
            messages.append(
                ToolMessage(content=json.dumps(call.output, default=str, sort_keys=True))
            )
    messages.append(AIMessage(content=row.response))
    return messages


class RagasJudge:
    """Judge implementation backed by RAGAS single-turn metrics."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._llm = _build_ragas_llm(settings)
        self._collections_llm = None
        self._embeddings_client = None
        self._metrics: dict[str, object] = {}
        self._loop = None

    def _thread_loop(self):
        """One asyncio loop reused for every collections-API ``ascore`` call.

        ``evaluate`` is called once per row from inside a single threadpool
        worker thread for the life of a run (see ``run_in_threadpool`` in
        run_service.py). ``asyncio.run()`` per row builds and tears down a
        fresh loop each call; when that worker thread is pooled and reused,
        the next row's fresh loop is a different loop than the one any
        long-lived async resource RAGAS cached (its instructor LLM / embeddings
        client) was created against, and reusing that resource against a
        closed loop raises. Reusing one loop for this judge's whole lifetime
        (matching its cached clients' lifetime) avoids that entirely.
        """
        if self._loop is None or self._loop.is_closed():
            import asyncio

            self._loop = asyncio.new_event_loop()
        return self._loop

    def _instructor_llm(self):
        """LLM in the shape the collections-API scorers require.

        Built lazily and only when one of those metrics is scored, so the
        common path keeps the single wrapper it already had.
        """

        if self._collections_llm is None:
            from ragas.llms import llm_factory

            from proofgrove.evaluation.llm_judge import gateway_model_headers

            if self.settings.judge_provider == "azure":
                raise ValueError(
                    "collections-API RAGAS metrics are not wired for the Azure client"
                )
            from openai import OpenAI

            client = OpenAI(
                api_key=self.settings.openai_api_key.get_secret_value(),
                base_url=self.settings.openai_base_url,
                default_headers=gateway_model_headers(self.settings.judge_model),
            )
            self._collections_llm = llm_factory(self.settings.judge_model, client=client)
        return self._collections_llm

    def _embeddings(self):
        """Embedding model in the shape the collections-API scorers require.

        Routed through the same OpenAI-compatible AI Gateway as the judge, with
        the per-request model header the gateway routes on, so this needs no
        second credential and no second egress.
        """

        if self._embeddings_client is None:
            if not self.settings.judge_embedding_model:
                raise ValueError(
                    "embedding-backed RAGAS metrics require judge_embedding_model to be set"
                )
            if self.settings.judge_provider == "azure":
                raise ValueError("embedding-backed RAGAS metrics are not wired for the Azure client")

            from openai import OpenAI
            from ragas.embeddings import OpenAIEmbeddings

            from proofgrove.evaluation.llm_judge import gateway_model_headers

            model = self.settings.judge_embedding_model
            client = OpenAI(
                api_key=self.settings.openai_api_key.get_secret_value(),
                base_url=self.settings.openai_base_url,
                default_headers=gateway_model_headers(model),
            )
            self._embeddings_client = OpenAIEmbeddings(client=client, model=model)
        return self._embeddings_client

    def _metric(self, metric_id: str):
        if metric_id not in self._metrics:
            import ragas.metrics as ragas_metrics

            if metric_id in _COLLECTIONS_API:
                # The legacy module re-exports a same-named shim without the
                # collections API, so resolve these from the collections module.
                import ragas.metrics.collections as ragas_collections

                cls = getattr(ragas_collections, _RAGAS_METRIC_NAMES[metric_id])
                if metric_id in _EMBEDDING_METRICS:
                    self._metrics[metric_id] = cls(embeddings=self._embeddings())
                else:
                    self._metrics[metric_id] = cls(llm=self._instructor_llm())
            else:
                cls = getattr(ragas_metrics, _RAGAS_METRIC_NAMES[metric_id])
                self._metrics[metric_id] = cls(llm=self._llm)
        return self._metrics[metric_id]

    def evaluate(self, config: EvaluatorConfig, row: EvaluationRow) -> JudgeResult:
        from ragas.dataset_schema import SingleTurnSample

        metric_def = get_metric(config.metric_id)
        if metric_def is None or config.metric_id not in _RAGAS_METRIC_NAMES:
            raise ValueError(f"RAGAS adapter cannot score metric {config.metric_id}")

        contexts = list(row.context) if row.context else []
        if not contexts and (
            config.metric_id not in _COLLECTIONS_API or _wants(config.metric_id, "retrieved_contexts")
        ):
            raise ValueError("RAGAS metrics require retrieved_contexts")
        if _wants(config.metric_id, "reference") and not (row.expected_response or "").strip():
            # Refuse rather than score against an empty string: for similarity
            # that cosines to a constant, and for precision RAGAS raises. A
            # ground-truth metric is normally marked not-applicable by readiness
            # before it reaches here, so this is the row that slipped through.
            raise ValueError(f"{config.metric_id} requires expected_response")

        sample = SingleTurnSample(
            user_input=row.query,
            response=row.response,
            retrieved_contexts=contexts,
            reference=row.expected_response,
        )

        metric = self._metric(config.metric_id)
        if config.metric_id in _COLLECTIONS_API:
            # ``ascore`` takes only the inputs the metric declares, which is the
            # point: the answer is never passed to a retrieval judgement.
            kwargs = {
                "user_input": (
                    _goal_accuracy_messages(row)
                    if config.metric_id in _TRAJECTORY_METRICS
                    else row.query
                ),
                "retrieved_contexts": contexts,
                "reference": row.expected_response,
                "response": row.response,
            }
            selected = {k: kwargs[k] for k in _COLLECTIONS_API[config.metric_id]}
            score_result = self._thread_loop().run_until_complete(metric.ascore(**selected))
            if score_result.value is None:
                raise ValueError(f"RAGAS metric {config.metric_id} returned no score")
            unit = float(score_result.value)
        else:
            raw_score = metric.single_turn_score(sample)
            if raw_score is None:
                raise ValueError(f"RAGAS metric {config.metric_id} returned no score")
            unit = float(raw_score)

        raw = unit_to_raw(unit, metric_def.scoring_type, metric_def.score_range)
        label = binary_label(unit) if metric_def.scoring_type == ScoringType.BINARY else None
        rationale = f"RAGAS {_RAGAS_METRIC_NAMES[config.metric_id]} score: {unit:.3f}."

        return JudgeResult(
            score=raw,
            label=label,
            rationale=rationale,
            prompt_tokens=0,
            completion_tokens=0,
        )
