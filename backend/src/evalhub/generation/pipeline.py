"""Run a dataset-generation job: synthesise golden rows and register them as a
DRAFT dataset for human review.

Used by the async worker (evalhub.runs_worker) for ``kind="generate"`` jobs.

Two paths:
- ``generation_method=llms``: one user instruction → ``num_rows`` synthetic records
  via the AI Gateway (no MCP grounding).
- tools/agents (default): one instruction (or explicit seed list) is expanded to
  ``num_rows`` seed topics when needed, each grounded via an MCP tool, then the LLM
  synthesises a faithful golden row.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

from fastapi.concurrency import run_in_threadpool

from evalhub.datasets.csv_parser import parse_csv
from evalhub.datasets.models import CreateDatasetRequest, DatasetRecord
from evalhub.datasets.registry import DatasetRegistryService
from evalhub.errors import EvaluationInputError
from evalhub.generation.generator import DatasetGenerator, GenerationError, rows_to_csv
from evalhub.generation.prompt_generator import (
    PromptGenerationError,
    expand_instruction_to_seeds,
    generate_records_from_prompt,
)
from evalhub.generation.sources import McpToolGroundingSource
from evalhub.settings import settings

logger = logging.getLogger(__name__)


def _build_gateway_complete(model: str) -> Callable[[list[dict[str, str]]], Awaitable[str]]:
    """Async ``complete(messages) -> str`` via an OpenAI client at the AI Gateway.

    The blocking OpenAI call runs in a thread so the worker's event loop stays
    responsive.
    """

    from openai import OpenAI

    from evalhub.evaluation.llm_judge import (
        completion_token_params,
        extract_completion_text,
        gateway_model_headers,
        is_claude_model,
        reshape_messages_for_model,
        supports_json_response_format,
        uses_completion_tokens,
    )

    client = OpenAI(
        api_key=settings.openai_api_key.get_secret_value() or "gateway",
        base_url=settings.openai_base_url,
    )

    async def complete(messages: list[dict[str, str]]) -> str:
        def _call() -> str:
            # Prompt-batch generation may need more tokens than a single row.
            max_tokens = max(settings.judge_max_tokens, 4096)
            adapted_messages, extra_body = reshape_messages_for_model(model, messages)
            request: dict = {
                "model": model,
                "messages": adapted_messages,
                **completion_token_params(model, max_tokens),
                "extra_headers": gateway_model_headers(model),
            }
            if supports_json_response_format(model):
                request["response_format"] = {"type": "json_object"}
            if not uses_completion_tokens(model):
                request["temperature"] = 0.2
            if extra_body:
                request["extra_body"] = extra_body
            # Claude via Compass may return Anthropic-shaped JSON that the OpenAI
            # SDK parses with choices=None; read the raw body for those models.
            if is_claude_model(model):
                raw = client.chat.completions.with_raw_response.create(**request)
                try:
                    body = raw.http_response.json()
                except Exception as exc:  # noqa: BLE001
                    raise GenerationError("Claude gateway returned a non-JSON body") from exc
                return extract_completion_text(body) or "{}"
            completion = client.chat.completions.create(**request)
            return extract_completion_text(completion) or "{}"

        return await asyncio.to_thread(_call)

    return complete


async def generate_and_register(
    *,
    dataset_name: str,
    params: dict,
    registry: DatasetRegistryService,
) -> int:
    """Generate golden rows and register them as a DRAFT dataset.

    Raises ``ValueError`` on bad params / no usable rows so the worker marks the
    job FAILED with a helpful message.
    """

    method = str(params.get("generation_method") or "").strip().lower()
    if method == "llms":
        records = await _generate_from_prompt(params)
    else:
        records = await _generate_from_grounded_seeds(params)

    tenant_id = params.get("tenant_id") or settings.pod_namespace or "local"
    product_id = params.get("product_id") or "eval-hub"
    info = await run_in_threadpool(
        registry.create_dataset,
        CreateDatasetRequest(
            dataset_name=dataset_name,
            tenant_id=tenant_id,
            product_id=product_id,
            created_by="eval-hub-generator",
        ),
    )
    # create_dataset may reuse a DRAFT or mint `{name}_vN` when the name exists.
    target_name = info.name
    count = await run_in_threadpool(registry.replace_records, target_name, records, tenant_id)
    logger.info(
        "evalhub.generation: %s -> %d DRAFT rows (method=%s, requested_name=%s)",
        target_name,
        count,
        method or "tools",
        dataset_name,
    )
    return count


async def _generate_from_prompt(params: dict) -> list[DatasetRecord]:
    seeds = [str(s).strip() for s in (params.get("seeds") or []) if str(s).strip()]
    instruction = "\n".join(seeds).strip()
    if not instruction:
        raise EvaluationInputError("LLM generation requires a generation prompt / instruction")

    num_rows = int(params.get("num_rows") or 0)
    if num_rows < 1:
        raise EvaluationInputError("LLM generation requires Size (num_rows) >= 1")

    domain = params.get("domain") or ""
    model = params.get("model") or settings.judge_model
    try:
        raw_records = await generate_records_from_prompt(
            instruction=instruction,
            num_rows=num_rows,
            complete=_build_gateway_complete(model),
            domain=domain,
        )
    except PromptGenerationError:
        raise
    return [DatasetRecord(**record) for record in raw_records]


async def _generate_from_grounded_seeds(params: dict) -> list[DatasetRecord]:
    seeds = [str(s).strip() for s in (params.get("seeds") or []) if str(s).strip()]
    if not seeds:
        raise EvaluationInputError("generation requires a generation prompt / instruction (or seed topics)")

    num_rows = int(params.get("num_rows") or 0)
    domain = params.get("domain") or ""
    model = params.get("model") or settings.judge_model
    complete = _build_gateway_complete(model)

    # Align with LLM UX: one instruction + Size → expand into N grounding seeds.
    if num_rows > 1 and len(seeds) == 1:
        try:
            seeds = await expand_instruction_to_seeds(
                instruction=seeds[0],
                num_rows=num_rows,
                complete=complete,
                domain=domain,
            )
        except PromptGenerationError:
            raise
    elif num_rows > 0:
        seeds = seeds[:num_rows]

    grounding_url = params.get("grounding_url")
    if not grounding_url:
        raise EvaluationInputError("generation requires grounding_url (the MCP /mcp endpoint to ground on)")
    grounding_tool = params.get("grounding_tool") or "search"

    source = McpToolGroundingSource(
        url=grounding_url,
        tool=grounding_tool,
        # Same namespace rule as the enqueue route: the pod's, else the job's tenant.
        tenant_namespace=settings.pod_namespace or str(params.get("tenant_id") or ""),
    )
    generator = DatasetGenerator(source=source, complete=complete, domain=domain)
    rows = await generator.generate(seeds)
    if not rows:
        raise EvaluationInputError("no rows generated (insufficient grounding material for all seeds)")

    # Reuse the exact upload-CSV parse path so generated and uploaded datasets are
    # structurally identical.
    return [DatasetRecord(**r) for r in parse_csv(rows_to_csv(rows))]
