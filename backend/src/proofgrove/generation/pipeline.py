"""Run a dataset-generation job: synthesise golden rows and register them as a
DRAFT dataset for human review.

Used by the async worker (proofgrove.runs_worker) for ``kind="generate"`` jobs.

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

import httpx
from fastapi.concurrency import run_in_threadpool

from proofgrove.datasets.csv_parser import parse_csv
from proofgrove.datasets.models import CreateDatasetRequest, DatasetRecord
from proofgrove.datasets.registry import DatasetRegistryService
from proofgrove.errors import EvaluationInputError
from proofgrove.evaluation.local_lab import local_lab_mode
from proofgrove.evaluation.model_providers import ENDPOINTS, endpoint_credential, provider_snapshot, target_provider_problem
from proofgrove.generation.generator import DatasetGenerator, GenerationError, rows_to_csv
from proofgrove.generation.prompt_generator import (
    PromptGenerationError,
    expand_instruction_to_seeds,
    generate_records_from_prompt,
)
from proofgrove.generation.prompts import prompt_records_schema
from proofgrove.generation.sources import McpToolGroundingSource
from proofgrove.settings import settings

logger = logging.getLogger(__name__)


async def resolve_generation_target(model: str | None, endpoint: str | None = None) -> tuple[str, str]:
    """Resolve and verify an eligible generation route without generating tokens."""
    selected_model = (model or "").strip()
    base_url = (endpoint or "").strip().rstrip("/")
    mode = local_lab_mode(settings)
    if mode is not None:
        if mode == "offline":
            raise EvaluationInputError("Offline rehearsal cannot generate datasets. Connect a model in Models and start the local or live profile.")
        if not base_url:
            snapshot = await provider_snapshot(settings)
            matches = [item for provider in snapshot["providers"] for item in provider["models"] if item["model_id"] == selected_model]
            if not selected_model and snapshot["default"]:
                selected_model = snapshot["default"]["model_id"]
                base_url = snapshot["default"]["endpoint"]
            elif len(matches) == 1:
                base_url = matches[0]["endpoint"]
            else:
                raise EvaluationInputError("Choose an available generation model and its provider in Models.")
        if base_url not in ENDPOINTS.values():
            raise EvaluationInputError("Dataset generation supports the connected OpenAI and local Ollama providers. Choose one in Models.")
    else:
        configured = settings.openai_base_url.rstrip("/")
        if base_url and base_url != configured:
            raise EvaluationInputError("Generation endpoint must match the configured model gateway.")
        base_url = configured
        selected_model = selected_model or settings.judge_model
    if not selected_model:
        raise EvaluationInputError("Select a generation model.")
    problem = await target_provider_problem(settings, base_url, selected_model)
    if problem:
        raise EvaluationInputError(problem[1])
    return selected_model, base_url


def _build_gateway_complete(model: str, model_endpoint: str | None = None, *, response_schema: dict | None = None) -> Callable[[list[dict[str, str]]], Awaitable[str]]:
    """Use the selected provider, rechecking eligibility immediately before each call."""
    from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI

    from proofgrove.evaluation.llm_judge import (
        completion_token_params,
        extract_completion_text,
        gateway_model_headers,
        is_claude_model,
        reshape_messages_for_model,
        supports_json_response_format,
        uses_completion_tokens,
    )

    async def complete(messages: list[dict[str, str]]) -> str:
        selected_model, base_url = await resolve_generation_target(model, model_endpoint)

        def _call() -> str:
            # Credentials are resolved per call and can only reach the fixed
            # OpenAI endpoint locally, or the configured nonlocal gateway.
            with OpenAI(
                api_key=endpoint_credential(settings, base_url) or "not-needed",
                base_url=base_url, timeout=120, max_retries=0,
                http_client=httpx.Client(follow_redirects=False, trust_env=False),
            ) as client:
                max_tokens = max(settings.judge_max_tokens, 8192 if response_schema else 4096)
                adapted_messages, extra_body = reshape_messages_for_model(selected_model, messages)
                request: dict = {
                    "model": selected_model,
                    "messages": adapted_messages,
                    **completion_token_params(selected_model, max_tokens),
                    "extra_headers": gateway_model_headers(selected_model),
                }
                if base_url == ENDPOINTS["ollama"] and response_schema:
                    request["response_format"] = {
                        "type": "json_schema",
                        "json_schema": {"name": "golden_records", "strict": True, "schema": response_schema},
                    }
                elif supports_json_response_format(selected_model):
                    request["response_format"] = {"type": "json_object"}
                if not uses_completion_tokens(selected_model):
                    request["temperature"] = 0.2
                if extra_body:
                    request["extra_body"] = extra_body
                if is_claude_model(selected_model):
                    raw = client.chat.completions.with_raw_response.create(**request)
                    try:
                        body = raw.http_response.json()
                    except Exception as exc:  # noqa: BLE001
                        raise GenerationError("Model gateway returned a non-JSON body") from exc
                    return extract_completion_text(body) or "{}"
                completion = client.chat.completions.create(**request)
                if completion.choices and getattr(completion.choices[0], "finish_reason", None) == "length":
                    raise GenerationError("Generation response reached the output limit. Reduce Size or shorten the requested cases.")
                return extract_completion_text(completion) or "{}"

        try:
            return await asyncio.to_thread(_call)
        except APITimeoutError:
            raise GenerationError("Generation model timed out. Reduce Size or choose another connected model.") from None
        except APIConnectionError:
            raise GenerationError("Cannot reach the generation model. Check its connection in Models and retry.") from None
        except APIStatusError as exc:
            if exc.status_code in {401, 403}:
                message = "Generation model rejected authentication. Check the provider connection in Models."
            elif exc.status_code == 429:
                message = "Generation provider limit reached. Check provider capacity or choose a local model."
            else:
                message = "Generation provider rejected the request. Refresh Models or choose another connected model."
            raise GenerationError(message) from None

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
    product_id = params.get("product_id") or "proofgrove"
    info = await run_in_threadpool(
        registry.create_dataset,
        CreateDatasetRequest(
            dataset_name=dataset_name,
            tenant_id=tenant_id,
            product_id=product_id,
            created_by="proofgrove-generator",
        ),
    )
    # create_dataset may reuse a DRAFT or mint `{name}_vN` when the name exists.
    target_name = info.name
    count = await run_in_threadpool(registry.replace_records, target_name, records, tenant_id)
    logger.info(
        "proofgrove.generation: %s -> %d DRAFT rows (method=%s, requested_name=%s)",
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
            complete=_build_gateway_complete(model, params.get("model_endpoint"), response_schema=prompt_records_schema(num_rows)),
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
    complete = _build_gateway_complete(model, params["model_endpoint"]) if params.get("model_endpoint") else _build_gateway_complete(model)

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
