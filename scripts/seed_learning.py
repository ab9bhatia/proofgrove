"""Add fictional StudyMate lessons through real Proofgrove API routes.

Run from backend/: uv run --no-sync python ../scripts/seed_learning.py
No model, retriever, calendar, or external service is called. Existing records
are left unchanged. The independent seed marker is data/learning-seed.json.
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlencode

from fastapi.testclient import TestClient

# Reuse only the local API wiring; the earlier seed's project/state are untouched.
from seed_demo import METRICS, SLUG, TENANT, app, request, wait_for_run

PROJECT = "studymate-learning"
STATE = Path("data/learning-seed.json")
SAMPLES = Path(__file__).resolve().parents[1] / "samples" / "learning"
DATASET_IDS = (
    "studymate_study_v1",
    "studymate_course_v1",
    "studymate_booking_v1",
)
LABELS = {
    "baseline": "StudyMate reference baseline — pipeline sanity",
    "provided": "StudyMate candidate — authored example answers",
}


def save_state(state):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(STATE)


def exists(client, path):
    response = client.get(path, params={"tenant_id": TENANT})
    if response.status_code == 404:
        return False
    response.raise_for_status()
    return True


def ensure_dataset(client, data):
    name = data["dataset_id"]
    response = client.get(f"/datasets/{name}")
    if response.status_code == 404:
        request(client, "POST", "/datasets", json={
            "dataset_name": name, "tenant_id": TENANT,
            "product_id": "fictional-studymate", "created_by": "synthetic-lesson-author",
        })
        request(client, "POST", f"/datasets/{name}/records", json={"records": data["records"]})
        validation = request(client, "POST", f"/datasets/{name}/validate")
        if not validation["passed"]:
            raise RuntimeError(f"StudyMate fixture failed validation: {validation}")
        request(client, "POST", f"/datasets/{name}/approve", json={"approved_by": "synthetic-fixture-reviewer"})
        request(client, "POST", f"/datasets/{name}/publish")
        return True
    response.raise_for_status()
    if response.json()["status"] != "PUBLISHED":
        print(f"Preserving existing {name}: it is not published; no runs added.", flush=True)
        return False
    return True


def existing_run(client, dataset_id, source):
    """Recover a completed fixture after a lost marker without making duplicates."""
    history = request(client, "GET", "/evaluation/run-history", params={
        "tenant_id": TENANT, "search": "StudyMate", "limit": 200,
    })
    return next((
        run["run_id"] for run in history["items"]
        if run["experiment"]["dataset_version"] == dataset_id
        and run.get("label") == LABELS[source]
        and run["status"] == "completed"
    ), None)


def seed(client):
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    projects = request(client, "GET", "/platform/projects")
    if not any(project["project_id"] == PROJECT for project in projects):
        request(client, "POST", "/platform/projects", json={
            "project_id": PROJECT, "tenant_id": TENANT,
            "name": "StudyMate · Fictional student assistant",
            "description": "Learn evaluation through a study helper, course-policy assistant and study-group booking agent. All examples are authored fixtures; no live systems are invoked.",
            "system_type": "application", "owner": "local-instructor",
            "tags": {"purpose": "interactive-lesson", "data": "fictional"},
        })

    for dataset_id in DATASET_IDS:
        data = json.loads((SAMPLES / f"{dataset_id}.json").read_text())
        if not ensure_dataset(client, data):
            continue
        saved = state.setdefault(dataset_id, {})
        run_ids = []
        for source, label in LABELS.items():
            run_id = saved.get(source)
            if not run_id or not exists(client, f"/evaluation/runs/{run_id}"):
                run_id = existing_run(client, dataset_id, source)
            if not run_id:
                result = request(client, "POST", f"/evaluation/runs/from-dataset/{dataset_id}", json={
                    "evaluation_name": data["name"], "label": label,
                    "labels": [label, "fictional-studymate", data["lesson"], "deterministic"],
                    "response_source": source, "active_metrics": METRICS,
                    "enable_llm_judge": False, "run_human_review": True,
                    "project_id": PROJECT,
                })
                run_id = result["run_id"]
            saved[source] = run_id
            save_state(state)
            run = wait_for_run(client, run_id)
            # This fixture must never silently become a semantic/mock evaluation.
            scored = [metric for metric in run["metric_results"] if metric["score"] is not None]
            if len(scored) != 12 or any(metric["executed_scorer"] != "deterministic" for metric in scored):
                raise RuntimeError(f"Unexpected scoring contract for StudyMate run {run_id}")
            run_ids.append(run_id)

        workspace_id = saved.get("experiment_id")
        if not workspace_id or not exists(client, f"/evaluation/experiments/{workspace_id}"):
            experiments = request(client, "GET", "/evaluation/experiments")
            workspace_id = next((
                experiment["experiment_id"] for experiment in experiments
                if experiment["name"] == data["name"]
                and experiment.get("tags", {}).get("source_baseline_run_id") == run_ids[0]
            ), None)
        if not workspace_id:
            workspace = request(client, "POST", "/evaluation/experiments/from-runs", json={
                "tenant_id": TENANT, "name": data["name"], "run_ids": run_ids,
                "baseline_run_id": run_ids[0], "owner": "local-instructor",
                "description": data["fictional_notice"] + " " + data["description"] + " The reference baseline scores each answer against itself; the candidate uses authored answers. These diagnostic scores do not establish release readiness.",
                "objective": "Explain a failure, name the evidence needed to verify it, and choose an evaluation beyond text overlap.",
            })
            workspace_id = workspace["experiment"]["experiment_id"]
        saved["experiment_id"] = workspace_id
        saved["compare_path"] = f"/evaluations/{workspace_id}/compare?" + urlencode({
            "baseline_run_id": run_ids[0], "candidate_run_id": run_ids[1],
        })
        save_state(state)
        # Verify that the server accepts the exact recorded comparison basis.
        request(client, "GET", f"/evaluation/experiments/{workspace_id}/compare", params={
            "tenant_id": TENANT, "base_run_id": run_ids[0], "candidate_run_id": run_ids[1],
        })
        print(f"{dataset_id}: 4 cases, 2 completed deterministic runs; {saved['compare_path']}", flush=True)

    print("Proofgrove StudyMate lessons ready. All policies, answers and tool payloads are fictional teaching fixtures.")
    return state


if __name__ == "__main__":
    STATE.parent.mkdir(parents=True, exist_ok=True)
    with TestClient(app, headers={"x-evalai-tenant": SLUG, "x-evalai-sub": "local-instructor"}) as client:
        seed(client)
