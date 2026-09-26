"""Judge abstraction — MockJudge (offline) and LLMJudge (OpenAI-compatible)."""

import hashlib
import random
from typing import Protocol

from proofgrove.evaluation.enums import ScoringType
from proofgrove.evaluation.llm_judge import JudgeResult, LLMJudge
from proofgrove.evaluation.metrics import get_metric
from proofgrove.evaluation.models import EvaluationRow, EvaluatorConfig
from proofgrove.evaluation.normalization import normalise_operational, normalise_score
from proofgrove.settings import Settings, settings


class Judge(Protocol):
    """Protocol for metric evaluators."""

    def evaluate(self, config: EvaluatorConfig, row: EvaluationRow) -> JudgeResult: ...


# Row-level score overrides (tests only)
ROW_SCORE_OVERRIDES: dict[str, dict[str, float]] = {}


def set_row_overrides(overrides: dict[str, dict[str, float]]) -> None:
    """Set deterministic score overrides for tests."""
    global ROW_SCORE_OVERRIDES  # noqa: PLW0603
    ROW_SCORE_OVERRIDES = overrides


class MockJudge:
    """Deterministic mock evaluator — no live LLM calls."""

    RATIONALE_TEMPLATES = {
        "llm.correctness": "Response {match_status} expected answer.",
        "llm.guideline_adherence": "Guideline compliance: {compliance}.",
        "rag.groundedness": "Response {ground_status} grounded in retrieved context.",
        "rag.context_sufficiency": "Context {suff_status} sufficient information.",
        "agent.task_adherence": "Task completion: {task_status}.",
        "agent.intent_resolution": "Intent resolution: {intent_status}.",
        "agent.tool_call_accuracy": "Tool call accuracy: {tool_status}.",
        "agent.tool_selection": "Tool selection: {select_status}.",
    }

    def evaluate(self, config: EvaluatorConfig, row: EvaluationRow) -> JudgeResult:
        metric = get_metric(config.metric_id)
        if not metric:
            return JudgeResult(0.0, "error", "Unknown metric", 0, 0)

        raw_score = self._deterministic_score(config.metric_id, row.row_id, metric.scoring_type)
        label = self._label(raw_score, metric) if metric.scoring_type == ScoringType.BINARY else None
        normalised = (
            normalise_operational(raw_score, config.metric_id)
            if metric.scoring_type == ScoringType.OPERATIONAL
            else normalise_score(raw_score, metric.scoring_type, metric.score_range)
        )
        rationale = (
            "SIMULATED: hash-based pipeline fixture; no answer content was evaluated. "
            + self._rationale(config.metric_id, raw_score, normalised)
        )
        tokens = self._token_counts(config.metric_id, row.row_id)

        return JudgeResult(
            score=raw_score,
            label=label,
            rationale=rationale,
            prompt_tokens=tokens[0],
            completion_tokens=tokens[1],
        )

    def _deterministic_score(self, metric_id: str, row_id: str, scoring_type: ScoringType) -> float:
        if row_id in ROW_SCORE_OVERRIDES and metric_id in ROW_SCORE_OVERRIDES[row_id]:
            return ROW_SCORE_OVERRIDES[row_id][metric_id]

        seed = int(hashlib.md5(f"{row_id}:{metric_id}".encode()).hexdigest(), 16)  # noqa: S324
        rng = random.Random(seed)  # noqa: S311

        if scoring_type == ScoringType.BINARY:
            return 1.0 if rng.random() > 0.25 else 0.0
        if scoring_type == ScoringType.SCALE:
            return float(rng.randint(2, 5))
        if scoring_type == ScoringType.SEVERITY:
            return float(rng.randint(0, 3))
        if scoring_type == ScoringType.OPERATIONAL:
            if "latency" in metric_id:
                return rng.uniform(1.0, 8.0)
            if "token_count" in metric_id:
                return rng.uniform(1500, 6000)
            return rng.uniform(0.0008, 0.002)
        return rng.uniform(0.5, 0.95)

    def _label(self, score: float, metric) -> str:
        if metric.scoring_type == ScoringType.BINARY:
            return "yes" if score >= 1.0 else "no"
        return f"{score:.2f}"

    def _rationale(self, metric_id: str, score: float, normalised: float | None) -> str:
        template = self.RATIONALE_TEMPLATES.get(metric_id)
        if template:
            ok = score >= 1.0 if score in (0.0, 1.0) else (normalised or 0.0) >= 0.7
            return template.format(
                match_status="matches" if ok else "does not match",
                compliance="yes" if ok else "no",
                ground_status="is" if ok else "is not",
                suff_status="contains" if ok else "lacks",
                task_status="yes" if ok else "no",
                intent_status="correct" if ok else "incorrect",
                tool_status="pass" if ok else "fail",
                select_status="correct" if ok else "incorrect",
            )
        # A measurement has no normalised form — say the measurement, not
        # "normalised: None".
        if normalised is None:
            return f"Measured: {score:.2f}."
        return f"Score: {score:.2f} (normalised: {normalised:.2f})."

    def _token_counts(self, metric_id: str, row_id: str) -> tuple[int, int]:
        seed = int(hashlib.md5(f"tokens:{row_id}:{metric_id}".encode()).hexdigest(), 16)  # noqa: S324
        rng = random.Random(seed)  # noqa: S311
        return rng.randint(400, 1200), rng.randint(100, 600)


def get_judge(cfg: Settings | None = None) -> Judge:
    """Return LLMJudge when configured, otherwise MockJudge."""
    cfg = cfg or settings
    if cfg.judge_mode == "mock":
        return MockJudge()
    has_key = (
        bool(cfg.azure_openai_api_key)
        if cfg.judge_provider == "azure"
        else bool(cfg.openai_api_key)
    )
    if cfg.judge_mode == "llm" or (cfg.judge_mode == "auto" and has_key):
        return LLMJudge(cfg)
    return MockJudge()
