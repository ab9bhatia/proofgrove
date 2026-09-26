"""Publish six local-agent golden datasets without invoking targets or models.

From backend/: uv run --no-sync python ../scripts/seed_working_agents.py
Existing user content is preserved. An interrupted, unchanged seed can resume.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(os.environ.get("PROOFGROVE_ROOT", Path(__file__).resolve().parents[1]))
FIXTURE_PATH = Path("samples/working-agents/golden-datasets.json")
CREATOR = "proofgrove-working-agents-v1"
PRODUCT = "proofgrove-working-agents"


def load_suites(root: Path = ROOT) -> list[dict]:
    """Reject response-bearing fixtures before any API mutation can happen."""
    fixture = json.loads((root / FIXTURE_PATH).read_text())
    suites = fixture["datasets"]
    if fixture.get("schema_version") != 1 or len(suites) != 6:
        raise ValueError("Expected the six version-1 working-agent golden datasets.")
    seen = set()
    for suite in suites:
        name = suite["dataset_name"]
        if name in seen or not suite["agent_ref"].startswith("local:"):
            raise ValueError(f"Invalid or duplicate local-agent dataset: {name}")
        seen.add(name)
        if not 3 <= len(suite["records"]) <= 5:
            raise ValueError(f"{name} must declare three to five focused cases.")
        for row in suite["records"]:
            if set(row) != {"inputs", "expectations", "tags"}:
                raise ValueError(f"Unexpected golden record fields in {name}.")
            if set(row["inputs"]) != {"question", "case_id"}:
                raise ValueError(f"{name}: golden inputs must contain only question and case_id.")
            if set(row["expectations"]) != {"expected_output", "expected_actions"}:
                raise ValueError(f"{name}: golden expectations must not contain actual responses or traces.")
            if set(row["tags"]) != {"agent_ref", "category", "source"}:
                raise ValueError(f"{name}: golden tags must contain only provenance and case classification.")
            values = [*row["inputs"].values(), *row["expectations"].values(), *row["tags"].values()]
            if not all(isinstance(value, str) and value.strip() for value in values):
                raise ValueError(f"{name}: every fixture field must be a nonempty string.")
            if row["tags"]["agent_ref"] != suite["agent_ref"]:
                raise ValueError(f"{name}: record targets the wrong agent.")
    return suites


def signature(rows: list[dict]) -> list[str]:
    """Ignore storage IDs and timestamps; compare all authored case content."""
    return sorted(json.dumps({key: row.get(key, {}) for key in ("inputs", "expectations", "tags")}, sort_keys=True) for row in rows)


def _request(client, method: str, path: str, **kwargs):
    response = client.request(method, path, **kwargs)
    if response.status_code >= 400:
        raise RuntimeError(f"{method} {path}: {response.status_code} {response.text[:1000]}")
    return response.json() if response.content else None


def ensure_dataset(client, tenant_id: str, suite: dict) -> str:
    name = suite["dataset_name"]
    desired = suite["records"]
    endpoint = f"/datasets/{name}"
    existing = client.get(endpoint, params={"tenant_id": tenant_id})
    if existing.status_code == 404:
        info = _request(client, "POST", "/datasets", json={
            "dataset_name": name, "tenant_id": tenant_id,
            "product_id": PRODUCT, "created_by": CREATOR,
        })
    else:
        existing.raise_for_status()
        info = existing.json()

    current = _request(client, "GET", endpoint + "/records", params={"tenant_id": tenant_id})
    owned = info.get("created_by") == CREATOR and info.get("product_id") == PRODUCT
    if owned and info["status"] == "DRAFT" and not current:
        _request(client, "POST", endpoint + "/records", json={"records": desired})
        current = _request(client, "GET", endpoint + "/records", params={"tenant_id": tenant_id})

    # Do not adopt, overwrite, validate or publish content the user changed.
    if not owned or signature(current) != signature(desired):
        print(f"Preserving user-managed {name}; choose its published version when evaluating.")
        return "preserved"

    status = info["status"]
    if status == "DRAFT":
        validation = _request(client, "POST", endpoint + "/validate")
        if not validation["passed"]:
            raise RuntimeError(f"Working-agent dataset {name} failed validation; no target was invoked.")
        status = "VALIDATED"
    if status == "VALIDATED":
        _request(client, "POST", endpoint + "/approve", json={"approved_by": CREATOR})
        status = "APPROVED"
    if status == "APPROVED":
        _request(client, "POST", endpoint + "/publish")
        status = "PUBLISHED"
    # Retired/archived suites are an intentional user lifecycle choice.
    print(f"{name}: {len(current)} cases, {status} → {suite['agent_ref']}")
    return status


def seed(client, tenant_id: str, suites: list[dict] | None = None) -> dict[str, str]:
    suites = load_suites() if suites is None else suites
    results = {suite["dataset_name"]: ensure_dataset(client, tenant_id, suite) for suite in suites}
    print("Working-agent golden datasets prepared. No model, agent or external tool was called.")
    return results


if __name__ == "__main__":
    from fastapi.testclient import TestClient
    from seed_demo import SLUG, TENANT, app

    with TestClient(app, headers={"x-evalai-tenant": SLUG, "x-evalai-sub": CREATOR}) as client:
        seed(client, TENANT)
