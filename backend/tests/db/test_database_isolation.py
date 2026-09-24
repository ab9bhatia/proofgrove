"""Every test runs against its own database.

A session-wide ``sqlite+aiosqlite:///:memory:`` let committed rows leak between
tests and let the lifespan run worker share one ``StaticPool`` connection with
the request under test, which is how a row written moments earlier could read
back as ``None``. The two probes below are deliberately identical: whichever one
runs second would see the other's experiment if the databases were shared, so
neither depends on collection order.
"""

from tests.conftest import act_as

PROBE_ID = "exp-database-isolation-probe"
PROBE_TENANT = "tenant-database-isolation-probe"

PROBE_BODY = {
    "experiment_id": PROBE_ID,
    "name": "Database isolation probe",
    "dataset_version": "probe_v1",
    "target_endpoint": "tenant/probe",
    "scenario": "agentic",
    "tenant_id": PROBE_TENANT,
}


def _probe(client) -> None:
    # GET /experiments and POST /experiments now require/enforce a caller
    # tenant; present one so this probe still isolates the store rather than
    # the tenant guard.
    act_as(client, PROBE_TENANT)
    listed = client.get(f"/evaluation/experiments?tenant_id={PROBE_TENANT}")
    assert listed.status_code == 200, listed.text
    existing = {experiment["experiment_id"] for experiment in listed.json()}
    assert PROBE_ID not in existing, "another test's experiment leaked into this database"

    created = client.post("/evaluation/experiments", json=PROBE_BODY)
    assert created.status_code == 201, created.text


def test_database_is_isolated_per_test_first_probe(client):
    _probe(client)


def test_database_is_isolated_per_test_second_probe(client):
    _probe(client)
