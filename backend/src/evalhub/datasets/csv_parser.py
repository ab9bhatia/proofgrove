"""CSV-to-record parser for dataset bulk ingestion.

Converts CSV files into ``DatasetRecord`` dicts.

Preferred Eval Hub columns:

    Serial No, Question, Expected Output, Metadata

``Metadata`` is one JSON object per row holding everything that is not the
question or the expected output — expected tool actions, retrieval context,
risk, domain, or anything else the row wants to carry. It is a presentation
mapping over the stored ``inputs`` / ``expectations`` / ``tags`` dicts (see
``metadata_to_record`` / ``record_metadata``), so an export can be edited and
re-uploaded without losing anything.

Legacy conventions remain supported:

    - ``input_*``  → ``inputs``
    - ``expect_*`` → ``expectations``
    - ``tag_*``    → ``tags``
    - shorthand RAG columns (question/context/domain/…)
    - the flat ``Risk`` / ``Context`` / ``Expected Actions`` columns the
      canonical schema used before ``Metadata``
"""

from __future__ import annotations

import csv
import io
import json
import logging
import re
from typing import Any

from evalhub.datasets.exceptions import DatasetValidationError
from evalhub.datasets.models import MAX_ROWS_PER_DATASET

logger = logging.getLogger(__name__)

# Canonical human-friendly CSV headers (case/spacing insensitive).
_CANONICAL_SERIAL = {"serial no", "serial_no", "serialno", "s.no", "sno", "#"}
_CANONICAL_QUESTION = {"question", "query", "input", "prompt"}
_CANONICAL_EXPECTED = {
    "expected output",
    "expected_output",
    "expected response",
    "expected_response",
    "expected answer",
    "expected_answer",
    "answer",
}
# The answer being evaluated, for a provided run — distinct from the expected
# output it is graded against. Without these, a `Response` column landed in
# `inputs["Response"]` verbatim and `_provided_response` (which reads the exact
# lowercase key) saw nothing, so the most natural CSV for existing-responses
# uploaded fine and was then refused as carrying no stored answers. Bare
# "output" is deliberately absent: it reads as the expected one just as often.
_CANONICAL_RESPONSE = {
    "response",
    "actual output",
    "actual_output",
    "actual response",
    "actual_response",
    "model output",
    "model_output",
}
_CANONICAL_RISK = {"risk"}
_CANONICAL_CONTEXT = {"context"}
# ``dataset_bridge._EXPECTED_ACTION_KEYS`` reads these; ``expected_actions`` is
# the key it probes first, so that is what we store.
_CANONICAL_ACTIONS = {"expected actions", "expected tool calls", "actions"}
_CANONICAL_METADATA = {"metadata"}

# Where a metadata key is stored so the scorers keep reading where they read
# today. ``record_metadata`` is the exact inverse, which is what makes
# download → edit → re-upload lossless.
_METADATA_EXPECTATION_KEYS = frozenset({"expected_actions", "expected_tool_calls", "actions"})
_METADATA_TAG_KEYS = frozenset({"risk", "domain", "category", "source"})
# The two columns of their own; never repeated inside the metadata blob.
_PRESENTED_INPUT_KEYS = frozenset({"question", "query"})
_PRESENTED_EXPECTATION_KEYS = frozenset({"expected_output", "expected_response"})
_PRESENTED_TAG_KEYS = frozenset({"serial_no"})

# Legacy shorthand when no prefixed headers and no canonical set.
_SHORTHAND_INPUT_COLS = {"question", "context", "query", "input"}
_SHORTHAND_TAG_COLS = {"domain", "category", "source", "risk"}


# Spreadsheet-safe exports prefix formula-trigger cells with an apostrophe (see
# the UI's ``neutralizeCsvFormula``). A cell that ALREADY reads as guarded is
# exported with one more apostrophe, so a user's own "' =SUM(A1:A2)" cannot be
# mistaken for the guard written for " =SUM(A1:A2)". Removing exactly one
# apostrophe from a guard-like cell therefore inverts the exporter for both
# cases; a leading apostrophe outside the encoding ("O'Brien", "'quoted'",
# "'tis") is never touched.
_FORMULA_GUARD_RE = re.compile(r"^'(?='*(?:[\t\r\n]|[ ]*[=+\-@]))")


def _strip_formula_guard(value: str) -> str:
    return _FORMULA_GUARD_RE.sub("", value, count=1)


