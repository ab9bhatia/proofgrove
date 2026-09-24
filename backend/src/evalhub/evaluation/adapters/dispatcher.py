"""Adapter dispatch — route each metric to its scoring framework.

For every ``(config, row)`` the dispatcher looks at ``config.adapter`` and sends
the work to RAGAS or DeepEval when requested, otherwise to the native judge.
Any failure — framework not installed, missing inputs, or a runtime error in the
framework — is caught and the metric is re-scored with the native judge, so a
run never fails because of an optional dependency.
"""

import logging
from dataclasses import replace

from evalhub.evaluation.enums import Adapter
from evalhub.evaluation.evidence_requirements import requires_retrieved_context
from evalhub.evaluation.judge import Judge, MockJudge, get_judge
from evalhub.evaluation.llm_judge import JudgeResult
from evalhub.evaluation.models import EvaluationRow, EvaluatorConfig
from evalhub.settings import Settings, settings

logger = logging.getLogger(__name__)


class _ScorerExecutionError(Exception):
    def __init__(self, executed_scorer: str, cause: Exception) -> None:
        super().__init__(str(cause))
        self.executed_scorer = executed_scorer
        self.cause = cause


class AdapterDispatchJudge:
    """Route metrics to RAGAS / DeepEval / native with graceful fallback."""

    def __init__(self, cfg: Settings | None = None) -> None:
        self.settings = cfg or settings
        self._native: Judge = get_judge(self.settings)
        self._ragas: Judge | None = None
        self._deepeval: Judge | None = None
        self._trace: Judge | None = None
        self._deterministic: Judge | None = None
        self._ragas_disabled = False
        self._deepeval_disabled = False

    def _trace_judge(self) -> Judge:
        if self._trace is None:
            from evalhub.evaluation.adapters.trace_adapter import TraceJudge

            self._trace = TraceJudge()
        return self._trace

    def _deterministic_judge(self) -> Judge:
        if self._deterministic is None:
            from evalhub.evaluation.adapters.deterministic_adapter import DeterministicJudge

            self._deterministic = DeterministicJudge()
        return self._deterministic

    def _ragas_judge(self) -> Judge:
        if self._ragas_disabled:
            # ImportError (not RuntimeError) so the `except (ImportError, OSError)`
            # branch below classifies a disabled-for-the-run row the same way as
            # the row that discovered it — "framework unavailable", not
            # "framework failed" from the catch-all.
            raise ImportError("RAGAS adapter disabled")
        if self._ragas is None:
            from evalhub.evaluation.adapters.ragas_adapter import RagasJudge

            self._ragas = RagasJudge(self.settings)
        return self._ragas

    def _deepeval_judge(self) -> Judge:
        if self._deepeval_disabled:
            raise ImportError("DeepEval adapter disabled")
        if self._deepeval is None:
            from evalhub.evaluation.adapters.deepeval_adapter import DeepEvalJudge

            self._deepeval = DeepEvalJudge(self.settings)
        return self._deepeval

    def evaluate(self, config: EvaluatorConfig, row: EvaluationRow) -> JudgeResult:
        if config.adapter == Adapter.DETERMINISTIC:
            return self._evaluate(self._deterministic_judge(), Adapter.DETERMINISTIC, config, row)

        # Deterministic trace-based groundedness (no LLM), scored first so it runs
        # even in mock mode / with frameworks disabled. Only for live-agent rows;
        # judge-only / baseline rows keep the native LLM-judge path for these
        # metrics so a pipeline-check run is unaffected.
        if config.adapter == Adapter.TRACE:
            if row.from_agent:
                return self._evaluate(self._trace_judge(), Adapter.TRACE, config, row)
            return replace(
                self._evaluate(self._native, Adapter.NATIVE, config, row),
                fallback_from=config.adapter.value,
            )

        if config.adapter == Adapter.CUSTOM:
            return JudgeResult(
                score=0.0,
                label="unavailable",
                rationale="Custom evaluator requires an isolated metric-pack worker.",
                prompt_tokens=0,
                completion_tokens=0,
                error_code="ISOLATED_EVALUATOR_UNAVAILABLE",
                error_message="No isolated worker is registered for this custom evaluator.",
                execution_status="error",
                executed_scorer=None,
            )

        # Mock mode and the framework master switch bypass adapters entirely.
        # Record which adapter was bypassed: without it the row is
        # indistinguishable from one whose adapter is genuinely native, and
        # executed_scorer is what a correction's eligibility is matched on.
        if self.settings.judge_mode == "mock" or not self.settings.judge_use_frameworks:
            return replace(
                self._evaluate(self._native, Adapter.NATIVE, config, row),
                fallback_from=config.adapter.value,
            )

        # Never route through a real framework when the native side is a mock
        # (no credentials) — the frameworks need a live LLM.
        if isinstance(self._native, MockJudge):
            return self._evaluate(self._native, Adapter.NATIVE, config, row)

        try:
            if config.adapter == Adapter.RAGAS:
                return self._evaluate(self._ragas_judge(), Adapter.RAGAS, config, row)
            if config.adapter == Adapter.DEEPEVAL:
                return self._evaluate(self._deepeval_judge(), Adapter.DEEPEVAL, config, row)
        except _ScorerExecutionError as exc:
            unavailable = isinstance(exc.cause, (ImportError, OSError))
            if unavailable and config.adapter == Adapter.RAGAS:
                self._ragas_disabled = True
            elif unavailable and config.adapter == Adapter.DEEPEVAL:
                self._deepeval_disabled = True
            failure = "framework unavailable" if unavailable else "framework failed"
            return self._disclosed_fallback(
                config,
                row,
                f"{failure}: {exc}",
                executed_scorer=exc.executed_scorer,
            )
        except (ImportError, OSError) as exc:
            # The framework cannot start at all — not installed, or unable to
            # initialise (one of them writes a dot-directory on import, which
            # raises OSError on a read-only root filesystem). Either way it will
            # fail identically for every remaining row, so disable it for the
            # run rather than paying the failure per case, and record it as
            # unavailable rather than as a scoring failure.
            if config.adapter == Adapter.RAGAS:
                self._ragas_disabled = True
            elif config.adapter == Adapter.DEEPEVAL:
                self._deepeval_disabled = True
            return self._disclosed_fallback(config, row, f"framework unavailable: {exc}")
        except Exception as exc:  # noqa: BLE001 — any framework error falls back
            return self._disclosed_fallback(config, row, f"framework failed: {exc}")

        return self._evaluate(self._native, Adapter.NATIVE, config, row)

    @staticmethod
    def _evaluate(judge: Judge, scorer: Adapter, config: EvaluatorConfig, row: EvaluationRow) -> JudgeResult:
        executed_scorer = Adapter.MOCK.value if isinstance(judge, MockJudge) else scorer.value
        try:
            result = judge.evaluate(config, row)
        except Exception as exc:
            raise _ScorerExecutionError(executed_scorer, exc) from exc
        return replace(
            result,
            executed_scorer=executed_scorer,
        )

    def _disclosed_fallback(
        self,
        config: EvaluatorConfig,
        row: EvaluationRow,
        reason: str,
        *,
        executed_scorer: str | None = None,
    ) -> JudgeResult:
        """Return a visible fallback outcome; it is never indistinguishable from success."""
        logger.warning(
            "%s for %s (row %s); recording framework fallback",
            config.adapter,
            config.metric_id,
            row.row_id,
        )
        if not self.settings.evaluator_allow_native_fallback:
            return JudgeResult(
                score=0.0,
                label="error",
                rationale=reason,
                prompt_tokens=0,
                completion_tokens=0,
                error_code="EVALUATOR_FAILURE",
                error_message=reason,
                execution_status="error",
                executed_scorer=executed_scorer,
            )
        # The substitute cannot supply evidence the run never captured. Scoring
        # groundedness with no context to check against is not a measurement —
        # it puts a number where the answer is "we could not tell". The engine
        # turns a missing_evidence result into an honest unscored row.
        if requires_retrieved_context(config.metric_id) and not row.context:
            return JudgeResult(
                score=None,
                label=None,
                rationale="No retrieved context was captured, so grounding cannot be judged.",
                prompt_tokens=0,
                completion_tokens=0,
                error_message=reason,
                # Not an error status: "we could not tell" is not an evaluator
                # failure, and the engine tests execution_status before it tests
                # missing_evidence — so marking this one an error routed it to
                # _technical_error_result and it persisted as technical_error
                # instead of unscored / evidence_unavailable. Every other
                # missing-evidence producer (deterministic, trace) leaves the
                # status alone; this was the outlier. error_message and
                # fallback_from stay: the framework failure that got us here is
                # still worth disclosing on the row.
                fallback_from=config.adapter.value,
                missing_evidence=["retrieval"],
            )

        native = self._evaluate(self._native, Adapter.NATIVE, config, row)
        if native.execution_status == "error":
            # The substitute failed too. Reporting that as a fallback hid a
            # second failure behind the first and kept whatever score the
            # failed judge returned, so the row read as successfully rescued.
            return replace(native, fallback_from=config.adapter.value)
        return replace(
            native,
            execution_status="fallback",
            fallback_from=config.adapter.value,
            error_code="EVALUATOR_FALLBACK",
            error_message=reason,
        )


def build_judge(cfg: Settings | None = None) -> Judge:
    """Return the framework-aware dispatch judge used by the engine."""
    return AdapterDispatchJudge(cfg or settings)
