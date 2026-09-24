"""Managed Postgres credentials stay tenant-bound when capture is disabled."""

import subprocess
from pathlib import Path

import pytest
import yaml

CHART = Path(__file__).resolve().parents[1] / "chart"


def render(tenant="alpha", **overrides):
    values = {
        "route.hostname": f"eval-hub.{tenant}.example.invalid",
        "telemetry.enabled": "false",
        "traceArchive.enabled": "false",
        "traceArchive.profile": "azure",
        "evalaiEgress.privateEndpointCidr": "192.0.2.0/24",
        "appInfra.tenantNamespace": f"tenant-{tenant}",
        "appInfra.keyvaultUrl": f"https://{tenant}.vault.azure.net",
        "appInfra.azureTenantId": "00000000-0000-0000-0000-000000000001",
        "appInfra.workloadIdentityClientId": "00000000-0000-0000-0000-000000000002",
        "appInfra.adminSecretsClientId": "00000000-0000-0000-0000-000000000003",
        # Shared-store mappings must never win on managed Postgres.
        "secrets.remoteKey": "wrong-shared-app",
        "secrets.adminRemoteKey": "wrong-shared-admin",
    } | overrides
    args = ["helm", "template", "eval-hub", str(CHART), "--namespace", f"tenant-{tenant}"]
    for key, value in values.items():
        args.extend(["--set", f"{key}={value}"])
    return subprocess.run(args, capture_output=True, text=True)


@pytest.mark.parametrize("tenant", ["alpha", "beta"])
@pytest.mark.parametrize("profile,host", [("azure", ""), ("default", "db.postgres.database.azure.com")])
def test_managed_postgres_uses_tenant_stores_without_capture(tenant, profile, host):
    result = render(tenant, **{"traceArchive.profile": profile, "appInfra.postgresHost": host})
    assert result.returncode == 0, result.stderr
    docs = [d for d in yaml.safe_load_all(result.stdout) if d]
    resources = {(d["kind"], d["metadata"]["name"]): d for d in docs}
    for suffix, store_name, account, client in (
        ("", "eval-hub-app-infra", "eval-hub", "00000000-0000-0000-0000-000000000002"),
        ("-admin", "eval-hub-admin-infra", "eval-hub-admin-secrets", "00000000-0000-0000-0000-000000000003"),
    ):
        secret = resources["ExternalSecret", f"eval-hub-postgres{suffix}-credentials"]["spec"]
        assert secret["secretStoreRef"] == {"name": store_name, "kind": "SecretStore"}
        assert secret["dataFrom"][0]["extract"]["key"] == f"eval-hub-postgres{suffix}"
        store = resources["SecretStore", store_name]["spec"]["provider"]["azurekv"]
        assert store["vaultUrl"] == f"https://{tenant}.vault.azure.net"
        assert store["authType"] == "WorkloadIdentity"
        assert store["serviceAccountRef"] == {"name": account}
        assert resources["ServiceAccount", account]["metadata"]["annotations"]["azure.workload.identity/client-id"] == client
    assert {name for kind, name in resources if kind == "Deployment"} == {"eval-hub", f"tenant-{tenant}-eval-ai"}


@pytest.mark.parametrize("key,value,error", [
    ("appInfra.tenantNamespace", "tenant-foreign", "must belong to this tenant namespace"),
    ("appInfra.tenantNamespace", "", "requires appInfra.tenantNamespace"),
    ("appInfra.keyvaultUrl", "", "appInfra.keyvaultUrl is required"),
    ("appInfra.workloadIdentityClientId", "", "requires appInfra.workloadIdentityClientId"),
    ("appInfra.adminSecretsClientId", "", "appInfra.adminSecretsClientId is required"),
])
def test_managed_postgres_missing_or_foreign_identity_fails_closed(key, value, error):
    result = render(**{key: value})
    assert result.returncode != 0
    assert error in result.stderr


def test_local_postgres_keeps_explicit_vault_mapping():
    result = render(**{"traceArchive.profile": "default"})
    assert result.returncode == 0, result.stderr
    docs = [d for d in yaml.safe_load_all(result.stdout) if d]
    assert not any(d["kind"] == "SecretStore" for d in docs)
    secret = next(d for d in docs if d["kind"] == "ExternalSecret" and d["metadata"]["name"] == "eval-hub-postgres-credentials")
    assert secret["spec"]["secretStoreRef"] == {"name": "evalai-registry", "kind": "ClusterSecretStore"}
    assert secret["spec"]["dataFrom"][0]["extract"]["key"] == "wrong-shared-app"


def test_role_setup_serializes_privileges_and_removes_truncate():
    result = render()
    assert result.returncode == 0, result.stderr
    job = next(d for d in yaml.safe_load_all(result.stdout) if d and d["kind"] == "Job" and d["metadata"]["name"] == "eval-hub-postgres-role-setup")
    script = job["spec"]["template"]["spec"]["containers"][0]["command"][-1]
    sql = script.split("<<'SQL'\n", 1)[1].rsplit("\nSQL", 1)[0].strip()
    assert sql.startswith("BEGIN;\nSELECT pg_advisory_xact_lock(hashtext('eval-hub-schema-migration'));")
    assert sql.endswith("COMMIT;")
    assert 'REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM :"appuser";' in sql
    assert 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM :"appuser";' in sql
    assert all("TRUNCATE" not in line for line in sql.splitlines() if "GRANT" in line)


@pytest.mark.parametrize("tenant", ["alpha", "beta"])
def test_default_local_postgres_matches_tenant_bootstrap(tenant):
    result = subprocess.run([
        "helm", "template", "eval-hub", str(CHART), "--namespace", f"tenant-{tenant}",
        "-f", str(CHART / "values-local.yaml"),
        "--set", f"route.hostname=eval-hub.{tenant}.example.invalid",
    ], capture_output=True, text=True, check=True)
    docs = [d for d in yaml.safe_load_all(result.stdout) if d]
    secret = next(d for d in docs if d["kind"] == "ExternalSecret" and d["metadata"]["name"] == "eval-hub-postgres-credentials")
    assert secret["spec"]["dataFrom"][0]["extract"]["key"] == f"eval-hub-{tenant}-postgres"
    assert secret["spec"]["secretStoreRef"] == {"name": "evalai-registry", "kind": "ClusterSecretStore"}


def test_deploy_requires_platform_values_before_contacting_cluster(tmp_path, monkeypatch):
    import os

    touched = tmp_path / "kubectl-called"
    kubectl = tmp_path / "kubectl"
    kubectl.write_text(f"#!/bin/sh\ntouch '{touched}'\nexit 1\n")
    kubectl.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    result = subprocess.run([
        "make", "-f", str(CHART.parent / "Makefile"), "deploy-eval-hub",
        "TENANT=alpha", "ARGOCD_ENV=local",
    ], cwd=tmp_path, capture_output=True, text=True)
    assert result.returncode != 0
    assert "gitops/local/app-values/eval-hub.yaml is not available" in result.stdout
    assert not touched.exists()


@pytest.mark.parametrize("namespace", ["default", "tenant-"])
def test_default_local_postgres_requires_tenant_namespace(namespace):
    result = subprocess.run([
        "helm", "template", "eval-hub", str(CHART), "--namespace", namespace,
        "--set", "route.hostname=eval-hub.example.invalid",
    ], capture_output=True, text=True)
    assert result.returncode != 0
    assert "Default local Postgres credentials require" in result.stderr
