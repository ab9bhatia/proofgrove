"""LLM-as-judge using OpenAI-compatible API."""

import json
import logging
import math
from dataclasses import dataclass

from openai import OpenAI

from proofgrove.evaluation.models import EvaluationRow, EvaluatorConfig
from proofgrove.evaluation.prompts import build_judge_messages
from proofgrove.settings import Settings

logger = logging.getLogger(__name__)


@dataclass
class JudgeResult:
    """Raw judge output before normalisation."""

    score: float | None
    label: str | None
    rationale: str
    prompt_tokens: int
    completion_tokens: int
    error_code: str | None = None
    error_message: str | None = None
    execution_status: str = "success"
    fallback_from: str | None = None
    missing_evidence: list[str] | None = None
    abstained: bool = False
    executed_scorer: str | None = None

    def __post_init__(self) -> None:
        if self.score is not None and not math.isfinite(self.score):
            raise ValueError("Evaluator score must be finite")


def uses_completion_tokens(model: str) -> bool:
    """Return True when the model rejects ``max_tokens`` / custom temperature."""
    lower = model.lower()
    return lower.startswith("gpt-5") or lower.startswith(("o1", "o3", "o4"))


def is_claude_model(model: str) -> bool:
    """Return True for Anthropic Claude model ids (incl. Compass aliases)."""
    lower = model.lower()
    return "claude" in lower or lower.startswith("anthropic")


def supports_json_response_format(model: str) -> bool:
    """Return True when the model accepts OpenAI ``response_format=json_object``.

    Compass-routed Anthropic Claude models reject ``response_format`` as an
    extra input (``invalid_request_error``).
    """
    return not is_claude_model(model)


def reshape_messages_for_model(
    model: str, messages: list[dict],
) -> tuple[list[dict], dict]:
    """Adapt chat messages for model-family quirks.

    Claude via Compass rejects ``role=system`` in ``messages`` and requires the
    prompt as a top-level ``system`` field. Returns ``(messages, extra_body)``.
    """
    if not is_claude_model(model):
        return messages, {}

    system_parts: list[str] = []
    rest: list[dict] = []
    for message in messages:
        if message.get("role") == "system":
            content = message.get("content") or ""
            if isinstance(content, str) and content.strip():
                system_parts.append(content.strip())
            continue
        rest.append(message)

    extra_body: dict = {}
    if system_parts:
        extra_body["system"] = "\n\n".join(system_parts)
    return rest, extra_body


def completion_token_params(model: str, max_tokens: int) -> dict[str, int]:
    """Build the token-limit kwargs for the given model family."""
    if uses_completion_tokens(model):
        return {"max_completion_tokens": max_tokens}
    return {"max_tokens": max_tokens}


def gateway_model_headers(model: str) -> dict[str, str]:
    """Per-request headers so the AI Gateway routes by selected model id."""
    return {"x-model-id": model}


def extract_completion_text(completion: object) -> str:
    """Extract assistant text from OpenAI- or Anthropic-shaped completion objects.

    Compass Claude responses sometimes arrive without ``choices`` populated
    (Anthropic Messages shape: ``content[{type,text}]``). Raising a clear error
    is preferable to ``'NoneType' object is not subscriptable``.
    """
    choices = getattr(completion, "choices", None)
    if choices:
        message = getattr(choices[0], "message", None)
        content = getattr(message, "content", None) if message is not None else None
        text = _content_to_text(content)
        if text:
            return text

    # Anthropic Messages API-style body on the same object.
    text = _content_to_text(getattr(completion, "content", None))
    if text:
        return text

    dumped: dict = {}
    model_dump = getattr(completion, "model_dump", None)
    if callable(model_dump):
        try:
            dumped = model_dump() or {}
        except Exception:  # noqa: BLE001 — best-effort fallback
            dumped = {}
    if not dumped and isinstance(completion, dict):
        dumped = completion

    # OpenAI SDK may stash unrecognized Anthropic fields in model_extra.
    if not dumped:
        extra = getattr(completion, "model_extra", None)
        if isinstance(extra, dict):
            dumped = extra

    if dumped:
        dumped_choices = dumped.get("choices") or []
        if dumped_choices:
            first = dumped_choices[0] or {}
            message = first.get("message") or {}
            text = _content_to_text(message.get("content"))
            if text:
                return text
            # Some gateways put text directly on the choice.
            text = _content_to_text(first.get("text") or first.get("content"))
            if text:
                return text
        text = _content_to_text(dumped.get("content"))
        if text:
            return text
        # Rare: top-level text / output_text fields.
        for key in ("output_text", "text", "output"):
            candidate = dumped.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()

    raise ValueError(
        "LLM response missing text content "
        f"(type={type(completion).__name__}, choices={choices!r})"
    )

