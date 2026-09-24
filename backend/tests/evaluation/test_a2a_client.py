"""Tests for the A2A agent client (URL builder + SSE parse/aggregate)."""

import json

import httpx
import pytest
import respx

from evalhub.evaluation.models import ToolCall
from evalhub.evaluation.target.a2a_client import (
    AgentInvocationError,
    _aggregate,
    _aggregate_usage,
    _parse_event,
    externalize_large_tool_results,
    invoke_agent,
    kagent_a2a_url,
)


def test_kagent_a2a_url_escapes_and_trailing_slash():
    url = kagent_a2a_url("http://kagent:8083/", "tenant-evalai", "my-agent")
    assert url == "http://kagent:8083/api/a2a/tenant-evalai/my-agent/"


def test_parse_event_extracts_artifact_status_and_context():
    frame = _parse_event(
        '{"jsonrpc":"2.0","result":{"kind":"status-update","contextId":"ctx-1",'
        '"status":{"message":{"role":"assistant","parts":[{"kind":"text","text":"hi"}],'
        '"metadata":{"kagent_adk_partial":true}}}}}'
    )
    assert frame.status_chunks == ["hi"]
    assert frame.status_partial is True
    assert frame.context_id == "ctx-1"
    assert frame.error is None


def test_parse_event_ignores_user_echo_and_done():
    assert _parse_event("[DONE]").status_chunks == []
    assert _parse_event("not-json").status_chunks == []
    user_echo = _parse_event(
        '{"result":{"status":{"message":{"role":"user","parts":[{"kind":"text","text":"q"}]}}}}'
    )
    assert user_echo.status_chunks == []


def test_parse_event_surfaces_jsonrpc_error():
    frame = _parse_event('{"error":{"code":-32000,"message":"boom"}}')
    assert frame.error == {"code": -32000, "message": "boom"}


def test_aggregate_prefers_artifact_body():
    frames = [
        _parse_event('{"result":{"status":{"message":{"role":"assistant","parts":[{"kind":"text","text":"partial"}]}}}}'),
        _parse_event('{"result":{"artifact":{"parts":[{"kind":"text","text":"final answer"}]},"contextId":"ctx-9"}}'),
    ]
    text, context_id, _ = _aggregate(frames)
    assert text == "final answer"
    assert context_id == "ctx-9"


def test_aggregate_status_fallback_dedupes_v09_deltas():
    # v0.9: deltas (partial=true) then a per-step aggregate (partial=false) that
    # repeats the full text. Aggregate must commit once, not double.
    frames = [
        _parse_event('{"result":{"status":{"message":{"role":"assistant","parts":[{"kind":"text","text":"Hel"}],"metadata":{"kagent_adk_partial":true}}}}}'),
        _parse_event('{"result":{"status":{"message":{"role":"assistant","parts":[{"kind":"text","text":"lo"}],"metadata":{"kagent_adk_partial":true}}}}}'),
        _parse_event('{"result":{"status":{"message":{"role":"assistant","parts":[{"kind":"text","text":"Hello"}],"metadata":{"kagent_adk_partial":false}}}}}'),
    ]
    text, _, _ = _aggregate(frames)
    assert text == "Hello"


def test_large_tool_result_becomes_artifact_without_losing_content():
    content = {"documents": ["x" * 70_000, "y" * 70_000]}

    calls, artifacts = externalize_large_tool_results(
        [ToolCall(name="document_search", output=content)],
        max_inline_bytes=128 * 1024,
    )

    assert len(artifacts) == 1
    artifact = artifacts[0]
    assert artifact.tool_name == "document_search"
    assert artifact.size_bytes > 128 * 1024
    assert artifact.content.endswith('yyyyyyyyyy"]}')
    assert artifact.preview_bytes <= 128 * 1024
    assert calls[0].output["artifact_ref"] == artifact.artifact_ref
    assert calls[0].output["truncated"] is True


def _sse(*frames: str) -> bytes:
    return ("".join(f"data: {f}\n\n" for f in frames)).encode()


@respx.mock
@pytest.mark.asyncio
async def test_invoke_agent_aggregates_stream():
    body = _sse(
        '{"result":{"status":{"message":{"role":"assistant","parts":[{"kind":"text","text":"Paris"}],"metadata":{"kagent_adk_partial":false}}},"contextId":"ctx-7"}}',
        "[DONE]",
    )
    route = respx.post("http://kagent:8083/api/a2a/tenant-evalai/geo/").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=body
        )
    )
    result = await invoke_agent(
        kagent_url="http://kagent:8083",
        namespace="tenant-evalai",
        agent_name="geo",
        prompt="capital of France?",
    )
    assert result.text == "Paris"
    assert result.context_id == "ctx-7"
    assert result.invocation_id
    assert result.invocation_id != result.context_id
    assert len(result.trace_id) == 32
    traceparent = route.calls[0].request.headers["traceparent"]
    assert traceparent.startswith(f"00-{result.trace_id}-")
    assert int(traceparent.rsplit("-", 1)[1], 16) & 0x01
    assert route.calls[0].request.headers["tracestate"] == "evalaieval=1"
    assert route.calls[0].request.headers["x-ctx-agent-run-id"] == result.invocation_id


