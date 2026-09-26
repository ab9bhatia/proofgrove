"""An unhandled dataset-route failure is logged by type, never by traceback.

A driver error's message embeds the statement and its bound parameters -- for
record writes that is the golden-row text itself -- and ``logger.exception``
put that message into shared operational logs even though the 500 body was
already sanitized.
"""

import logging

import pytest
from fastapi import HTTPException

from proofgrove.api.v1.datasets import _handle_error


def test_unhandled_route_error_logs_type_only(caplog):
    sentinel = "INSERT INTO golden_dataset_records ... ('customer-question-sentinel')"
    with caplog.at_level(logging.ERROR, logger="proofgrove"), pytest.raises(HTTPException) as raised:
        try:
            raise RuntimeError(sentinel)
        except RuntimeError as exc:
            _handle_error(exc)
    assert raised.value.status_code == 500
    assert "customer-question-sentinel" not in raised.value.detail
    records = [record for record in caplog.records if record.name == "proofgrove.api.v1.datasets"]
    assert records, "the failure must still be logged"
    for record in records:
        assert record.exc_info is None
        assert record.error_type == "RuntimeError"
        assert "customer-question-sentinel" not in str(vars(record))


@pytest.mark.parametrize("mode", ["inline", "upload"])
@pytest.mark.parametrize("expectation_count", [20, 21])
def test_csv_expectation_limit_returns_json_validation_error(client, monkeypatch, mode, expectation_count):
    from proofgrove.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", "")
    headers = {"x-evalai-tenant": "csv-validation"}
    metadata = {"dataset_name": "csv-limit", "tenant_id": "csv-validation", "product_id": "test"}
    csv = ",".join(["input_question", *[f"expect_{i}" for i in range(expectation_count)]]) + "\n"
    csv += ",".join(["question", *["answer" for _ in range(expectation_count)]]) + "\n"
    if mode == "inline":
        response = client.post("/datasets", headers=headers, json={**metadata, "csv_content": csv})
    else:
        created = client.post("/datasets", headers=headers, json=metadata)
        assert created.status_code == 201, created.text
        response = client.post("/datasets/csv-limit/upload-csv", headers=headers, files={"file": ("rows.csv", csv, "text/csv")})
    assert response.status_code == (422 if expectation_count == 21 else 201), response.text
    if expectation_count == 21:
        error = response.json()["detail"][0]
        assert error["loc"] == ["expectations"]
        assert error["type"] == "value_error"
        assert error["ctx"]["error"] == "Expectations must have at most 20 keys, got 21"
    dataset = client.get("/datasets/csv-limit", headers=headers)
    if expectation_count == 21 and mode == "inline":
        assert dataset.status_code == 404  # Invalid imports leave no dataset behind.
    else:
        assert dataset.status_code == 200
        assert dataset.json()["record_count"] == (0 if expectation_count == 21 else 1)