def _strip_markdown_fence(content: str) -> str:
    """Strip a ```` ``` ```` / ```` ```json ```` fence some models wrap JSON in.

    The prompt asks for "ONLY valid JSON (no markdown fences)", but models
    ignore that instruction often enough that ``json.loads`` on the raw text
    routinely raised ``JSONDecodeError`` and the judge fell into the generic
    exception handler.
    """
    text = content.strip()
    if not text.startswith("```"):
        return text
    text = text.removeprefix("```")
    if text.split("\n", 1)[0].strip().lower() in {"json", ""}:
        text = text.split("\n", 1)[1] if "\n" in text else ""
    return text.rsplit("```", 1)[0].strip() if text.rstrip().endswith("```") else text.strip()


def _content_to_text(content: object) -> str:
    """Normalize string or content-block list payloads into plain text."""
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, str) and block.strip():
            parts.append(block.strip())
            continue
        if isinstance(block, dict):
            text = block.get("text")
            if text:
                parts.append(str(text).strip())
            continue
        text = getattr(block, "text", None)
        if text:
            parts.append(str(text).strip())
    return "\n".join(part for part in parts if part)


class LLMJudge:
    """Real LLM judge via OpenAI-compatible / Azure / Compass backend."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.provider = settings.judge_provider

        if self.provider == "azure":
            endpoint = settings.azure_openai_endpoint.rstrip("/")
            deployment = settings.azure_openai_deployment
            self.client = OpenAI(
                api_key=settings.azure_openai_api_key.get_secret_value(),
                base_url=f"{endpoint}/openai/deployments/{deployment}",
                default_query={"api-version": settings.azure_openai_api_version},
                default_headers={"api-key": settings.azure_openai_api_key.get_secret_value()},
            )
            self.model = deployment
        else:
            # openai + compass share the OpenAI-compatible client shape.
            # Do not pin x-model-id on the client — selection is per request.
            self.client = OpenAI(
                api_key=settings.openai_api_key.get_secret_value(),
                base_url=settings.openai_base_url,
            )
            self.model = settings.judge_model

    def _build_request(
        self, model: str, messages: list, temperature: float, max_tokens: int
    ) -> dict:
        """Build provider/model-specific request kwargs.

        gpt-5 / o-series reject ``max_tokens`` (need ``max_completion_tokens``)
        and only allow the default temperature, so those params are dropped.
        Claude via Compass rejects ``role=system`` in messages and needs a
        top-level ``system`` field instead.
        """
        adapted_messages, extra_body = reshape_messages_for_model(model, messages)
        request: dict = {
            "model": model,
            "messages": adapted_messages,
            **completion_token_params(model, max_tokens),
        }
        if supports_json_response_format(model):
            request["response_format"] = {"type": "json_object"}
        if not uses_completion_tokens(model):
            request["temperature"] = temperature
        if self.provider != "azure":
            request["extra_headers"] = gateway_model_headers(model)
        if extra_body:
            request["extra_body"] = extra_body
        return request

    def evaluate(self, config: EvaluatorConfig, row: EvaluationRow) -> JudgeResult:
        """Evaluate a single row for a single metric."""
        messages = build_judge_messages(
            config.metric_id,
            row.query,
            row.response,
            row.context or None,
            row.expected_response,
            criteria=config.adapter_config.get("criteria"),
            evaluation_steps=config.adapter_config.get("evaluation_steps"),
            tool_evidence=[
                {
                    "name": tool.name,
                    "args": tool.args,
                    "result_captured": tool.result_captured,
                }
                for tool in row.tool_calls
            ],
        )
        try:
            # Azure routes by deployment in the URL, so the body model is fixed
            # to the configured deployment; other providers honour the per-config
            # judge_model override.
            model = self.model if self.provider == "azure" else (config.judge_model or self.model)
            request = self._build_request(
                model,
                messages,
                config.judge_temperature,
                config.judge_max_tokens,
            )
            completion = self.client.chat.completions.create(**request)
            content = extract_completion_text(completion) or "{}"
            usage = completion.usage
            prompt_tokens = getattr(usage, "prompt_tokens", 0) if usage else 0
            completion_tokens = getattr(usage, "completion_tokens", 0) if usage else 0

            parsed = json.loads(_strip_markdown_fence(content))
            if "score" not in parsed:
                # A missing key is the judge not answering, not a 0.0 verdict.
                # Defaulting it folded a malformed/refused response into the
                # same number as a considered "worst score" judgement.
                raise ValueError(f"judge response missing 'score' key: {content!r}")
            score = float(parsed["score"])
            label = parsed.get("label")
            rationale = str(parsed.get("rationale", ""))

            return JudgeResult(
                score=score,
                label=str(label) if label is not None else None,
                rationale=rationale,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
            )
        except Exception as e:
            # Provider/parse errors can contain tenant prompts and completions.
            logger.warning("LLM judge failed (%s)", type(e).__name__)
            return JudgeResult(
                # A judge that could not run has no opinion. Returning a midpoint
                # made a connection error indistinguishable from a considered
                # verdict: it survived into means, histograms and KPI arithmetic
                # as a real score, because the fallback path overwrote the error
                # status while keeping the number.
                score=None,
                label=None,
                rationale=f"Judge failure: {e}",
                prompt_tokens=0,
                completion_tokens=0,
                error_code="JUDGE_FAILURE",
                error_message=str(e),
                execution_status="error",
            )
