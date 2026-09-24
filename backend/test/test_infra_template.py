"""Offline security/consumer contract checks for the compiled Bicep artifact.

Usage: python3 test/test_infra_template.py /path/to/compiled-template.json
These inspect ARM contracts; they do not claim to validate Azure deployment.
"""

import copy
import json
import sys
import unittest
from pathlib import Path

OUTPUTS = {
    "tenantNamespace", "traceArchiveProfile", "storageAccountName",
    "traceArchiveEndpoint", "traceArchiveBucket", "adminSecretsClientId",
    "workloadIdentityClientId", "traceArchiveWriterClientId", "serviceBusNamespace",
    "serviceBusQueue", "serviceAccountName", "keyvaultUrl", "azureTenantId",
    "postgresHost", "postgresDatabase",
}
CONTEXT = {
    "applicationId", "tenantName", "tenantNamespace", "environment", "instance",
    "aksOidcIssuerUrl", "privateEndpointSubnetId", "keyVaultPrivateDnsZoneId", "requiredTags",
}
SECURE_PARAMS = {"postgresAdminPassword", "postgresAppPassword", "otlpApiKey", "ingestToken"}
TEMPLATE = None


def validate(template):
    def check(condition, message):
        if not condition:
            raise ValueError(message)

    check(set(template["outputs"]) == OUTPUTS, "flat appInfra outputs changed")
    check(all(x["type"] == "string" for x in template["outputs"].values()), "outputs must be public strings")
    check(set(template["definitions"]["deploymentContextType"]["properties"]) == CONTEXT, "operator context changed")
    check(set(template["parameters"]) == {"deploymentContext", "naming", "credentials", "postgres", "serviceAccountName", "location"}, "unexpected public input")
    credential_vault = template["resources"]["credentialVault"]
    check(credential_vault.get("existing") is True, "bootstrap vault must already exist")
    check("scope" not in credential_vault, "bootstrap vault must stay in the tenant resource group")
    deployment = template["resources"]["infrastructure"]["properties"]
    inner = deployment["template"]
    r = inner["resources"]
    for name in SECURE_PARAMS:
        check(inner["parameters"][name]["type"].lower() == "securestring", "credentials must use secure parameters")
        check("defaultValue" not in inner["parameters"][name], "credentials must not be regenerated on release")
        check(set(deployment["parameters"][name]) == {"reference"}, "credentials must use ARM Key Vault references")
        check("parameters('credentials').keyVaultName" in deployment["parameters"][name]["reference"]["keyVault"]["id"], "unexpected credential source")
    check(set(inner["outputs"]["appInfra"]["value"]) == OUTPUTS, "private values in appInfra")
    for scope in (inner, template):
        output_text = json.dumps(scope["outputs"])
        check(not any(name in output_text for name in SECURE_PARAMS), "credentials leaked into outputs")
    check("newGuid(" not in json.dumps(inner), "credentials must remain stable")
    check("ingestTokenSecret" in deployment["parameters"]["ingestToken"]["reference"]["secretName"], "ingest token needs its own bootstrap secret")
    check("'ingest-token', parameters('ingestToken')" in r["otlpSecret"]["properties"]["value"], "internal ingest must not reuse the producer key")
    suffix = inner["variables"]["resourceNameSuffix"]
    check("parameters('deploymentContext').environment" in inner["variables"]["production"] and "'prod'" in inner["variables"]["production"], "production environment cannot opt out of resilience")
    check(all(part in suffix for part in ["subscription().subscriptionId", "resourceGroup().name", ".tenantName", ".applicationId", ".instance"]), "names must isolate tenant and instance")
    check(inner["variables"]["tags"].endswith("parameters('deploymentContext').requiredTags)]"), "required tags must win")
    for name in ("vault", "backupVault"):
        vault = r[name]["properties"]
        check(vault["publicNetworkAccess"] == "Disabled" and vault["enableRbacAuthorization"] is True, "vault must stay private and RBAC enabled")
        check(vault["enablePurgeProtection"] is True and vault["enableSoftDelete"] is True, "vault deletion protection required")
        check(vault["networkAcls"]["defaultAction"] == "Deny", "vault default deny required")
    check(r["backupVault"]["properties"]["softDeleteRetentionInDays"] == 90, "backup key retention changed")
    for key in ("encryptionKeys", "backupKey"):
        check(r[key]["properties"]["kty"] == "RSA" and r[key]["properties"]["keySize"] == 4096, "RSA-4096 CMKs required")
    check("vaults/keys" in r["encryptionGrants"]["scope"] and "vaults/keys" in r["backupGrant"]["scope"], "CMK grants must be key-scoped")
    workload_accounts = inner["variables"]["serviceAccounts"]
    check(workload_accounts == ["[parameters('serviceAccountName')]", "trace-archive-sink", "eval-hub-admin-secrets"], "workload subjects changed")
    check("tenantNamespace" in r["federation"]["properties"]["subject"], "federation must stay tenant scoped")
    for grant, secret, principal in [("appSecretReader", "eval-hub-postgres", 0), ("otlpSecretReader", "eval-hub-otlp", 0), ("adminSecretReader", "eval-hub-postgres-admin", 2)]:
        check("vaults/secrets" in r[grant]["scope"] and f"'{secret}'" in r[grant]["scope"], "runtime secret grant broadened")
        check(f"'workloads[{{0}}]', {principal}" in r[grant]["properties"]["principalId"], "admin and runtime identities must remain separate")
    check("namespaces/queues" in r["queueGrants"]["scope"] and "'workloads[{0}]', 1" in r["queueGrants"]["properties"]["principalId"], "queue access belongs to the sink only")
    check(set(inner["variables"]["queueRoles"]) == {"69a216fc-b8fb-44d8-bc22-1f3c2cd27a39", "4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0"}, "sink requires the Azure sender and receiver roles")
    check("blobServices/containers" in r["blobGrants"]["scope"], "archive grants must be container scoped")

    storage = r["storage"]["properties"]
    check(storage["publicNetworkAccess"] == "Disabled" and storage["allowSharedKeyAccess"] is False, "storage must be private and keyless")
    check(storage["supportsHttpsTrafficOnly"] is True and storage["minimumTlsVersion"] == "TLS1_2", "storage TLS policy changed")
    check(storage["allowBlobPublicAccess"] is False and storage["allowCrossTenantReplication"] is False and storage["allowedCopyScope"] == "AAD", "storage isolation changed")
    check(storage["encryption"]["keySource"] == "Microsoft.Keyvault" and storage["encryption"]["requireInfrastructureEncryption"] is True, "storage CMK required")
    check(r["container"]["properties"]["publicAccess"] == "None", "archive container must stay private")
    check(r["blobs"]["properties"]["isVersioningEnabled"] is True, "archive versioning required")
    actions = r["archiveLifecycle"]["properties"]["policy"]["rules"][0]["definition"]["actions"]
    check(actions == {"baseBlob": {"delete": {"daysAfterModificationGreaterThan": 90}}, "version": {"delete": {"daysAfterCreationGreaterThan": 90}}}, "90-day retention required")
    sb = r["serviceBus"]
    check(sb["sku"]["name"] == "Premium" and sb["properties"]["disableLocalAuth"] is True and sb["properties"]["publicNetworkAccess"] == "Disabled", "Service Bus must remain Premium, private and keyless")
    check(sb["properties"]["encryption"]["requireInfrastructureEncryption"] is True, "Service Bus double encryption required")
    queue = r["queue"]["properties"]
    check(queue["maxMessageSizeInKilobytes"] == 102400 and queue["maxSizeInMegabytes"] == 81920 and queue["lockDuration"] == "PT5M" and queue["maxDeliveryCount"] == 20, "sink queue capacity contract changed")
    pg = r["postgresServer"]["properties"]
    check(pg["network"]["publicNetworkAccess"] == "Disabled", "Postgres must stay private")
    check("AzureKeyVault" in pg["dataEncryption"] and "keyUriWithVersion" in pg["dataEncryption"], "versioned PostgreSQL CMK required")
    check("35, 7" in pg["backup"]["backupRetentionDays"] and "production" in pg["backup"]["geoRedundantBackup"], "production backup contract changed")
    check("GeneralPurpose" in r["postgresServer"]["sku"]["tier"], "production must use non-Burstable compute")
    prod = template["definitions"]["postgresType"]["discriminator"]["mapping"]["production"]["properties"]
    check("backupLocation" in prod and not prod["backupLocation"].get("nullable", False), "production needs an explicit paired region")
    check(set(prod["highAvailability"]["allowedValues"]) == {"SameZone", "ZoneRedundant"}, "production HA cannot be disabled")
    for name in ("privateEndpoints", "backupEndpoint"):
        params = r[name]["properties"]["parameters"]
        check(params["subnetId"]["value"] == "[parameters('deploymentContext').privateEndpointSubnetId]", "network scope must be operator owned")
    check("keyVaultPrivateDnsZoneId" in inner["variables"]["dnsZoneRoot"], "DNS scope must be operator owned")


