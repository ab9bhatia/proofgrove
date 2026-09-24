"""Run label normalization tests."""

from evalhub.api.v1.evaluation import DatasetRunRequest
from evalhub.evaluation.labels import MAX_RUN_LABEL_LENGTH


def test_dataset_run_request_normalizes_labels() -> None:
    over_length = "x" * (MAX_RUN_LABEL_LENGTH + 5)
    request = DatasetRunRequest(
        labels=[
            " alpha ",
            "",
            "beta",
            "alpha",
            over_length,
            "gamma",
            "delta",
            "epsilon",
            "zeta",
            "eta",
            "theta",
            "iota",
            "kappa",
        ]
    )

    assert request.labels == [
        "alpha",
        "beta",
        "x" * MAX_RUN_LABEL_LENGTH,
        "gamma",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta",
        "iota",
    ]
    assert request.label == "alpha"
    assert request.name == "alpha"


def test_dataset_run_request_promotes_legacy_label_to_labels() -> None:
    request = DatasetRunRequest(label=" legacy ")

    assert request.labels == ["legacy"]
    assert request.label == "legacy"
    assert request.name == "legacy"


def test_dataset_run_request_labels_are_authoritative_over_legacy_label() -> None:
    request = DatasetRunRequest(label="legacy", labels=[" canonical "])

    assert request.labels == ["canonical"]
    assert request.label == "canonical"
    assert request.name == "canonical"