def metadata_to_record(
    metadata: dict[str, Any],
    inputs: dict[str, Any],
    expectations: dict[str, Any],
    tags: dict[str, str],
) -> None:
    """Route one row's metadata blob into the dicts the scorers read."""
    for key, value in metadata.items():
        if key in _METADATA_EXPECTATION_KEYS:
            expectations[key] = value
        elif key in _METADATA_TAG_KEYS:
            tags[key] = str(value)
        else:
            inputs[key] = value


def record_metadata(record: dict[str, Any]) -> dict[str, Any]:
    """The metadata blob for a stored record — everything but the two columns.

    The inverse of :func:`metadata_to_record`, so a downloaded row survives a
    round trip through the spreadsheet it was edited in.
    """
    metadata: dict[str, Any] = {}
    for source, presented in (
        (record.get("inputs"), _PRESENTED_INPUT_KEYS),
        (record.get("expectations"), _PRESENTED_EXPECTATION_KEYS),
        (record.get("tags"), _PRESENTED_TAG_KEYS),
    ):
        for key, value in (source or {}).items():
            if key not in presented:
                metadata[key] = value
    return metadata


def _parse_metadata_cell(cell: str, index: int) -> dict[str, Any]:
    """Parse the ``Metadata`` cell of one row into a dict (empty when blank)."""
    text = cell.strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except ValueError as exc:
        raise DatasetValidationError(
            f"Row {index}: Metadata is not valid JSON ({exc})."
        ) from exc
    if not isinstance(parsed, dict):
        raise DatasetValidationError(
            f"Row {index}: Metadata must be a JSON object, got {type(parsed).__name__}."
        )
    return parsed


def _normalize_header(col: str) -> str:
    cleaned = col.strip().lower().replace("-", " ").replace("_", " ")
    return re.sub(r"\s+", " ", cleaned)


def parse_csv(content: str | bytes) -> list[dict[str, Any]]:
    """Parse CSV content into record dicts.

    Parameters
    ----------
    content : str or bytes
        Raw CSV text (UTF-8).

    Returns
    -------
    list[dict]
        Records with ``inputs``, ``expectations``, ``tags`` keys.

    Raises
    ------
    DatasetValidationError
        If the CSV is empty, has no data rows, or exceeds the row limit.
    """
    if isinstance(content, bytes):
        # utf-8-sig strips a leading BOM if present and is a no-op otherwise --
        # covers the common "exported from Excel" case where plain utf-8 would
        # leave the BOM glued to the first header (e.g. "﻿Serial No"),
        # which then fails every canonical/shorthand header match.
        content = content.decode("utf-8-sig")
    else:
        content = content.removeprefix("﻿")

    reader = csv.DictReader(io.StringIO(content))
    if reader.fieldnames is None:
        raise DatasetValidationError("CSV has no header row")

    columns = [c.strip() for c in reader.fieldnames if c is not None]
    normalized = {_normalize_header(c) for c in columns}
    use_prefix = any(c.startswith(("input_", "expect_", "tag_")) for c in columns)
    use_canonical = bool(
        normalized
        & (
            _CANONICAL_QUESTION
            | _CANONICAL_EXPECTED
            | _CANONICAL_RESPONSE
            | _CANONICAL_SERIAL
            | _CANONICAL_RISK
            | _CANONICAL_METADATA
        )
    ) and not use_prefix

    rows = list(reader)
    if not rows:
        raise DatasetValidationError("CSV has no data rows")

    if not use_prefix and not use_canonical and not (normalized & _SHORTHAND_INPUT_COLS):
        raise DatasetValidationError("CSV columns are not recognised. Include Question or input_question.")

    if len(rows) > MAX_ROWS_PER_DATASET:
        raise DatasetValidationError(
            f"CSV has {len(rows)} rows, max allowed is {MAX_ROWS_PER_DATASET}"
        )

    records: list[dict[str, Any]] = []
    for index, row in enumerate(rows, start=1):
        if use_prefix:
            record = _parse_prefixed_row(row)
        elif use_canonical:
            record = _parse_canonical_row(row, index)
        else:
            record = _parse_shorthand_row(row)
        records.append(record)

    _require_questions(records)

    logger.info(
        "Parsed %d records from CSV (%s mode, columns=%s)",
        len(records),
        "prefix" if use_prefix else "canonical" if use_canonical else "shorthand",
        columns,
    )
    return records


# The input keys ``dataset_bridge.record_to_row`` probes for the question, in
# its order. Kept as a literal here (not imported) because the bridge already
# imports this package and the two must not form a cycle.
_QUESTION_INPUT_KEYS = ("question", "query", "prompt", "input")


