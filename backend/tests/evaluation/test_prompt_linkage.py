"""A run must carry the prompt it was invoked with, all the way through.

The system prompt was once accepted, stored in job params and never read back,
so every run silently ran without it. These tests hold each link of that chain
separately, because a service-level test alone is what let it through.
"""

import pytest

from proofgrove.evaluation.lineage import hash_system_prompt
from proofgrove.evaluation.target.llm_runner import _build_chat_request


def test_the_prompt_reaches_the_model_as_a_system_message():
    request = _build_chat_request(
        model_id="gpt-4o-mini", query="What is the refund window?", system_prompt="Be terse."
    )

    roles = [message["role"] for message in request["messages"]]
    assert roles[0] == "system"
    assert request["messages"][0]["content"] == "Be terse."
    # The row's question stays the user turn; the prompt never absorbs it.
    assert request["messages"][-1]["content"] == "What is the refund window?"


def test_without_a_prompt_the_payload_is_unchanged():
    request = _build_chat_request(model_id="gpt-4o-mini", query="hello")
    assert [message["role"] for message in request["messages"]] == ["user"]


@pytest.mark.asyncio
@pytest.mark.parametrize("entry_point", ["polling", "durable"])
async def test_the_worker_forwards_the_prompt_from_job_params(monkeypatch, entry_point):
    """The link that was missing: params carried it, the worker dropped it.

    Driven through the real entry points rather than by reading the source, so
    a call site that exists but passes the wrong value still fails.
    """

    from proofgrove import runs_worker

    forwarded: dict[str, object] = {}

    async def _capture(**kwargs):
        forwarded.update(kwargs)

    class _Job:
        run_id = "run-prompted"
        kind = "eval"
        status = "pending"
        dataset_name = "ds"
        tenant_id = None
        response_source = "llm"
        agent = None
        row_count = None
        judge_model = None
        params = {
            "target_model": "gpt-4o-mini",
            "system_prompt": "Be terse.",
            "prompt_version_ref": "support@3",
        }

    class _Store:
        async def get_run_job(self, run_id):
            return _Job()

        async def claim_next_pending_job(self):
            return _Job()

        async def claim_run_job(self, run_id):
            return _Job()

        async def get_run(self, run_id):
            # No prior result: the first durable attempt executes.
            return None

        async def complete_run_job(self, run_id):
            return None

        async def fail_run_job(self, *args, **kwargs):
            return None

    monkeypatch.setattr(runs_worker, "execute_dataset_run", _capture)
    monkeypatch.setattr(runs_worker, "EvaluationStore", lambda session: _Store())
    monkeypatch.setattr(runs_worker, "get_evaluation_engine", object)

    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(runs_worker, "async_session", lambda: _Session())

    if entry_point == "polling":
        await runs_worker.process_one_job()
    else:
        await runs_worker.process_run_job("run-prompted")

    assert forwarded.get("system_prompt") == "Be terse."
    assert forwarded.get("prompt_version_ref") == "support@3"


@pytest.mark.parametrize(
    ("text", "expected_equal"),
    [("Be terse.", True), ("Be terse.\n", True), ("Be verbose.", False)],
)
def test_the_digest_ignores_surrounding_whitespace_only(text, expected_equal):
    baseline = hash_system_prompt("Be terse.")
    assert (hash_system_prompt(text) == baseline) is expected_equal


def test_no_prompt_digests_to_nothing():
    assert hash_system_prompt(None) is None
    assert hash_system_prompt("   ") is None


def test_a_prompt_changes_the_fingerprint_but_not_the_comparison_basis():
    """The whole feature rests on this pair being different.

    The comparison basis must ignore the prompt, or two variants could never be
    compared. The exact-repetition fingerprint must include it, or two variants
    look like the same run repeated.
    """

    from proofgrove.evaluation.enums import Scenario
    from proofgrove.evaluation.lineage import compute_experiment_version_id
    from proofgrove.evaluation.models import ExperimentDefinition

    experiment = ExperimentDefinition(
        name="prompt variants",
        dataset_version="dataset.v1",
        target_endpoint="llm-catalog:gpt-4o-mini",
        scenario=Scenario.LLM_CORE,
        judge_model="gpt-4o-mini",
    )
    metrics = ["quality.correctness"]

    terse = compute_experiment_version_id(
        experiment, metrics, target_prompt_hash=hash_system_prompt("Be terse.")
    )
    verbose = compute_experiment_version_id(
        experiment, metrics, target_prompt_hash=hash_system_prompt("Be verbose.")
    )
    none_at_all = compute_experiment_version_id(experiment, metrics)

    assert terse != verbose
    assert terse != none_at_all


@pytest.mark.asyncio
async def test_exact_rerun_replays_the_recorded_prompt():
    """`exact_rerun` promises the same run; the prompt is part of that.

    Drives the real contract function rather than asserting a model copy: the
    point is what the endpoint does with a source run, not what pydantic does.
    """

    from types import SimpleNamespace

    from proofgrove.api.v1.evaluation import DatasetRunRequest, _apply_exact_rerun_contract
    from proofgrove.evaluation.enums import EvaluationScope

    source = SimpleNamespace(
        experiment=SimpleNamespace(tenant_id="tenant-a"),
        lineage=SimpleNamespace(
            requested_evaluation_scope=EvaluationScope.FINAL_RESPONSE,
            resolved_evaluation_scope=EvaluationScope.FINAL_RESPONSE,
            evaluation_scope=EvaluationScope.FINAL_RESPONSE,
            selected_tool_ids=None,
            target_prompt_ref="support@3",
            target_prompt_hash="deadbeef",
            assignment_id="assignment-1",
            assignment_version="1.0.0",
        ),
    )

    class _Store:
        async def get_run(self, run_id):
            return source

    request = SimpleNamespace(headers={"x-evalai-tenant": "tenant-a"})

    replayed = await _apply_exact_rerun_contract(
        DatasetRunRequest(exact_rerun=True, source_run_id="run-1"), request, _Store()
    )

    assert replayed.prompt_version_ref == "support@3"
    # The governance the source ran under is replayed too, so an exact rerun of a
    # governed run is not silently ungoverned.
    assert replayed.assignment_id == "assignment-1"
    assert replayed.assignment_version == "1.0.0"
