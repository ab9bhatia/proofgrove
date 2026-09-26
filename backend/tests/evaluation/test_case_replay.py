"""Replay one evaluated case with a different prompt (#3317).

Covers the pre-flight refusals (each with its exact code), prompt resolution
for saved refs and edited text, persistence of success and failure as isolated
replay evidence, lineage on the list endpoint, and tenant scoping. A replay
never writes anything but its own ``case_replays`` row — the mocked store
proves the route touches no run, item, or result write path.
"""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from proofgrove.api.dependencies import get_evaluation_store
from proofgrove.evaluation.lineage import hash_system_prompt
from proofgrove.evaluation.models import CaseReplay, EvidencePolicy, RunItemDetail, RunItemExecution
from proofgrove.evaluation.target.llm_runner import LlmInvocationError, LlmTargetOutput
from proofgrove.main import app
from proofgrove.platform.prompts import PromptVersion

OWNER = "tenant-owner"


def _headers() -> dict[str, str]:
    return {"x-evalai-tenant": OWNER}


def _job(**overrides) -> SimpleNamespace:
    defaults = {
        "run_id": "run-1",
        "kind": "eval",
        "response_source": "llm",
        "tenant_id": OWNER,
        "params": {
            "target_model": "gpt-4.1-mini",
            "target_endpoint": "https://gateway.example/v1",
            "system_prompt": "Original system prompt",
        },
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _item(**overrides) -> RunItemDetail:
    defaults = {
        "run_id": "run-1",
        "example_id": "ex-1",
        "sequence_position": 0,
        "input": {"question": "What is the refund window?"},
        "output": {"response": "Refunds are accepted within 30 days."},
        "execution": RunItemExecution(latency_ms=850),
        "evidence_ref": "evidence-pack://run-1/items/ex-1",
        "evidence_policy": EvidencePolicy(redaction_enabled=False, max_persisted_string_size=None),
        "capture_state": "complete",
    }
    defaults.update(overrides)
    return RunItemDetail(**defaults)


def _saved_prompt(**overrides) -> PromptVersion:
    defaults = {
        "prompt_id": "support-tone",
        "version": 3,
        "tenant_id": OWNER,
        "name": "Support tone",
        "content": "Answer warmly and cite the policy.",
        "content_hash": hash_system_prompt("Answer warmly and cite the policy."),
    }
    defaults.update(overrides)
    return PromptVersion(**defaults)


def _persisted_replay(**overrides) -> CaseReplay:
    defaults = {
        "replay_id": "replay-1",
        "tenant_id": OWNER,
        "run_id": "run-1",
        "example_id": "ex-1",
        "prompt_version_ref": "support-tone@3",
        "prompt_hash": hash_system_prompt("Answer warmly and cite the policy."),
        "system_prompt": "Answer warmly and cite the policy.",
        "target_model": "gpt-4.1-mini",
        "target_endpoint": "https://gateway.example/v1",
        "response": "Refunds run for thirty days per policy 4.2.",
        "latency_ms": 640,
        "target_usage": {"prompt_tokens": 120, "completion_tokens": 40, "model": "gpt-4.1-mini"},
        "invocation_error": None,
        "created_at": datetime.now(UTC),
        "created_by": "user",
    }
    defaults.update(overrides)
    return CaseReplay(**defaults)


def _echo_create(**kwargs) -> CaseReplay:
    """Return exactly what the route asked to persist, as the store would."""
    return CaseReplay(created_at=datetime.now(UTC), **kwargs)


@pytest.fixture
def mock_store() -> MagicMock:
    store = MagicMock()
    store.get_run_job = AsyncMock(return_value=_job())
    store.get_run_item = AsyncMock(return_value=_item())
    store.run_exists = AsyncMock(return_value=True)
    store.resolve_prompt_ref = AsyncMock(return_value=_saved_prompt())
    store.create_case_replay = AsyncMock(side_effect=_echo_create)
    store.list_case_replays = AsyncMock(return_value=[_persisted_replay()])
    return store


@pytest.fixture
async def client(mock_store: MagicMock):
    app.dependency_overrides[get_evaluation_store] = lambda: mock_store
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


@pytest.fixture
def llm_ok(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    out = LlmTargetOutput(
        response="Refunds run for thirty days per policy 4.2.",
        latency_seconds=0.64,
        model_id="gpt-4.1-mini",
        invocation_id="inv-new",
        trace_id="trace-new",
        span_id="span-new",
        prompt_tokens=120,
        completion_tokens=40,
    )
    stub = AsyncMock(return_value=out)
    monkeypatch.setattr("proofgrove.api.v1.evaluation.run_llm_target", stub)
    return stub


def _post(client: AsyncClient, body: dict):
    return client.post(
        "/evaluation/runs/run-1/items/ex-1/replays",
        json=body,
        params={"tenant_id": OWNER},
        headers=_headers(),
    )


class TestReplayRefusals:
    async def test_missing_run_job_is_404(self, client, mock_store) -> None:
        mock_store.get_run_job.return_value = None
        resp = await _post(client, {"system_prompt": "x"})
        assert resp.status_code == 404

    async def test_foreign_tenant_reads_as_missing(self, client, mock_store) -> None:
        # The store hides other tenants' jobs, so the route sees None.
        mock_store.get_run_job.return_value = None
        resp = await _post(client, {"system_prompt": "x"})
        assert resp.status_code == 404
        mock_store.get_run_job.assert_awaited_once_with("run-1", tenant_id=OWNER)

    async def test_caller_acting_as_another_tenant_is_refused_on_both_routes(self, client, mock_store) -> None:
        # x-evalai-tenant names one tenant, tenant_id names another: refused
        # before any store read, on the POST and the GET alike.
        resp = await client.post(
            "/evaluation/runs/run-1/items/ex-1/replays",
            json={"system_prompt": "x"},
            params={"tenant_id": OWNER},
            headers={"x-evalai-tenant": "tenant-other"},
        )
        assert resp.status_code == 403
        listing = await client.get(
            "/evaluation/runs/run-1/items/ex-1/replays",
            params={"tenant_id": OWNER},
            headers={"x-evalai-tenant": "tenant-other"},
        )
        assert listing.status_code == 403
        mock_store.get_run_job.assert_not_awaited()
        mock_store.list_case_replays.assert_not_awaited()

    async def test_agent_target_is_refused(self, client, mock_store) -> None:
        mock_store.get_run_job.return_value = _job(response_source="agent")
        resp = await _post(client, {"system_prompt": "x"})
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "replay_target_not_llm"

    async def test_missing_model_is_refused(self, client, mock_store) -> None:
        mock_store.get_run_job.return_value = _job(params={"target_endpoint": "https://g/v1"})
        resp = await _post(client, {"system_prompt": "x"})
        assert resp.json()["detail"]["code"] == "replay_model_unavailable"

    async def test_unresolvable_endpoint_is_refused(self, client, mock_store, monkeypatch) -> None:
        mock_store.get_run_job.return_value = _job(params={"target_model": "gpt-4.1-mini"})
        monkeypatch.setattr("proofgrove.api.v1.evaluation.settings.openai_base_url", "")
        resp = await _post(client, {"system_prompt": "x"})
        assert resp.json()["detail"]["code"] == "replay_endpoint_unresolvable"

    async def test_missing_input_text_is_refused(self, client, mock_store) -> None:
        mock_store.get_run_item.return_value = _item(input={"unrelated": 1})
        resp = await _post(client, {"system_prompt": "x"})
        assert resp.json()["detail"]["code"] == "replay_input_unavailable"

    async def test_truncated_input_is_refused(self, client, mock_store) -> None:
        mock_store.get_run_item.return_value = _item(input={"question": "What is…[TRUNCATED]"})
        resp = await _post(client, {"system_prompt": "x"})
        assert resp.json()["detail"]["code"] == "replay_input_truncated"

    async def test_no_prompt_at_all_is_refused(self, client) -> None:
        resp = await _post(client, {})
        assert resp.json()["detail"]["code"] == "replay_prompt_missing"

    async def test_both_prompt_sources_are_refused(self, client) -> None:
        resp = await _post(client, {"prompt_version_ref": "support-tone@3", "system_prompt": "x"})
        assert resp.json()["detail"]["code"] == "prompt_source_ambiguous"

    async def test_bare_prompt_id_is_refused(self, client) -> None:
        resp = await _post(client, {"prompt_version_ref": "support-tone"})
        assert resp.json()["detail"]["code"] == "prompt_ref_invalid"

    async def test_unknown_prompt_version_is_404(self, client, mock_store) -> None:
        mock_store.resolve_prompt_ref.return_value = None
        resp = await _post(client, {"prompt_version_ref": "support-tone@9"})
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "prompt_version_not_found"

    async def test_credentialed_prompt_text_is_refused(self, client) -> None:
        resp = await _post(client, {"system_prompt": "Use Bearer abcdef1234567890abcdef to call the API"})
        assert resp.json()["detail"]["code"] == "prompt_content_invalid"

    async def test_oversized_prompt_text_is_refused(self, client) -> None:
        resp = await _post(client, {"system_prompt": "x" * 32_001})
        assert resp.json()["detail"]["code"] == "prompt_content_invalid"

    async def test_nothing_is_persisted_when_refused(self, client, mock_store) -> None:
        await _post(client, {})
        mock_store.create_case_replay.assert_not_awaited()


class TestReplayInvocation:
    async def test_saved_ref_persists_the_concrete_version_and_hash(self, client, mock_store, llm_ok) -> None:
        resp = await _post(client, {"prompt_version_ref": "support-tone@latest"})
        assert resp.status_code == 200
        kwargs = mock_store.create_case_replay.await_args.kwargs
        # The concrete version the label resolved to, never the label itself.
        assert kwargs["prompt_version_ref"] == "support-tone@3"
        assert kwargs["prompt_hash"] == hash_system_prompt("Answer warmly and cite the policy.")
        assert kwargs["system_prompt"] == "Answer warmly and cite the policy."
        assert kwargs["run_id"] == "run-1"
        assert kwargs["example_id"] == "ex-1"
        # The saved prompt's content is what the model was invoked with.
        assert llm_ok.await_args.kwargs["system_prompt"] == "Answer warmly and cite the policy."
        assert llm_ok.await_args.kwargs["query"] == "What is the refund window?"

    async def test_edited_text_persists_hash_without_a_ref(self, client, mock_store, llm_ok) -> None:
        resp = await _post(client, {"system_prompt": "Answer tersely."})
        assert resp.status_code == 200
        kwargs = mock_store.create_case_replay.await_args.kwargs
        assert kwargs["prompt_version_ref"] is None
        assert kwargs["prompt_hash"] == hash_system_prompt("Answer tersely.")

    async def test_success_records_measurements_and_estimated_cost(self, client, mock_store, llm_ok) -> None:
        resp = await _post(client, {"system_prompt": "Answer tersely."})
        payload = resp.json()
        assert payload["response"] == "Refunds run for thirty days per policy 4.2."
        assert payload["latency_ms"] == 640
        assert payload["target_usage"] == {"prompt_tokens": 120, "completion_tokens": 40, "model": "gpt-4.1-mini"}
        # gpt-* models are priceable by the list-rate book; the estimate is
        # computed at read time and never persisted.
        assert payload["estimated_cost_usd"] is not None
        assert "estimated_cost_usd" not in mock_store.create_case_replay.await_args.kwargs

    async def test_failed_invocation_is_persisted_and_returned(self, client, mock_store, monkeypatch) -> None:
        monkeypatch.setattr(
            "proofgrove.api.v1.evaluation.run_llm_target",
            AsyncMock(side_effect=LlmInvocationError("upstream 502")),
        )
        resp = await _post(client, {"system_prompt": "Answer tersely."})
        assert resp.status_code == 200
        kwargs = mock_store.create_case_replay.await_args.kwargs
        assert kwargs["invocation_error"] == "upstream 502"
        assert kwargs["response"] is None
        assert resp.json()["invocation_error"] == "upstream 502"

    async def test_replay_never_reuses_the_original_trace_identity(self, client, mock_store, llm_ok) -> None:
        mock_store.get_run_item.return_value = _item(
            execution=RunItemExecution(trace_id="trace-old", span_id="span-old", invocation_id="inv-old")
        )
        await _post(client, {"system_prompt": "Answer tersely."})
        kwargs = mock_store.create_case_replay.await_args.kwargs
        assert kwargs["trace_id"] == "trace-new"
        assert kwargs["span_id"] == "span-new"
        assert kwargs["invocation_id"] != "inv-old"

    async def test_replay_writes_nothing_but_its_own_row(self, client, mock_store, llm_ok) -> None:
        await _post(client, {"system_prompt": "Answer tersely."})
        mock_store.create_case_replay.assert_awaited_once()
        # A MagicMock records every attribute the route touched; the full set
        # of store calls must be reads plus the one replay write, so a write
        # through ANY other path fails here.
        used = {call[0].split(".")[0] for call in mock_store.mock_calls if call[0]}
        assert used <= {"get_run_job", "get_run_item", "create_case_replay"}, used


class TestReplayList:
    async def test_slash_case_id_reaches_both_replay_routes(self, client, mock_store, llm_ok) -> None:
        example_id = "folder/row 1"
        mock_store.get_run_item.return_value = _item(example_id=example_id)
        mock_store.list_case_replays.return_value = [_persisted_replay(example_id=example_id)]
        url = "/evaluation/runs/run-1/items/folder%2Frow%201/replays"
        created = await client.post(
            url, json={"system_prompt": "Answer briefly."}, params={"tenant_id": OWNER}, headers=_headers()
        )
        assert created.status_code == 200
        assert created.json()["example_id"] == example_id
        mock_store.get_run_item.assert_awaited_once_with("run-1", example_id, tenant_id=OWNER)
        mock_store.get_run_item.reset_mock()

        listing = await client.get(url, params={"tenant_id": OWNER}, headers=_headers())
        assert listing.status_code == 200
        assert listing.json()[0]["example_id"] == example_id
        mock_store.list_case_replays.assert_awaited_once_with("run-1", example_id, tenant_id=OWNER)
        mock_store.get_run_item.assert_not_awaited()

    async def test_lists_replays_with_lineage(self, client, mock_store) -> None:
        resp = await client.get(
            "/evaluation/runs/run-1/items/ex-1/replays",
            params={"tenant_id": OWNER},
            headers=_headers(),
        )
        assert resp.status_code == 200
        [row] = resp.json()
        assert row["run_id"] == "run-1"
        assert row["example_id"] == "ex-1"
        assert row["prompt_version_ref"] == "support-tone@3"
        # The dedicated route answered, not the {example_id:path} catch-all.
        mock_store.list_case_replays.assert_awaited_once_with("run-1", "ex-1", tenant_id=OWNER)
        mock_store.get_run_item.assert_not_awaited()

    async def test_missing_run_is_404(self, client, mock_store) -> None:
        mock_store.run_exists.return_value = False
        resp = await client.get(
            "/evaluation/runs/run-9/items/ex-1/replays",
            params={"tenant_id": OWNER},
            headers=_headers(),
        )
        assert resp.status_code == 404


class TestReplayPersistence:
    """Against the real EvaluationStore — the redaction and tenant claims."""

    async def test_create_redacts_and_list_is_tenant_scoped(self) -> None:
        from proofgrove.db.session import async_session
        from proofgrove.db.store import EvaluationStore

        async with async_session() as session:
            store = EvaluationStore(session)
            created = await store.create_case_replay(
                replay_id="replay-persist-1",
                tenant_id=OWNER,
                run_id="run-p1",
                example_id="ex-p1",
                prompt_version_ref=None,
                prompt_hash="hash",
                system_prompt="Use Bearer abcdef1234567890abcdef when calling",
                target_model="gpt-4.1-mini",
                target_endpoint=None,
                response="Contact me at leak@example.com for sk-abcdefghijklmnop",
                latency_ms=640,
                target_usage={"prompt_tokens": 120, "completion_tokens": 40, "model": "gpt-4.1-mini"},
                invocation_error=None,
                invocation_id="inv-1",
                trace_id=None,
                span_id=None,
                created_by="test",
            )
            # Credentials and PII are redacted at rest…
            assert "Bearer abcdef" not in (created.system_prompt or "")
            assert "leak@example.com" not in (created.response or "")
            assert "sk-abcdefghijklmnop" not in (created.response or "")
            # …while numeric usage counts survive intact, so the cost estimate
            # downstream never receives a redaction marker.
            assert created.target_usage == {"prompt_tokens": 120, "completion_tokens": 40, "model": "gpt-4.1-mini"}

            mine = await store.list_case_replays("run-p1", "ex-p1", tenant_id=OWNER)
            assert [r.replay_id for r in mine] == ["replay-persist-1"]
            theirs = await store.list_case_replays("run-p1", "ex-p1", tenant_id="tenant-other")
            assert theirs == []