class CompiledContractTests(unittest.TestCase):
    def setUp(self):
        if TEMPLATE is None:
            self.skipTest("Run this file directly with a compiled Bicep template")

    def test_compiled_contract(self):
        validate(TEMPLATE)

    def test_regressions_are_rejected(self):
        def resources(t):
            return t["resources"]["infrastructure"]["properties"]["template"]["resources"]

        mutations = {
            "public archive": lambda t: resources(t)["container"]["properties"].update(publicAccess="Blob"),
            "public database": lambda t: resources(t)["postgresServer"]["properties"]["network"].update(publicNetworkAccess="Enabled"),
            "storage keys": lambda t: resources(t)["storage"]["properties"].update(allowSharedKeyAccess=True),
            "vault-wide app grant": lambda t: resources(t)["appSecretReader"].update(scope="[resourceId('Microsoft.KeyVault/vaults', 'other')]"),
            "admin grant to API": lambda t: resources(t)["adminSecretReader"]["properties"].update(principalId="[reference(format('workloads[{0}]', 0)).principalId]"),
            "secret output": lambda t: t["outputs"].update(password={"type": "string", "value": "[parameters('postgresAdminPassword')]"}),
            "plaintext credential": lambda t: t["resources"]["infrastructure"]["properties"]["parameters"].update(otlpApiKey={"value": "unsafe"}),
            "producer key reused for ingest": lambda t: resources(t)["otlpSecret"]["properties"].update(value="[string(createObject('api-key', parameters('otlpApiKey'), 'ingest-token', parameters('otlpApiKey')))]"),
            "small queue": lambda t: resources(t)["queue"]["properties"].update(maxMessageSizeInKilobytes=1024),
            "disabled production HA": lambda t: t["definitions"]["postgresType"]["discriminator"]["mapping"]["production"]["properties"]["highAvailability"].update(allowedValues=["Disabled"]),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                candidate = copy.deepcopy(TEMPLATE)
                mutate(candidate)
                with self.assertRaises(ValueError):
                    validate(candidate)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: test_infra_template.py COMPILED_TEMPLATE.json")
    TEMPLATE = json.loads(Path(sys.argv.pop()).read_text())
    unittest.main()
