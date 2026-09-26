"""Payload-size and persistence-redaction controls."""

from proofgrove.platform.payloads import redact_artifact_content, redact_for_persistence
from proofgrove.settings import settings


def test_redaction_masks_credentials_email_and_bounds_text():
    prior_limit = settings.max_persisted_sample_chars
    settings.max_persisted_sample_chars = 12
    try:
        payload = redact_for_persistence(
            {
                "authorization": "Bearer top-secret-token",
                "message": "Email jane.doe@example.com with sk-abcdefghijklmnop and card 4111 1111 1111 1111",
                "nested": ["x" * 20],
            }
        )
    finally:
        settings.max_persisted_sample_chars = prior_limit
    assert payload["authorization"] == "[REDACTED]"
    assert "jane.doe@example.com" not in payload["message"]
    assert "sk-abcdefghijklmnop" not in payload["message"]
    assert "4111 1111 1111 1111" not in payload["message"]
    assert payload["nested"][0].endswith("[TRUNCATED]")
    assert len(payload["message"]) <= 12
    assert len(payload["nested"][0]) <= 12


def test_truncation_remains_recursive_when_redaction_is_disabled():
    prior_limit = settings.max_persisted_sample_chars
    prior_redaction = settings.payload_redaction_enabled
    settings.max_persisted_sample_chars = 5
    settings.payload_redaction_enabled = False
    try:
        payload = redact_for_persistence({"nested": ["abcdefgh"]})
    finally:
        settings.max_persisted_sample_chars = prior_limit
        settings.payload_redaction_enabled = prior_redaction
    assert payload == {"nested": ["[TRUN"]}


def test_numeric_usage_token_counts_are_not_mistaken_for_credentials():
    assert redact_for_persistence(
        {
            "prompt_tokens": 8,
            "output_tokens": 4,
            "total_tokens": 12,
            "access_token": 123456,
            "api_token": 987654,
        }
    ) == {
        "prompt_tokens": 8,
        "output_tokens": 4,
        "total_tokens": 12,
        "access_token": "[REDACTED]",
        "api_token": "[REDACTED]",
    }


def test_artifact_redaction_masks_secrets_without_truncating_large_content():
    content = '{"api_key":"top-secret","documents":["' + ("x" * 30_000) + '"]}'

    redacted = redact_artifact_content(content, "application/json")

    assert "top-secret" not in redacted
    assert "[REDACTED]" in redacted
    assert redacted.count("x") == 30_000


def test_platform_rejects_request_larger_than_governed_limit(client):
    prior_limit = settings.max_request_body_bytes
    settings.max_request_body_bytes = 1
    try:
        response = client.post("/platform/projects", json={"name": "too-large"})
    finally:
        settings.max_request_body_bytes = prior_limit
    assert response.status_code == 413


def test_platform_rejects_chunked_request_with_no_content_length(client):
    """A body sent without ``Content-Length`` is bounded too.

    The gate above only fires when the header is present; a client streaming
    the body (chunked transfer, no declared length) previously skipped it
    entirely and could send an unbounded payload straight into a route.
    """
    prior_limit = settings.max_request_body_bytes
    settings.max_request_body_bytes = 10
    try:

        def oversized_body():
            yield b"x" * 20

        response = client.post("/platform/projects", content=oversized_body())
        assert "content-length" not in {h.lower() for h in response.request.headers}
        assert response.status_code == 413
        assert response.json()["detail"] == "request payload exceeds the configured limit"
    finally:
        settings.max_request_body_bytes = prior_limit


def test_chunked_request_within_the_limit_still_reaches_the_route(client):
    prior_limit = settings.max_request_body_bytes
    settings.max_request_body_bytes = 1_048_576
    try:

        def small_body():
            yield b'{"name": "acceptable"}'

        response = client.post("/platform/projects", content=small_body())
    finally:
        settings.max_request_body_bytes = prior_limit
    # Reaches route validation rather than being rejected at the payload gate.
    assert response.status_code != 413


def test_target_version_rejects_endpoint_credentials(client):
    response = client.post(
        "/platform/projects/project-auth/target-versions",
        json={
            "project_id": "project-auth",
            "tenant_id": "tenant-auth",
            "target_id": "unsafe",
            "name": "Unsafe endpoint",
            "version": "1",
            "endpoint": "https://agent.example/v1/chat?api_key=secret",
        },
    )
    assert response.status_code == 422
