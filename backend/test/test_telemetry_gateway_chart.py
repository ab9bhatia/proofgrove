"""OTLP authentication uses the tenant vault on Azure and local bootstrap paths."""

import subprocess
from pathlib import Path

import pytest
import yaml

CHART = Path(__file__).resolve().parents[1] / "chart"


def render(tenant, profile, gateway_enabled=True):
    values = {
        "route": {"hostname": f"proofgrove.{tenant}.example.invalid"},
        "telemetry": {"enabled": True, "gateway": {"enabled": gateway_enabled}},
        "traceArchive": {"enabled": True, "profile": profile},
        "evalaiEgress": {"privateEndpointCidr": "192.0.2.0/24"},
        "secrets": {"storeKind": "ClusterSecretStore", "storeName": "local-vault"},
    }
    if profile == "azure":
        values["telemetry"]["sink"] = {"ingestAuthTokenSecretName": "proofgrove-ingest-token"}
        values["appInfra"] = {
            "tenantNamespace": f"tenant-{tenant}",
            "keyvaultUrl": f"https://{tenant}.vault.azure.net/",
            "azureTenantId": "00000000-0000-0000-0000-000000000001",
            "workloadIdentityClientId": "00000000-0000-0000-0000-000000000002",
            "adminSecretsClientId": "00000000-0000-0000-0000-000000000003",
            "traceArchiveWriterClientId": "00000000-0000-0000-0000-000000000004",
            "postgresHost": f"{tenant}.postgres.database.azure.com",
            "traceArchiveEndpoint": f"https://{tenant}.blob.core.windows.net/",
            "serviceBusNamespace": f"{tenant}.servicebus.windows.net",
            "serviceBusQueue": "proofgrove-trace-events",
        }
    result = subprocess.run(
        ["helm", "template", "proofgrove", str(CHART), "--namespace", f"tenant-{tenant}", "-f", "-"],
        input=yaml.safe_dump(values), capture_output=True, text=True, check=True,
    )
    return {(d["kind"], d["metadata"]["name"]): d for d in yaml.safe_load_all(result.stdout) if d}


@pytest.mark.parametrize("tenant", ["alpha", "beta"])
@pytest.mark.parametrize("profile", ["default", "azure"])
def test_otlp_credential_stays_tenant_bound(tenant, profile):
    resources = render(tenant, profile)
    secret = resources["ExternalSecret", "proofgrove-otlp-api-key"]
    assert secret["metadata"]["namespace"] == f"tenant-{tenant}"
    spec = secret["spec"]
    assert spec["target"]["name"] == "proofgrove-otlp-api-key"
    assert spec["target"]["deletionPolicy"] == "Retain"
    remote_key = f"proofgrove-{tenant}-otlp"
    if profile == "azure":
        assert spec["secretStoreRef"] == {"kind": "SecretStore", "name": "proofgrove-app-infra"}
        store = resources["SecretStore", "proofgrove-app-infra"]["spec"]["provider"]["azurekv"]
        assert store["vaultUrl"] == f"https://{tenant}.vault.azure.net/"
        assert store["serviceAccountRef"] == {"name": "proofgrove"}
        remote_key = "proofgrove-otlp"
    else:
        assert spec["secretStoreRef"] == {"kind": "ClusterSecretStore", "name": "local-vault"}
    assert spec["data"] == [{"secretKey": tenant, "remoteRef": {"key": remote_key, "property": "api-key"}}]
    auth = resources["SecurityPolicy", "proofgrove-otlp"]["spec"]["apiKeyAuth"]
    assert auth["credentialRefs"] == [{"name": "proofgrove-otlp-api-key"}]
    assert auth["extractFrom"] == [{"headers": ["x-otlp-api-key"]}]


def test_disabled_gateway_has_no_otlp_secret_or_policy():
    resources = render("alpha", "azure", gateway_enabled=False)
    assert ("ExternalSecret", "proofgrove-otlp-api-key") not in resources
    assert ("SecurityPolicy", "proofgrove-otlp") not in resources
