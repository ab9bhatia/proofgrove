"""Dataset naming helpers shared by every surface that stamps a version."""

import re

_TRAILING_VERSION = re.compile(r"[._]v(\d+)$", re.IGNORECASE)


def dataset_version_label(dataset_name: str, version_number: int | None) -> str:
    """Stamp a dataset name with its version without saying it twice.

    Datasets are routinely *named* with a version suffix — "support-quality_v11"
    — because a fork carries its origin in its name. Appending ".v11" to that
    produced "support-quality_v11.v11", which then rode along on every run,
    experiment and report that recorded the dataset.

    A trailing suffix that already names this version is left alone; one that
    names a different version is kept, because it is part of the name and the
    stamped version is a separate fact.
    """
    name = (dataset_name or "").strip()
    version = version_number if version_number is not None else 1
    match = _TRAILING_VERSION.search(name)
    if match and int(match.group(1)) == version:
        return name
    return f"{name}.v{version}"
