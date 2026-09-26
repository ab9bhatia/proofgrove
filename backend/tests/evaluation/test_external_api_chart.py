"""Public machine API stays disabled or authenticated and tenant-bound."""

import subprocess
from pathlib import Path

import pytest
import yaml

CHART = Path(__file__).resolve().parents[2] / "chart"


def _render(*values, namespace="tenant-evalai"):
    args = ["helm", "template", "proofgrove", str(CHART), "--namespace", namespace]
    for value in values:
        args.extend(["--set", value])
    return subprocess.run(args, capture_output=True, text=True, check=False)


def test_external_gateway_route_is_opt_in():
    result = _render()
    assert result.returncode == 0, result.stderr
    assert "name: proofgrove-external-api" not in result.stdout
    assert "EXTERNAL_AGENT_CREDENTIALS" not in result.stdout


@pytest.mark.parametrize("values,namespace,error", [
    (["externalApi.enabled=true"], "tenant-evalai", "authz.enabled"),
    (["externalApi.enabled=true", "authz.enabled=true", "secrets.remoteKey=eval/test"], "default", "tenant namespace"),
    (["externalApi.enabled=true", "authz.enabled=true"], "tenant-evalai", "hostname"),
])
def test_external_gateway_configuration_fails_closed(values, namespace, error):
    result = _render(*values, namespace=namespace)
    assert result.returncode != 0
    assert error in result.stderr


def test_external_gateway_binds_identity_and_uses_secret_references():
    result = _render(
        "externalApi.enabled=true", "authz.enabled=true",
        "externalApi.hostname=eval.example.com", "externalApi.subject=service:external-evaluator",
        "externalApi.secretRemoteKey=eval/evalai/api", "externalAgents.credentialSecretName=agent-connections",
        "externalAgents.egressCIDRs[0]=93.184.216.34/32",
    )
    assert result.returncode == 0, result.stderr
    docs = [doc for doc in yaml.safe_load_all(result.stdout) if doc]
    route = next(doc for doc in docs if doc["kind"] == "HTTPRoute" and doc["metadata"]["name"] == "proofgrove-external-api")
    assert route["spec"]["parentRefs"] == [{"name": "tenant-ai-gateway", "namespace": "tenant-evalai", "sectionName": "http"}]
    modifier = route["spec"]["rules"][0]["filters"][0]["requestHeaderModifier"]
    assert {item["name"]: item["value"] for item in modifier["set"]} == {
        "x-evalai-tenant": "evalai", "x-evalai-sub": "service:external-evaluator",
    }
    assert "x-evalai-subject" in modifier["remove"]
    policy = next(doc for doc in docs if doc["kind"] == "SecurityPolicy" and doc["metadata"]["name"] == "proofgrove-external-api")
    auth = policy["spec"]["apiKeyAuth"]
    assert auth["sanitize"] is True
    assert auth["extractFrom"] == [{"headers": ["x-proofgrove-api-key"]}]
    assert auth["credentialRefs"] == [{"name": "proofgrove-external-api-key"}]
    deployment = next(doc for doc in docs if doc["kind"] == "Deployment" and doc["metadata"]["name"] == "proofgrove")
    env = deployment["spec"]["template"]["spec"]["containers"][0]["env"]
    credentials = next(item for item in env if item["name"] == "EXTERNAL_AGENT_CREDENTIALS")
    assert credentials["valueFrom"]["secretKeyRef"] == {"name": "agent-connections", "key": "credentials"}
    netpol = next(doc for doc in docs if doc["kind"] == "NetworkPolicy" and doc["metadata"]["name"] == "allow-proofgrove-egress")
    assert {"to": [{"ipBlock": {"cidr": "93.184.216.34/32"}}], "ports": [{"port": 443, "protocol": "TCP"}]} in netpol["spec"]["egress"]


