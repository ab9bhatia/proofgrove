"""GET /platform/findings — tenant scope from query or gateway header."""

from proofgrove.settings import settings
from tests.conftest import act_as


def test_list_findings_accepts_gateway_tenant_header_without_query(client):
    response = client.get("/platform/findings", headers={"x-evalai-tenant": "evalai"})
    assert response.status_code == 200
    assert response.json() == []


def test_list_findings_accepts_explicit_tenant_query(client):
    act_as(client, "tenant-evalai")
    response = client.get("/platform/findings", params={"tenant_id": "tenant-evalai"})
    assert response.status_code == 200
    assert response.json() == []


def test_list_findings_rejects_missing_tenant_when_unscoped(client, monkeypatch):
    monkeypatch.setattr(settings, "pod_namespace", "")
    response = client.get("/platform/findings")
    assert response.status_code == 400
    assert response.json()["detail"] == "tenant_id is required"


def test_list_findings_bounds_the_page_size(client):
    """The read is bounded, and the bound is validated rather than coerced.

    A run whose average passes can still queue one finding per failing row, so
    this list has no natural ceiling; an unbounded read returned every finding a
    tenant had ever accumulated in one response.
    """
    act_as(client, "tenant-evalai")
    assert client.get("/platform/findings", params={"limit": 0}).status_code == 422
    assert client.get("/platform/findings", params={"limit": 501}).status_code == 422
    assert client.get("/platform/findings", params={"limit": "many"}).status_code == 422
    assert client.get("/platform/findings", params={"limit": 500}).status_code == 200
