"""Tests for LLM-as-a-Judge model catalogue filtering."""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from evalhub.evaluation.judge_models import (
    filter_judge_model_ids,
    is_judge_model,
    order_judge_models,
)
from evalhub.main import app
from evalhub.settings import settings


def test_is_judge_model_filters_non_chat_modalities():
    assert is_judge_model("gpt-4.1-mini")
    assert is_judge_model("claude-sonnet-4.6")
    assert not is_judge_model("text-embedding-3-large")
    assert not is_judge_model("embed-v-4-0")
    assert not is_judge_model("whisper-1")
    assert not is_judge_model("gpt-4o-mini-tts")
    assert not is_judge_model("gpt-4o-transcribe")
    assert not is_judge_model("gpt-image-1")
    assert not is_judge_model("gpt-realtime")
    assert not is_judge_model("qwen3-reranker")
    assert not is_judge_model("qwen3-embedding")


def test_filter_and_order_judge_models():
    models = filter_judge_model_ids(
        [
            "text-embedding-3-large",
            "gpt-5.1",
            "claude-sonnet-4.6",
            "gpt-4.1-mini",
            "gpt-5.1",
        ]
    )
    assert models == ["claude-sonnet-4.6", "gpt-4.1-mini", "gpt-5.1"]
    assert order_judge_models(models, "gpt-4.1-mini") == [
        "gpt-4.1-mini",
        "claude-sonnet-4.6",
        "gpt-5.1",
    ]


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_judge_models_endpoint_filters_embeddings(client: TestClient):
    listing = MagicMock()
    listing.data = [
        MagicMock(id="gpt-4.1-mini"),
        MagicMock(id="text-embedding-3-large"),
        MagicMock(id="claude-opus-4.6"),
        MagicMock(id="gpt-realtime"),
    ]

    async def immediate(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    with (
        patch.object(settings, "judge_provider", "openai"),
        patch.object(settings, "openai_api_key", SecretStr("test-key")),
        patch.object(settings, "judge_model", "gpt-4.1-mini"),
        patch.object(settings, "openai_base_url", "http://ai-gateway.example/v1"),
        patch("evalhub.api.v1.llms.OpenAI") as openai_cls,
        patch("evalhub.api.v1.evaluation.run_in_threadpool", side_effect=immediate),
    ):
        openai_cls.return_value.models.list.return_value = listing
        response = client.get("/evaluation/judge-models")

    assert response.status_code == 200
    body = response.json()
    assert body["fallback"] is False
    assert body["models"] == ["gpt-4.1-mini", "claude-opus-4.6"]
    # Listing must not pin a static x-model-id header.
    assert openai_cls.call_args.kwargs.get("default_headers") in (None, {})