@pytest.mark.parametrize("namespace", ["tenant-alpha", "tenant-beta"])
def test_llm_gateway_is_tenant_scoped_without_shared_credentials(namespace):
    result = _render(namespace=namespace)
    assert result.returncode == 0, result.stderr
    docs = [doc for doc in yaml.safe_load_all(result.stdout) if doc]
    deployment = next(doc for doc in docs if doc["kind"] == "Deployment" and doc["metadata"]["name"] == "proofgrove")
    env = {item["name"]: item for item in deployment["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["OPENAI_BASE_URL"]["value"] == "http://tenant-ai-gateway:8080/v1"
    assert env["OPENAI_API_KEY"] == {"name": "OPENAI_API_KEY", "value": "tenant-gateway"}
    assert env["JUDGE_MODE"]["value"] == "llm"
    peers = [peer for doc in docs if doc["kind"] == "NetworkPolicy"
             for rule in doc["spec"].get("egress", []) for peer in rule.get("to", [])]
    gateways = [peer for peer in peers if "gateway.envoyproxy.io/owning-gateway-name" in peer.get("podSelector", {}).get("matchLabels", {})]
    assert gateways == [{
        "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "evalai-platform"}},
        "podSelector": {"matchLabels": {
            "gateway.envoyproxy.io/owning-gateway-name": "tenant-ai-gateway",
            "gateway.envoyproxy.io/owning-gateway-namespace": namespace,
        }},
    }]


def test_custom_judge_gateway_uses_explicit_required_secret():
    result = _render("judge.baseUrl=http://custom-gateway:8080/v1", "judge.apiKeySecretName=custom-key",
                     "aiGateway.name=custom-gateway", "aiGateway.gatewayNamespace=tenant-custom")
    assert result.returncode == 0, result.stderr
    docs = [doc for doc in yaml.safe_load_all(result.stdout) if doc]
    deployment = next(doc for doc in docs if doc["kind"] == "Deployment" and doc["metadata"]["name"] == "proofgrove")
    env = {item["name"]: item for item in deployment["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["OPENAI_BASE_URL"]["value"] == "http://custom-gateway:8080/v1"
    assert env["OPENAI_API_KEY"]["valueFrom"]["secretKeyRef"] == {"name": "custom-key", "key": "apiKey"}
    assert "gateway.envoyproxy.io/owning-gateway-name: custom-gateway" in result.stdout
    assert "gateway.envoyproxy.io/owning-gateway-namespace: tenant-custom" in result.stdout


@pytest.mark.parametrize("managed,migrations", [(True, True), (True, False), (False, True)])
def test_role_setup_can_reach_managed_postgres(managed, migrations):
    result = _render(
        f"appInfra.postgresHost={'review.postgres.database.azure.com' if managed else ''}",
        f"migrations.enabled={str(migrations).lower()}",
        "evalaiEgress.privateEndpointCidr=192.0.2.0/24",
        "appInfra.tenantNamespace=tenant-evalai",
        "appInfra.keyvaultUrl=https://review.vault.azure.net",
        "appInfra.azureTenantId=00000000-0000-0000-0000-000000000001",
        "appInfra.workloadIdentityClientId=00000000-0000-0000-0000-000000000002",
        "appInfra.adminSecretsClientId=00000000-0000-0000-0000-000000000003",
    )
    assert result.returncode == 0, result.stderr
    docs = [doc for doc in yaml.safe_load_all(result.stdout) if doc]
    jobs = [doc for doc in docs if doc["kind"] == "Job" and doc["metadata"]["name"] == "proofgrove-postgres-role-setup"]
    policies = [doc for doc in docs if doc["kind"] == "NetworkPolicy" and doc["metadata"]["name"] == "allow-proofgrove-role-setup-postgres"]
    assert bool(jobs) == bool(policies) == (managed and migrations)
    if jobs:
        labels = jobs[0]["spec"]["template"]["metadata"]["labels"]
        assert all(labels.get(key) == value for key, value in policies[0]["spec"]["podSelector"]["matchLabels"].items())
        assert policies[0]["spec"]["egress"] == [{"to": [{"ipBlock": {"cidr": "192.0.2.0/24"}}], "ports": [{"port": 5432, "protocol": "TCP"}]}]
        assert jobs[0]["metadata"]["annotations"]["argocd.argoproj.io/hook"] == "Sync"
        assert jobs[0]["metadata"]["annotations"]["argocd.argoproj.io/hook-delete-policy"] == "BeforeHookCreation"


def test_managed_postgres_requires_a_private_endpoint_subnet():
    result = _render(
        "appInfra.postgresHost=review.postgres.database.azure.com",
        "appInfra.tenantNamespace=tenant-evalai",
        "appInfra.keyvaultUrl=https://review.vault.azure.net",
        "appInfra.azureTenantId=00000000-0000-0000-0000-000000000001",
        "appInfra.workloadIdentityClientId=00000000-0000-0000-0000-000000000002",
        "appInfra.adminSecretsClientId=00000000-0000-0000-0000-000000000003",
    )
    assert result.returncode != 0
    assert "evalaiEgress.privateEndpointCidr is required" in result.stderr


@pytest.mark.parametrize("profile", ["default", "azure"])
def test_profile_networking_and_service_account_follow_evalai_conventions(profile):
    values = ["telemetry.enabled=true", "traceArchive.enabled=true", "route.hostname=eval.example.test", f"traceArchive.profile={profile}"]
    if profile == "azure":
        values += [
            "appEnv=prod", "authz.enabled=true",
            "evalaiEgress.privateEndpointCidr=192.0.2.0/24",
            "appInfra.tenantNamespace=tenant-evalai",
            "appInfra.postgresHost=review.postgres.database.azure.com",
            "appInfra.keyvaultUrl=https://review.vault.azure.net",
            "appInfra.adminSecretsClientId=00000000-0000-0000-0000-000000000004",
            "appInfra.azureTenantId=00000000-0000-0000-0000-000000000001",
            "appInfra.workloadIdentityClientId=00000000-0000-0000-0000-000000000002",
            "appInfra.traceArchiveWriterClientId=00000000-0000-0000-0000-000000000003",
            "appInfra.traceArchiveEndpoint=https://review.blob.core.windows.net",
            "appInfra.serviceBusNamespace=review.servicebus.windows.net",
            "appInfra.serviceBusQueue=traces",
            "telemetry.objectStore.authMode=workloadIdentity",
            "telemetry.sink.ingestAuthTokenSecretName=proofgrove-ingest-token",
        ]
    result = _render(*values)
    assert result.returncode == 0, result.stderr
    docs = [doc for doc in yaml.safe_load_all(result.stdout) if doc]
    assert not any(doc["metadata"]["name"] == "proofgrove-telemetry-profile" for doc in docs)
    account = next(doc for doc in docs if doc["kind"] == "ServiceAccount" and doc["metadata"]["name"] == "proofgrove")
    assert account["automountServiceAccountToken"] is False
    if profile == "azure":
        admin = next(doc for doc in docs if doc["kind"] == "ExternalSecret" and doc["metadata"]["name"] == "proofgrove-postgres-admin-credentials")
        assert admin["spec"]["secretStoreRef"] == {"name": "proofgrove-admin-infra", "kind": "SecretStore"}
        store = next(doc for doc in docs if doc["kind"] == "SecretStore" and doc["metadata"]["name"] == "proofgrove-admin-infra")
        assert store["spec"]["provider"]["azurekv"]["serviceAccountRef"]["name"] == "proofgrove-admin-secrets"
        assert account["metadata"]["annotations"]["azure.workload.identity/client-id"] == "00000000-0000-0000-0000-000000000002"
    if profile == "azure":
        from proofgrove.settings import Settings

        deployment = next(doc for doc in docs if doc["kind"] == "Deployment" and doc["metadata"]["name"] == "proofgrove")
        migration = deployment["spec"]["template"]["spec"]["initContainers"][0]
        env = {item["name"]: item for item in migration["env"]}
        assert env["DATABASE_URL"]["valueFrom"]["secretKeyRef"]["name"] == "proofgrove-postgres-admin-credentials"
        assert env["AUTHZ_CHECK_TOKEN"]["valueFrom"]["secretKeyRef"]
        Settings(_env_file=None, app_env=env["APP_ENV"]["value"],
                 platform_auth_required=env["PLATFORM_AUTH_REQUIRED"]["value"],
                 authz_check_token="synthetic-bootstrap-test",
                 database_url="postgresql://admin:injected@db.example:5432/proofgrove?sslmode=require")
    for name in ("proofgrove", "trace-archive-sink"):
        pod = next(doc for doc in docs if doc["kind"] == "Deployment" and doc["metadata"]["name"] == name)["spec"]["template"]
        assert (pod["metadata"]["labels"].get("evalai.ai/egress-internet") == "true") == (profile == "azure")
        if profile == "azure":
            assert pod["metadata"]["labels"]["azure.workload.identity/use"] == "true"
    for policy in [doc for doc in docs if doc["kind"] == "NetworkPolicy"]:
        for rule in policy["spec"].get("egress", []):
            assert rule.get("to"), policy["metadata"]["name"]
            for peer in rule["to"]:
                if "ipBlock" in peer:
                    assert profile == "azure"
                    assert peer["ipBlock"]["cidr"] == "192.0.2.0/24"
