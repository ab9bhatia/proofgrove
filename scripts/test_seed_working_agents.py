"""Exercise seeding through the real API in disposable SQLite storage.

Run from backend/: uv run --no-sync python ../scripts/test_seed_working_agents.py
No live workspace data, model provider or agent endpoint is accessed.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import tempfile
import unittest

from seed_working_agents import CREATOR, FIXTURE_PATH, PRODUCT, ROOT, ensure_dataset, load_suites, seed


class WorkingAgentSeedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="proofgrove-working-agents-")
        cls.environment = dict(os.environ)
        os.environ.update({
            "DATABASE_URL": f"sqlite+aiosqlite:///{Path(cls.directory.name) / 'test.db'}",
            "APP_ENV": "dev", "APP_LOG_LEVEL": "WARNING",
            "POD_NAMESPACE": "tenant-local-classroom", "PLATFORM_AUTH_REQUIRED": "false",
            "JUDGE_MODE": "mock", "JUDGE_USE_FRAMEWORKS": "false",
            "EVALUATION_RUNTIME": "local", "PROOFGROVE_MODE": "offline",
            "OPENAI_API_KEY": "", "AZURE_OPENAI_API_KEY": "",
            "TRACE_ARCHIVE_ENABLED": "false", "TRACE_INDEX_ENABLED": "false",
            "OTEL_SDK_DISABLED": "true",
        })
        from fastapi.testclient import TestClient
        from proofgrove.main import app

        cls.tenant = "tenant-local-classroom"
        cls.context = TestClient(app, headers={"x-evalai-tenant": "local-classroom", "x-evalai-sub": CREATOR})
        cls.client = cls.context.__enter__()
        cls.suites = load_suites(ROOT)

    @classmethod
    def tearDownClass(cls):
        cls.context.__exit__(None, None, None)
        os.environ.clear()
        os.environ.update(cls.environment)
        cls.directory.cleanup()

    def request(self, method, path, **kwargs):
        response = self.client.request(method, path, **kwargs)
        self.assertLess(response.status_code, 400, response.text)
        return response.json()

    def snapshot(self, name):
        return (
            self.request("GET", f"/datasets/{name}"),
            self.request("GET", f"/datasets/{name}/records"),
        )

    def copy_suite(self, suffix):
        suite = copy.deepcopy(self.suites[0])
        suite["dataset_name"] += "_" + suffix
        return suite

    def create(self, suite, *, creator=CREATOR, records=None):
        self.request("POST", "/datasets", json={
            "dataset_name": suite["dataset_name"], "tenant_id": self.tenant,
            "product_id": PRODUCT, "created_by": creator,
        })
        if records:
            self.request("POST", f"/datasets/{suite['dataset_name']}/records", json={"records": records})

    def test_publish_and_rerun_preserves_ids_content_and_lifecycle(self):
        results = seed(self.client, self.tenant, self.suites)
        self.assertEqual(set(results.values()), {"PUBLISHED"})
        before = {suite["dataset_name"]: self.snapshot(suite["dataset_name"]) for suite in self.suites}
        seed(self.client, self.tenant, self.suites)
        after = {name: self.snapshot(name) for name in before}
        self.assertEqual(after, before)
        listed = self.request("GET", "/datasets")
        names = [dataset["dataset_name"] for dataset in listed]
        for suite in self.suites:
            self.assertEqual(names.count(suite["dataset_name"]), 1)
            info, rows = after[suite["dataset_name"]]
            self.assertEqual(info["record_count"], 4)
            self.assertTrue(info["missing_provided_response"])
            self.assertTrue(all("response" not in row["inputs"] for row in rows))

    def test_foreign_and_modified_drafts_are_never_overwritten_or_published(self):
        for suffix, creator, edited in [("foreign", "user", False), ("edited", CREATOR, True)]:
            with self.subTest(suffix=suffix):
                suite = self.copy_suite(suffix)
                records = copy.deepcopy(suite["records"])
                if edited:
                    records[0]["expectations"]["expected_output"] = "The user's revised expectation."
                self.create(suite, creator=creator, records=records)
                before = self.snapshot(suite["dataset_name"])
                self.assertEqual(ensure_dataset(self.client, self.tenant, suite), "preserved")
                self.assertEqual(self.snapshot(suite["dataset_name"]), before)

    def test_interrupted_unchanged_seed_resumes_through_publication(self):
        for initial in ("empty", "DRAFT", "VALIDATED", "APPROVED"):
            with self.subTest(initial=initial):
                suite = self.copy_suite(initial.lower())
                self.create(suite, records=None if initial == "empty" else suite["records"])
                endpoint = f"/datasets/{suite['dataset_name']}"
                if initial in {"VALIDATED", "APPROVED"}:
                    self.request("POST", endpoint + "/validate")
                if initial == "APPROVED":
                    self.request("POST", endpoint + "/approve", json={"approved_by": CREATOR})
                self.assertEqual(ensure_dataset(self.client, self.tenant, suite), "PUBLISHED")
                self.assertEqual(self.snapshot(suite["dataset_name"])[0]["record_count"], 4)

    def test_partial_or_retired_suites_are_preserved(self):
        partial = self.copy_suite("partial")
        self.create(partial, records=partial["records"][:1])
        before = self.snapshot(partial["dataset_name"])
        self.assertEqual(ensure_dataset(self.client, self.tenant, partial), "preserved")
        self.assertEqual(self.snapshot(partial["dataset_name"]), before)
        retired = self.copy_suite("retired")
        ensure_dataset(self.client, self.tenant, retired)
        self.request("POST", f"/datasets/{retired['dataset_name']}/deprecate")
        self.request("POST", f"/datasets/{retired['dataset_name']}/retire")
        before = self.snapshot(retired["dataset_name"])
        self.assertEqual(ensure_dataset(self.client, self.tenant, retired), "RETIRED")
        self.assertEqual(self.snapshot(retired["dataset_name"]), before)

    def test_fixture_rejects_actual_responses_before_seeding(self):
        document = json.loads((ROOT / FIXTURE_PATH).read_text())
        document["datasets"][0]["records"][0]["inputs"]["response"] = "A fabricated actual answer."
        target_root = Path(self.directory.name) / "invalid-fixture"
        path = target_root / FIXTURE_PATH
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(document))
        with self.assertRaisesRegex(ValueError, "golden inputs"):
            load_suites(target_root)


if __name__ == "__main__":
    unittest.main(verbosity=2)