def _question_text(record: dict[str, Any]) -> str:
    """The question execution will ask, judged the way the bridge selects it.

    ``dataset_bridge._first`` takes the first *truthy* value in key order and
    never looks further, so a whitespace-only ``question`` hides a real
    ``query``. Selecting the same value here — then requiring it to carry
    non-whitespace text — means the parser refuses exactly the rows the bridge
    would execute with a blank query, no more and no less.
    """
    inputs = record.get("inputs") or {}
    selected = next((inputs[key] for key in _QUESTION_INPUT_KEYS if inputs.get(key)), "")
    return selected if isinstance(selected, str) and selected.strip() else ""


def _require_questions(records: list[dict[str, Any]]) -> None:
    """Reject a parse whose rows carry no usable question.

    Header detection above only proves that *some* recognised column exists:
    a prefixed file made of ``input_context`` columns, a shorthand file made of
    ``context`` columns, or a canonical file whose ``Question`` cells are blank
    all passed it and were persisted as rows nothing can ask. Checked here, on
    the parsed records, so every header convention is judged by the same rule
    the bridge applies when it reads a row back — and before any row is stored.
    """
    empty = [index for index, record in enumerate(records, start=1) if not _question_text(record)]
    if not empty:
        return
    shown = ", ".join(str(index) for index in empty[:10])
    more = f" (and {len(empty) - 10} more)" if len(empty) > 10 else ""
    raise DatasetValidationError(
        f"Row(s) {shown}{more}: Question is empty. Every row needs a non-empty question "
        "under Question (or query / prompt / input, or input_question)."
    )


def _parse_prefixed_row(row: dict[str, str | None]) -> dict[str, Any]:
    """Parse a row using prefix conventions (input_*, expect_*, tag_*)."""
    inputs: dict[str, Any] = {}
    expectations: dict[str, Any] = {}
    tags: dict[str, str] = {}

    for col, val in row.items():
        if col is None:
            continue
        col = col.strip()
        cell = "" if val is None else val
        if col.startswith("input_"):
            inputs[col.removeprefix("input_")] = cell
        elif col.startswith("expect_"):
            expectations[col.removeprefix("expect_")] = cell
        elif col.startswith("tag_"):
            tags[col.removeprefix("tag_")] = str(cell)
        else:
            inputs[col] = cell

    return {"inputs": inputs, "expectations": expectations, "tags": tags}


def _parse_canonical_row(row: dict[str, str | None], index: int) -> dict[str, Any]:
    """Parse Serial No / Question / Expected Output / Metadata columns.

    The legacy flat ``Risk`` / ``Context`` / ``Expected Actions`` columns are
    still read, and land exactly where the same metadata keys would.
    """
    inputs: dict[str, Any] = {}
    expectations: dict[str, Any] = {}
    tags: dict[str, str] = {}
    serial = str(index)

    for col, val in row.items():
        if col is None:
            continue
        key = _normalize_header(col)
        cell = "" if val is None else _strip_formula_guard(val)
        if key in _CANONICAL_SERIAL:
            serial = str(cell).strip() or serial
        elif key in _CANONICAL_QUESTION:
            inputs["question"] = cell
            inputs["query"] = cell
        elif key in _CANONICAL_EXPECTED:
            expectations["expected_output"] = cell
            expectations["expected_response"] = cell
        elif key in _CANONICAL_RESPONSE:
            inputs["response"] = cell
        elif key in _CANONICAL_RISK:
            tags["risk"] = str(cell)
        elif key in _CANONICAL_CONTEXT:
            inputs["context"] = cell
        elif key in _CANONICAL_ACTIONS:
            expectations["expected_actions"] = cell
        elif key in _CANONICAL_METADATA:
            metadata_to_record(_parse_metadata_cell(str(cell), index), inputs, expectations, tags)
        elif key in {"domain", "category", "source"}:
            tags[key] = str(cell)
        else:
            inputs[col.strip()] = cell

    tags["serial_no"] = serial
    return {"inputs": inputs, "expectations": expectations, "tags": tags}


def _parse_shorthand_row(row: dict[str, str | None]) -> dict[str, Any]:
    """Parse a row using shorthand column mapping (legacy RAG-style)."""
    inputs: dict[str, Any] = {}
    expectations: dict[str, Any] = {}
    tags: dict[str, str] = {}

    for col, val in row.items():
        if col is None:
            continue
        col_lower = _normalize_header(col)
        cell = "" if val is None else val
        if col_lower in _SHORTHAND_INPUT_COLS:
            inputs[col_lower if col_lower != "input" else "question"] = cell
        elif col_lower in _SHORTHAND_TAG_COLS:
            tags[col_lower] = str(cell)
        else:
            expectations[col_lower.replace(" ", "_")] = cell

    return {"inputs": inputs, "expectations": expectations, "tags": tags}