def test_usage_aggregation_deduplicates_terminal_repeat():
    frames = [
        _parse_event(
            '{"result":{"metadata":{"kagent_usage_metadata":'
            '{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12}}}}'
        ),
        _parse_event(
            '{"result":{"metadata":{"kagent_usage_metadata":'
            '{"promptTokenCount":20,"candidatesTokenCount":4,"totalTokenCount":24}}}}'
        ),
        _parse_event(
            '{"result":{"final":true,"metadata":{"kagent_usage_metadata":'
            '{"promptTokenCount":20,"candidatesTokenCount":4,"totalTokenCount":24}}}}'
        ),
    ]

    assert _aggregate_usage(frames) == {
        "prompt_tokens": 30,
        "output_tokens": 6,
        "total_tokens": 36,
        "records": [
            {"prompt_tokens": 10, "output_tokens": 2, "total_tokens": 12},
            {"prompt_tokens": 20, "output_tokens": 4, "total_tokens": 24},
        ],
    }


def test_usage_aggregation_ignores_malformed_optional_metadata():
    frames = [
        _parse_event(
            '{"result":{"metadata":{"kagent_usage_metadata":'
            '{"promptTokenCount":"unknown","totalTokenCount":-1}}}}'
        )
    ]

    assert _aggregate_usage(frames) is None


def test_byo_tool_calls_preserve_structured_output():
    frame = _parse_event(
        '{"result":{"status":{"message":{"role":"assistant","metadata":{'
        '"evalai.ai/tool-calls":[{"name":"lookup","args":{"id":7},'
        '"result":{"api_key":"secret","count":2}}]}}}}}'
    )

    _, _, calls = _aggregate([frame])
    assert calls[0].output == {"api_key": "secret", "count": 2}
    assert calls[0].result_captured is True


def test_byo_tool_calls_preserve_explicit_null_result():
    frame = _parse_event(
        '{"result":{"status":{"message":{"role":"assistant","metadata":{'
        '"evalai.ai/tool-calls":[{"name":"delete","args":{},"result":null}]}}}}}'
    )

    _, _, calls = _aggregate([frame])
    assert calls[0].output is None
    assert calls[0].result_captured is True


@respx.mock
@pytest.mark.asyncio
async def test_invoke_agent_captures_byo_tool_calls_metadata():
    # BYO agent reports its tool calls inline via status.message.metadata.
    frame = {
        "result": {
            "contextId": "ctx-byo",
            "status": {
                "message": {
                    "role": "assistant",
                    "parts": [{"kind": "text", "text": "AAPL revenue is $383B"}],
                    "metadata": {
                        "kagent_adk_partial": False,
                        "evalai.ai/tool-calls": [
                            {"name": "search", "args": {"query": "AAPL revenue"}, "result": "{...}"}
                        ],
                    },
                }
            },
        }
    }
    import json as _json

    respx.post("http://kagent:8083/api/a2a/tenant-evalai/kensho-grounding/").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=f"data: {_json.dumps(frame)}\n\n[DONE]\n\n".encode(),
        )
    )
    result = await invoke_agent(
        kagent_url="http://kagent:8083",
        namespace="tenant-evalai",
        agent_name="kensho-grounding",
        prompt="AAPL revenue?",
    )
    assert result.text == "AAPL revenue is $383B"
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "search"
    assert result.tool_calls[0].args == {"query": "AAPL revenue"}
    assert result.tool_calls[0].output == "{...}"


@respx.mock
@pytest.mark.asyncio
async def test_invoke_agent_raises_on_404():
    respx.post("http://kagent:8083/api/a2a/tenant-evalai/missing/").mock(
        return_value=httpx.Response(404, text="not found")
    )
    with pytest.raises(AgentInvocationError, match="not found"):
        await invoke_agent(
            kagent_url="http://kagent:8083",
            namespace="tenant-evalai",
            agent_name="missing",
            prompt="hi",
        )


@pytest.mark.asyncio
async def test_invoke_agent_rejects_empty_prompt():
    with pytest.raises(AgentInvocationError, match="prompt"):
        await invoke_agent(
            kagent_url="http://kagent:8083",
            namespace="tenant-evalai",
            agent_name="geo",
            prompt="   ",
        )


@pytest.mark.parametrize("metadata, expected", [
    ({"totalTokenCount": 12}, (None, None, 12)),
    ({"promptTokenCount": 0}, (0, None, None)),
    ({"promptTokenCount": 0, "candidatesTokenCount": 0}, (0, 0, 0)),
    ({"promptTokenCount": 10, "candidatesTokenCount": 2}, (10, 2, 12)),
])
def test_usage_aggregation_preserves_missing_counts(metadata, expected):
    frame = _parse_event(json.dumps({"result": {"metadata": {"kagent_usage_metadata": metadata}}}))
    usage = _aggregate_usage([frame])
    assert tuple(usage[key] for key in ("prompt_tokens", "output_tokens", "total_tokens")) == expected


def test_usage_aggregation_does_not_present_partial_counts_as_complete():
    frames = [_parse_event(json.dumps({"result": {"metadata": {"kagent_usage_metadata": data}}})) for data in (
        {"promptTokenCount": 10, "candidatesTokenCount": 2, "totalTokenCount": 12},
        {"totalTokenCount": 8},
    )]
    usage = _aggregate_usage(frames)
    assert usage["prompt_tokens"] is None
    assert usage["output_tokens"] is None
    assert usage["total_tokens"] == 20
