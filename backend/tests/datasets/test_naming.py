"""Version stamping must not say the version twice."""

from evalhub.datasets.naming import dataset_version_label


def test_a_name_already_carrying_this_version_is_left_alone():
    # Datasets are routinely named with their version because a fork carries its
    # origin in its name. Appending the version again produced
    # "…_v11.v11", which then rode along on every run, experiment and report.
    assert dataset_version_label("Codex E2E Agent 20260814-151533_v11", 11) == "Codex E2E Agent 20260814-151533_v11"
    assert dataset_version_label("support-quality.v3", 3) == "support-quality.v3"


def test_a_name_without_a_version_is_stamped():
    assert dataset_version_label("support-quality", 3) == "support-quality.v3"
    assert dataset_version_label("support-quality", None) == "support-quality.v1"


def test_a_different_trailing_version_is_part_of_the_name_and_is_kept():
    # "legacy_v5" forked from v5 and is now on its own v7; both facts are real.
    assert dataset_version_label("legacy_v5", 7) == "legacy_v5.v7"


def test_case_and_whitespace():
    assert dataset_version_label("  support-quality_V4  ", 4) == "support-quality_V4"
