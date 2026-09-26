"""Fail-closed startup contracts for injected runtime credentials."""

import pytest
from pydantic import ValidationError

from proofgrove.settings import Settings

PRODUCTION_DATABASE_URL = (
    "postgresql+asyncpg://proofgrove:injected@postgres.example:5432/proofgrove?sslmode=require"
)


def _settings(**overrides) -> Settings:
    values = {
        "app_env": "prod",
        "database_url": PRODUCTION_DATABASE_URL,
        "trace_index_enabled": False,
        "platform_auth_required": True,
        "authz_check_token": "vault-injected-authz-token",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def test_production_accepts_vault_injected_postgres_and_archive_credentials() -> None:
    configured = _settings(
        trace_archive_enabled=True,
        trace_archive_profile="default",
        trace_archive_auth_mode="accessKey",
        trace_archive_endpoint="http://minio.telemetry.svc.cluster.local:9000",
        trace_archive_access_key="vault-injected-access-key",
        trace_archive_secret_key="vault-injected-secret-key",
    )

    assert configured.database_url == PRODUCTION_DATABASE_URL
    assert configured.trace_archive_auth_mode == "accessKey"


def test_production_accepts_key_vault_postgres_and_workload_identity_archive() -> None:
    configured = _settings(
        trace_archive_enabled=True,
        trace_archive_profile="azure",
        trace_archive_endpoint="https://stexample.blob.core.windows.net",
    )

    assert configured.database_url == PRODUCTION_DATABASE_URL
    assert configured.trace_archive_auth_mode == "workloadIdentity"
    assert configured.trace_archive_access_key.get_secret_value() == ""
    assert configured.trace_archive_secret_key.get_secret_value() == ""


@pytest.mark.parametrize(
    "database_url",
    ["", "postgresql+asyncpg://proofgrove:proofgrove@localhost:5432/proofgrove"],
)
def test_production_refuses_missing_or_development_postgres_credentials(database_url: str) -> None:
    with pytest.raises(ValidationError, match="proofgrove-postgres-credentials Secret"):
        _settings(database_url=database_url)


@pytest.mark.parametrize(
    ("access_key", "secret_key"),
    [("", ""), ("injected-access-key", ""), ("", "injected-secret-key")],
)
def test_production_refuses_incomplete_archive_secret(
    access_key: str,
    secret_key: str,
) -> None:
    with pytest.raises(ValidationError, match="archive credential Secret"):
        _settings(
            trace_archive_enabled=True,
            trace_archive_profile="default",
            trace_archive_auth_mode="accessKey",
            trace_archive_endpoint="http://minio.telemetry.svc.cluster.local:9000",
            trace_archive_access_key=access_key,
            trace_archive_secret_key=secret_key,
        )


def test_production_refuses_disabled_platform_auth() -> None:
    with pytest.raises(ValidationError, match="PLATFORM_AUTH_REQUIRED"):
        _settings(platform_auth_required=False)


@pytest.mark.parametrize("authz_check_token", ["", "   "])
def test_production_refuses_missing_authz_check_token(authz_check_token: str) -> None:
    with pytest.raises(ValidationError, match="AUTHZ_CHECK_TOKEN"):
        _settings(authz_check_token=authz_check_token)


def test_production_refuses_enabled_archive_without_endpoint() -> None:
    with pytest.raises(ValidationError, match="TRACE_ARCHIVE_ENDPOINT"):
        _settings(
            trace_archive_enabled=True,
            trace_archive_profile="azure",
            trace_archive_endpoint="",
        )


def test_development_keeps_local_bootstrap_defaults() -> None:
    configured = Settings(
        _env_file=None,
        app_env="dev",
        database_url="postgresql+asyncpg://proofgrove:proofgrove@localhost:5432/proofgrove",
    )

    assert configured.database_url.endswith("@localhost:5432/proofgrove")
