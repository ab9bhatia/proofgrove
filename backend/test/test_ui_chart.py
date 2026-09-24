"""The product chart owns the UI with the Proofgrove hostname and shared Eval Hub authorization identity."""

import subprocess
import unittest
from pathlib import Path

import yaml

CHART = Path(__file__).resolve().parents[1] / "chart"


class CombinedChartTest(unittest.TestCase):
    def test_existing_grant_identity_override(self):
        result = subprocess.run([
            "helm", "template", "tenant-alpha-eval-hub", str(CHART),
            "--namespace", "tenant-alpha", "--set", "route.enabled=true",
            "--set", "route.hostname=eval-hub.alpha.example.invalid",
            "--set", "authz.enabled=true", "--set", "authz.appName=eval-ai",
        ], check=True, capture_output=True, text=True)
        docs = [doc for doc in yaml.safe_load_all(result.stdout) if doc]
        for doc in docs:
            if doc["kind"] == "HTTPRoute":
                self.assertEqual(doc["metadata"]["labels"]["evalai.ai/application-id"], "eval-ai")
            if doc["kind"] == "Deployment" and doc["metadata"]["name"] == "eval-hub":
                env = {e["name"]: e.get("value") for e in doc["spec"]["template"]["spec"]["containers"][0]["env"]}
                self.assertEqual(env["AUTHZ_APP_NAME"], "eval-ai")

    def test_ui_contract(self):
        for tenant in ("alpha", "beta"):
            for public, rum, endpoint in (
                (False, False, ""), (True, True, ""),
                (True, True, "http://collector:4318"),
            ):
                with self.subTest(tenant=tenant, public=public, rum=rum, endpoint=endpoint):
                    namespace = f"tenant-{tenant}"
                    name = f"{namespace}-eval-ai"
                    args = [
                        "helm", "template", f"{namespace}-eval-hub", str(CHART),
                        "--namespace", namespace,
                        "--set", f"route.hostname=eval-hub.{tenant}.example.invalid",
                        "--set", "route.enabled=true",
                        "--set", f"route.publicEdge={str(public).lower()}",
                        "--set", f"ui.rum.enabled={str(rum).lower()}",
                        "--set", f"ui.rum.collectorEndpoint={endpoint}",
                        "--set", "rateLimit.enabled=true",
                        "--set", "authz.enabled=true",
                    ]
                    result = subprocess.run(args, check=True, capture_output=True, text=True)
                    docs = [doc for doc in yaml.safe_load_all(result.stdout) if doc]
                    resources = {(d["kind"], d["metadata"]["name"]): d for d in docs}
                    self.assertEqual(len(resources), len(docs), "duplicate resource names")
                    api = resources["Deployment", "eval-hub"]
                    api_env = {e["name"]: e.get("value") for e in api["spec"]["template"]["spec"]["containers"][0]["env"]}
                    self.assertEqual(api_env["AUTHZ_APP_NAME"], "eval-hub")
                    self.assertEqual(api_env["PLATFORM_AUTH_REQUIRED"], "true")
                    for (kind, _), resource in resources.items():
                        if kind == "HTTPRoute":
                            self.assertEqual(resource["metadata"]["labels"]["evalai.ai/application-id"], "eval-hub")
                    ui = resources["Deployment", name]
                    self.assertEqual(ui["metadata"]["namespace"], namespace)
                    selectors = ui["spec"]["selector"]["matchLabels"]
                    self.assertEqual(selectors, {
                        "app.kubernetes.io/name": "eval-ai",
                        "app.kubernetes.io/instance": name,
                    })
                    self.assertEqual(resources["Service", name]["spec"]["selector"], selectors)
                    container = ui["spec"]["template"]["spec"]["containers"][0]
                    env = {e["name"]: e for e in container["env"]}
                    self.assertEqual(env["EVAL_HUB_API_URL"]["value"], "http://eval-hub:8000")
                    self.assertEqual("evalai_RUM_ENABLED" in env, rum and bool(endpoint))
                    self.assertFalse(container["securityContext"]["allowPrivilegeEscalation"])
                    route = resources["HTTPRoute", name + "-httproute"]
                    self.assertEqual(route["spec"]["hostnames"], [f"eval-ai.{tenant}.example.invalid"])
                    self.assertEqual(route["metadata"]["labels"]["evalai.ai/application-id"], "eval-hub")
                    self.assertEqual(route["spec"]["rules"][0]["backendRefs"][0]["name"], name)
                    redirect = resources["HTTPRoute", name + "-redirect"]["spec"]["rules"][0]
                    if public:
                        self.assertEqual(redirect["backendRefs"][0]["name"], name)
                        self.assertEqual(redirect["filters"][0]["requestHeaderModifier"]["remove"], ["Cookie"])
                    else:
                        self.assertEqual(redirect["filters"][0]["requestRedirect"]["scheme"], "https")
                    targets = resources["BackendTrafficPolicy", "eval-hub-rate-limit"]["spec"]["targetRefs"]
                    self.assertIn(name + "-httproute", [t["name"] for t in targets])
                    ingress = resources["NetworkPolicy", "allow-eval-hub-ui-to-eval-hub"]["spec"]["ingress"][0]
                    self.assertEqual(ingress["from"], [{"podSelector": {"matchLabels": {"app.kubernetes.io/name": "eval-ai"}}}])
                    self.assertEqual(ingress["ports"], [{"port": 8000, "protocol": "TCP"}])


if __name__ == "__main__":
    unittest.main()
