"""Idempotently seed the local classroom through the real Proofgrove HTTP routes.

Run from backend/: uv run --no-sync python ../scripts/seed_demo.py
Only synthetic teaching examples are used. No model or cloud service is called.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

os.environ.setdefault("APP_LOG_LEVEL", "WARNING")
os.environ.setdefault("JUDGE_MODE", "mock")

from fastapi.testclient import TestClient

from evalhub.main import app
from evalhub.settings import settings

TENANT = settings.pod_namespace or "local-classroom"
SLUG = TENANT.removeprefix("tenant-")
PROJECT = "proofgrove-classroom"
STATE = Path("data/classroom-seed.json")
METRICS = ["nlp.f1_score", "nlp.rouge", "nlp.bleu"]


def record(question, expected, response, topic, *, context=None, expected_docs=None, retrieved_docs=None, tools=None):
    inputs = {"question": question, "response": response}
    expectations = {"expected_output": expected}
    if context:
        inputs["context"] = context
    if expected_docs:
        expectations["expected_doc_ids"] = expected_docs
        inputs["retrieved_doc_ids"] = retrieved_docs or []
    if tools:
        expectations["expected_actions"] = tools
    return {"inputs": inputs, "expectations": expectations, "tags": {"topic": topic, "source": "synthetic-classroom", "split": "test"}}


DATASETS = {
    "proofgrove_llm_basics_v1": {
        "name": "LLM basics: expected answers versus supplied outputs",
        "records": [
            record("What is an evaluation dataset?", "A collection of test inputs and expected outputs.", "A collection of test inputs and expected outputs.", "correctness"),
            record("Why use a held-out test set?", "To measure performance on examples not used for tuning.", "To train the model on every available example.", "data-leakage"),
            record("What is a regression in AI quality?", "A change that makes previously passing examples fail.", "A change that makes previously passing examples fail.", "regression"),
            record("Does a high average score guarantee safety?", "No. Rare critical failures can be hidden by averages.", "Yes. A high average guarantees every answer is safe.", "safety"),
        ],
    },
    "proofgrove_rag_policies_v1": {
        "name": "RAG policy assistant: retrieval and answer checks",
        "records": [
            record("What is the refund window?", "Refunds are available within 30 days with a receipt.", "Refunds are available within 90 days without a receipt.", "hallucination", context=["Policy P1: Refunds are available within 30 days with a receipt."], expected_docs=["P1"], retrieved_docs=["P1"]),
            record("When is support available?", "Support is available Monday to Friday from 9 to 6.", "Support is available Monday to Friday from 9 to 6.", "grounded-answer", context=["Policy P2: Support is available Monday to Friday from 9 to 6."], expected_docs=["P2"], retrieved_docs=["P2"]),
            record("How can I reset my password?", "Select Forgot Password and follow the email reset link.", "Send your password to support by email.", "retrieval-miss", context=["Policy P2: Support is available Monday to Friday from 9 to 6."], expected_docs=["P3"], retrieved_docs=["P2"]),
            record("Can an annual subscription be cancelled?", "You can cancel renewal while access continues until term end.", "You can cancel renewal while access continues until term end.", "grounded-answer", context=["Policy P4: You can cancel renewal while access continues until term end."], expected_docs=["P4"], retrieved_docs=["P4"]),
        ],
    },
    "proofgrove_agent_tasks_v1": {
        "name": "Agent tasks: final answers and evidence boundaries",
        "records": [
            record("Find the invoice total for order 42.", "The invoice total for order 42 is 250 AED.", "The invoice total for order 42 is 250 AED.", "lookup", tools="invoice_lookup(order_id=42)"),
            record("Schedule the study group for Tuesday at 14:00.", "The study group is scheduled for Tuesday at 14:00.", "The study group is scheduled for Wednesday at 14:00.", "wrong-date", tools="calendar_create(day=Tuesday,time=14:00)"),
            record("Check availability before promising a laptop delivery.", "The laptop is out of stock. No delivery is promised.", "The laptop arrives tomorrow. Stock was not checked.", "missing-tool-evidence", tools="inventory_lookup(product=laptop)"),
            record("Summarize the latest sales report.", "The sales report shows revenue of 10000 AED.", "The sales report shows revenue of 10000 AED.", "summary", tools="document_search(query=sales)"),
        ],
    },
}


def request(client, method, path, **kwargs):
    if method == "GET":
        kwargs.setdefault("params", {"tenant_id": TENANT})
    response = client.request(method, path, **kwargs)
    if response.status_code >= 400:
        raise RuntimeError(f"{method} {path}: {response.status_code} {response.text[:1800]}")
    return response.json() if response.content else None


def ensure_dataset(client, name, data):
    response = client.get(f"/datasets/{name}")
    if response.status_code == 404:
        request(client, "POST", "/datasets", json={"dataset_name": name, "tenant_id": TENANT, "product_id": "proofgrove-classroom", "created_by": "local-instructor"})
        request(client, "POST", f"/datasets/{name}/records", json={"records": data["records"]})
        result = request(client, "POST", f"/datasets/{name}/validate")
        if not result["passed"]:
            raise RuntimeError(f"Classroom fixture did not pass validation: {result}")
        request(client, "POST", f"/datasets/{name}/approve", json={"approved_by": "classroom-demo-reviewer"})
        request(client, "POST", f"/datasets/{name}/publish")
    else:
        response.raise_for_status()


def wait_for_run(client, run_id):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        run = request(client, "GET", f"/evaluation/runs/{run_id}")
        if run["status"] in {"completed", "completed_with_partial_evidence"}:
            return run
        if run["status"] in {"failed", "blocked", "cancelled"}:
            raise RuntimeError(f"Classroom run {run_id} stopped: {json.dumps(run)[:2000]}")
        time.sleep(0.2)
    raise RuntimeError(f"Classroom run {run_id} did not complete within 90 seconds")


def seed(client):
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    # IDs are checked against the API; this marker never overrides user edits.
    projects = request(client, "GET", "/platform/projects", params={"tenant_id": TENANT})
    if not any(p["project_id"] == PROJECT for p in projects):
        request(client, "POST", "/platform/projects", json={"project_id": PROJECT, "tenant_id": TENANT, "name": "Proofgrove AI quality classroom", "description": "Synthetic teaching examples for evaluation design, datasets, metrics and evidence. No live model was invoked.", "system_type": "application", "owner": "local-instructor", "tags": {"purpose": "classroom", "data": "synthetic"}})

    targets = request(client, "GET", f"/platform/projects/{PROJECT}/target-versions")
    if not any(target["target_version_id"] == "classroom-policy-target-v1" for target in targets):
        request(client, "POST", f"/platform/projects/{PROJECT}/target-versions", json={"target_version_id": "classroom-policy-target-v1", "target_id": "classroom-policy-assistant", "project_id": PROJECT, "tenant_id": TENANT, "name": "Teaching target — endpoint not connected", "version": "1.0.0", "endpoint": "https://classroom.example.invalid/v1/chat", "target_type": "rag_system", "environment": "classroom", "configuration": {"scenario": "rag", "connected": False, "description": "Catalog metadata only. Replace with your own service to run a live target."}, "created_by": "classroom-demo-instructor"})

    policies = request(client, "GET", "/platform/gate-policies")
    if not any(policy["gate_policy_id"] == "classroom-release-policy" for policy in policies):
        request(client, "POST", "/platform/gate-policies", json={"gate_policy_id": "classroom-release-policy", "version": "1.0.0", "tenant_id": TENANT, "name": "Classroom release gate — draft", "description": "Draft teaching policy. Seeded diagnostic runs are not approved release evidence.", "review_required_for": ["warn", "fail"], "created_by": "classroom-demo-instructor"})

    prompts = request(client, "GET", "/platform/prompts", params={"tenant_id": TENANT})
    if not any(p["prompt_id"] == "classroom-rag-assistant" for p in prompts):
        for content in [
            "Answer the learner's question concisely.",
            "Answer only from supplied context. Cite the policy ID. If evidence is missing, say you do not know. Never invent a policy.",
        ]:
            request(client, "POST", "/platform/prompts", json={"tenant_id": TENANT, "prompt_id": "classroom-rag-assistant", "name": "Classroom policy assistant", "description": "Two teaching prompt versions; supplied-output runs do not invoke these prompts.", "content": content})
        request(client, "PUT", "/platform/prompts/classroom-rag-assistant/labels/classroom", json={"tenant_id": TENANT, "version": 2})

    profiles = request(client, "GET", "/platform/quality-profiles", params={"tenant_id": TENANT})
    if not any(p["profile_id"] == "classroom-answer-quality" for p in profiles):
        request(client, "POST", "/platform/quality-profiles", json={"profile_id": "classroom-answer-quality", "version": "1.0.0", "tenant_id": TENANT, "project_id": PROJECT, "name": "Classroom answer checks", "description": "Draft teaching contract. Text overlap is diagnostic and does not establish factual correctness, safety or release readiness.", "scenario": "llm_core", "metric_ids": METRICS, "created_by": "local-instructor"})

    for name, data in DATASETS.items():
        ensure_dataset(client, name, data)
        saved = state.setdefault(name, {})
        run_ids = []
        for source, label in [("baseline", "Reference baseline — pipeline sanity"), ("provided", "Candidate v1 — supplied outputs")]:
            run_id = saved.get(source)
            if not run_id or client.get(f"/evaluation/runs/{run_id}", params={"tenant_id": TENANT}).status_code == 404:
                metrics = METRICS + (["rag.document_recall"] if "rag" in name else [])
                result = request(client, "POST", f"/evaluation/runs/from-dataset/{name}", json={"evaluation_name": data["name"], "label": label, "labels": [label, "classroom", "deterministic"], "response_source": source, "active_metrics": metrics, "enable_llm_judge": False, "run_human_review": True, "project_id": PROJECT})
                run_id = result["run_id"]
                saved[source] = run_id
                STATE.write_text(json.dumps(state, indent=2) + "\n")
            run = wait_for_run(client, run_id)
            run_ids.append(run_id)
            print(f"{name}: {label}: {run['status']} ({run_id})", flush=True)
        workspace_id = saved.get("experiment_id")
        if not workspace_id or client.get(f"/evaluation/experiments/{workspace_id}", params={"tenant_id": TENANT}).status_code == 404:
            workspace = request(client, "POST", "/evaluation/experiments/from-runs", json={"tenant_id": TENANT, "name": data["name"], "run_ids": run_ids, "baseline_run_id": run_ids[0], "owner": "local-instructor", "description": "Reference baseline scores expected answers against themselves; candidate uses pre-written synthetic outputs. Deterministic overlap measures wording, not truth. Agent tool execution is not attested by these fixtures.", "objective": "Inspect per-case failures, compare recorded outputs and explain evidence limitations."})
            saved["experiment_id"] = workspace["experiment"]["experiment_id"]
        STATE.write_text(json.dumps(state, indent=2) + "\n")

        # Keep a real review case and regression example ready for the session.
        # Opening a case is idempotent in the service; no verdict is fabricated.
        candidate = request(client, "GET", f"/evaluation/runs/{saved['provided']}")
        scored = [m for m in candidate["metric_results"] if m["metric_id"] == "nlp.f1_score" and m["score"] is not None]
        case = min(scored, key=lambda metric: metric["score"])
        review = request(client, "POST", "/platform/review-cases", json={"run_id": saved["provided"], "row_id": case["row_id"], "metric_id": case["metric_id"]})
        finding_id = review["finding"]["finding_id"]
        comments = request(client, "GET", f"/platform/findings/{finding_id}/comments")
        if not any(comment["body"].startswith("Classroom exercise:") for comment in comments):
            request(client, "POST", f"/platform/findings/{finding_id}/comments", json={"author": "classroom-demo-instructor", "body": "Classroom exercise: inspect the question, reference and supplied answer. Explain whether low text overlap identifies a real defect. A metric score is evidence for review, not a human verdict."})
        if name == "proofgrove_rag_policies_v1":
            decisions = request(client, "GET", f"/platform/findings/{finding_id}/review-decisions")
            if not decisions:
                tasks = request(client, "GET", f"/platform/findings/{finding_id}/review-tasks")
                request(client, "POST", "/platform/review-decisions", json={"finding_id": finding_id, "task_id": tasks[0]["task_id"], "reviewer": "synthetic-classroom-reviewer", "outcome": "agree", "rationale": "Synthetic teaching review: the supplied password-reset answer contradicts the reference and asks the user to disclose a password. Preserve this case for regression testing.", "severity": "high", "root_cause_category": "incorrect_answer"})
                decisions = request(client, "GET", f"/platform/findings/{finding_id}/review-decisions")
            regressions = request(client, "GET", "/platform/regressions")
            current = next((decision for decision in decisions if decision.get("is_current")), {})
            if current.get("outcome") == "agree" and not any(item.get("finding_id") == finding_id for item in regressions):
                request(client, "POST", f"/platform/findings/{finding_id}/promote-regression", json={"created_by": "classroom-demo-instructor"})

    print("Proofgrove ready: 3 datasets, 6 deterministic runs, 3 experiments, 1 project, 2 prompt versions, a draft quality contract, 3 review cases and a regression example.")


if __name__ == "__main__":
    STATE.parent.mkdir(exist_ok=True)
    with TestClient(app, headers={"x-evalai-tenant": SLUG, "x-evalai-sub": "local-instructor"}) as client:
        seed(client)
