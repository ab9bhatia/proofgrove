from proofgrove.configs.app_config import (
    resolve_telemetry_profile,
)
from proofgrove.settings import Settings


def test_default_profile_keeps_minio_access_keys() -> None:
    settings = Settings()
    assert settings.trace_archive_profile == "default"
    assert settings.trace_archive_auth_mode == "accessKey"
    assert settings.trace_archive_force_path_style is True


def test_azure_profile_selects_blob_workload_identity() -> None:
    settings = Settings(trace_archive_profile="azure", trace_archive_auth_mode="accessKey")
    assert settings.trace_archive_profile == "azure"
    assert settings.trace_archive_auth_mode == "workloadIdentity"
    assert settings.trace_archive_force_path_style is False


def test_app_config_profile_alias() -> None:
    settings = Settings(app_config_profile="azure", trace_archive_profile="")
    assert settings.trace_archive_profile == "azure"
    assert settings.trace_archive_auth_mode == "workloadIdentity"




def test_unknown_profile_is_rejected() -> None:
    try:
        resolve_telemetry_profile("kafka")
    except ValueError as exc:
        assert "telemetry profile" in str(exc)
    else:
        raise AssertionError("expected ValueError")
