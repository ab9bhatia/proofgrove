"""Direct row ingestion cannot claim an attestation it did not witness."""

from evalhub.evaluation.models import EvaluationRow, ProvenanceStatus
from tests.conftest import act_as


def _experiment(client, tenant="tenant-a"):
    # Create/rows now require the caller to be authorized for the body's
    # tenant, so present that identity before either call.
    act_as(client, tenant)
    response = client.post(
        "/evaluation/experiments",
        json={
            "tenant_id": tenant,
            "name": "ingestion guard",
            "dataset_version": "d.v1",
            "target_endpoint": "ignored-by-this-test",
            "scenario": "llm_core",
        },
    )
    assert response.status_code in (200, 201), response.text
    return response.json()["experiment_id"]


def test_posted_rows_cannot_assert_execution_attestation(client):
    """The engine reads these fields to decide that no tool call occurred.

    A caller that never ran the agent can still POST a row, so the attestation
    has to come from execution rather than from the request body. Anything else
    lets a caller talk the engine into treating absent evidence as proof of
    absence.
    """
    experiment_id = _experiment(client)
    posted = client.post(
        f"/evaluation/experiments/{experiment_id}/rows",
        json=[
            {
                "row_id": "row-1",
                "query": "what is the balance",
                "response": "8200.20 AED",
                "tool_evidence_completion_attested": True,
                "tool_evidence_provenance_status": ProvenanceStatus.ATTESTED.value,
                "tool_evidence_source": "definitely-real",
                "from_agent": True,
                "trace_completion_attested": True,
                "lifecycle_completion_attested": True,
                "model_usage_completion_attested": True,
            }
        ],
    )
    assert posted.status_code == 201, posted.text

    stored = client.get(f"/evaluation/experiments/{experiment_id}/rows")
    assert stored.status_code == 200, stored.text
    row = stored.json()[0]

    assert row["tool_evidence_completion_attested"] is False
    assert row["tool_evidence_provenance_status"] == ProvenanceStatus.UNAVAILABLE.value
    assert row["tool_evidence_source"] is None
    assert row["from_agent"] is False
    assert row["trace_completion_attested"] is False
    assert row["lifecycle_completion_attested"] is False
    assert row["model_usage_completion_attested"] is False
    # The row itself still lands — the guard strips a claim, it does not refuse.
    assert row["query"] == "what is the balance"


def test_defaults_cover_every_attested_field():
    """If a new attestation field appears, this catches it not being covered."""
    from evalhub.api.v1.evaluation import _EXECUTION_ATTESTED_FIELDS

    for field in _EXECUTION_ATTESTED_FIELDS:
        assert field in EvaluationRow.model_fields
