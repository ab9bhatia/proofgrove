"""Bridge golden dataset records into evaluation rows.

A golden dataset record holds ``inputs`` + ``expectations`` (ground truth)
but no model ``response``. This module maps those records into the
``EvaluationRow`` shape the engine grades, choosing where the response
comes from via ``response_source``:

    baseline  → use the expected answer AS the response (pipeline sanity
                check; scores should be near-perfect and prove the judge +
                metrics + persistence all work end-to-end)
    provided  → use a response already present on the record
                (``expectations.response`` / ``inputs.response``)
    agent     → leave the response empty; the run wiring invokes a live agent
                per row and fills response + tool_calls + context (groundedness)
    llm       → leave the response empty; the run wiring invokes a Compass /
                custom LLM per row and fills response + latency
"""

import hashlib
import json
from collections.abc import Iterable
from typing import Any

from proofgrove.evaluation.models import EvaluationRow

# Candidate keys for the question/query across dataset types.
_QUERY_KEYS = ("question", "query", "prompt", "input")
# Candidate keys for the expected answer across dataset types.
_EXPECTED_KEYS = (
    "expected_output",
    "expected_response",
    "expected_sql",
    "expected_answer",
    "answer",
)
# Candidate expectation keys holding the ground-truth tool actions the agent
# should take (agent datasets). Values are ";"-separated "tool(args)" strings.
_EXPECTED_ACTION_KEYS = ("expected_actions", "expected_tool_calls", "actions")


def _first(d: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for k in keys:
        v = d.get(k)
        if v:
            return str(v)
    return None


def _context_list(inputs: dict[str, Any]) -> list[str]:
    """Collect context strings from inputs (RAG context, sql schema hints)."""
    ctx: list[str] = []
    raw = inputs.get("context")
    if isinstance(raw, list):
        ctx.extend(str(x) for x in raw if x)
    elif raw:
        ctx.append(str(raw))
    # text2sql: surface schema/table hints as retrieval context
    for key in ("schema_id", "table_refs"):
        if inputs.get(key):
            ctx.append(f"{key}: {inputs[key]}")
    return ctx


def _expected_tools(expectations: dict[str, Any]) -> list[str]:
    """Parse the tool names the agent is expected to call.

    Reads a ";"-separated ``tool(args)`` string from the record's expected
    actions and returns just the tool names (``search(q=..)`` -> ``search``).
    Dataset-driven: whatever the golden row declares — no tool name is hardcoded.
    """

    raw = None
    for key in _EXPECTED_ACTION_KEYS:
        value = expectations.get(key)
        if value:
            raw = value
            break
    if not raw:
        return []
    tools: list[str] = []
    for action in str(raw).split(";"):
        action = action.strip()
        if not action:
            continue
        name = action.split("(", 1)[0].strip()
        if name:
            tools.append(name)
    return tools


# How many records ``missing_row_fields`` reads. Carrying a usable row is a
# property of the dataset, not of one row: one complete row makes the dataset
# evaluable, so the scan early-returns as soon as both halves have been seen.
# Only the pessimal case — a dataset missing a half everywhere — walks every
# record, which is why callers cap the page they hand in. 200 rows is 10% of the
# 2,000-row platform ceiling and enough that a real signal shows up in the first
# page.
ROW_SCAN_RECORDS = 200

# How many datasets of one *list* call get a verdict. The list scan is a single
# bulk query, but it still transfers up to ``ROW_SCAN_RECORDS`` rows per dataset,
# and ``list_datasets`` is unpaged — so the number of datasets is capped as well
# as the rows per dataset. Datasets past the cap come back with
# ``missing_row_fields=None``: not computed, which is not the same claim as
# "carries everything". Sized to the workbench picker page (50).
ROW_SCAN_DATASETS = 50

# The two halves an evaluation cannot do without, in the order they are read.
QUESTION_FIELD = "question"
EXPECTED_OUTPUT_FIELD = "expected output"


def missing_row_fields(records: Iterable[dict[str, Any]]) -> list[str]:
    """Which of the two required halves these records do not carry.

    A row is graded by sending its question to a target and comparing the answer
    against the row's expected output, so both halves are required: a question
    with nothing to grade against is as unusable as no question at all. Nothing
    else a row declares (expected tools, context, annotations) is consulted —
    metadata decides which metrics can be graded, never which mode can run.

    Read through the same key lists the bridge grades with (``_QUERY_KEYS`` /
    ``_EXPECTED_KEYS``) so this can never disagree with what a run would find.

    Returns
    -------
    list[str]
        Empty when the records carry both halves; otherwise the missing field
        names, ready to name in a message.
    """

    has_question = False
    has_expected = False
    for record in records:
        has_question = has_question or bool(_first(record.get("inputs") or {}, _QUERY_KEYS))
        has_expected = has_expected or bool(
            _first(record.get("expectations") or {}, _EXPECTED_KEYS)
        )
        if has_question and has_expected:
            return []
    return [
        field
        for field, found in ((QUESTION_FIELD, has_question), (EXPECTED_OUTPUT_FIELD, has_expected))
        if not found
    ]


def _provided_response(record: dict[str, Any]) -> str | None:
    """Return a declared response, preserving an intentionally empty answer.

    A real answer wins wherever it sits, and only when neither container holds
    one does a declared empty count as the answer. A non-string answer returns
    ``None`` rather than its ``repr``: a record may hold arbitrary JSON, and
    ``str({"answer": True})`` scored ``"{\'answer\': True}"`` — content the
    dataset never contained — against the expected output. Taking the first container
    that merely *has* the key meant a schema whose ``expectations.response``
    defaults to empty shadowed the captured answer in ``inputs.response``:
    every row scored an empty string, while readiness, capture status and the
    row count all still reported the run complete.
    """

    containers = (record.get("expectations") or {}, record.get("inputs") or {})
    for container in containers:
        value = container.get("response")
        if value or value == 0:
            return value if isinstance(value, str) else None
    for container in containers:
        if "response" in container and container["response"] is not None:
            return ""
    return None


def missing_provided_response(records: Iterable[dict[str, Any]]) -> bool:
    """Whether any inspected row has no response declaration for a provided run."""

    return any(_provided_response(record) is None for record in records)


def record_to_row(record: dict[str, Any], *, response_source: str = "baseline") -> EvaluationRow:
    """Convert a single golden dataset record into an EvaluationRow."""
    inputs = record.get("inputs", {}) or {}
    expectations = record.get("expectations", {}) or {}
    tags = record.get("tags", {}) or {}

    query = _first(inputs, _QUERY_KEYS) or ""
    expected = _first(expectations, _EXPECTED_KEYS)
    context = _context_list(inputs)
    # Dataset trace lineage describes the source evidence. A new target
    # invocation is a separate execution and must not inherit that identity.
    preserve_source_trace = response_source not in {"agent", "llm"}
    trace_id = (
        inputs.get("trace_id") or inputs.get("phoenix_trace_id")
        if preserve_source_trace
        else None
    )
    span_id = (
        inputs.get("span_id") or inputs.get("phoenix_span_id")
        if preserve_source_trace
        else None
    )
    parent_span_id = inputs.get("parent_span_id") if preserve_source_trace else None
    trace_provider = inputs.get("trace_provider") if preserve_source_trace else None

    if response_source == "provided":
        provided_response = _provided_response(record)
        response = provided_response if provided_response is not None else ""
    elif response_source in {"agent", "llm"}:
        response = ""  # filled by the agent / LLM runner in the run wiring
    else:  # baseline: grade the expected answer against itself
        response = expected or ""

    record_id = str(record.get("dataset_record_id") or "").strip()
    if not record_id:
        fingerprint = json.dumps(
            record, sort_keys=True, separators=(",", ":"), default=str
        )
        record_id = f"generated-{hashlib.sha256(fingerprint.encode()).hexdigest()[:16]}"

    return EvaluationRow(
        row_id=record_id[:128],
        query=query,
        response=response,
        expected_response=expected,
        context=context,
        trace_id=(
            trace_id
            if isinstance(trace_id, str) and trace_id
            else None
        ),
        expected_tools=_expected_tools(expectations),
        from_agent=(response_source == "agent"),
        tags={str(k): str(v) for k, v in tags.items()},
        input_data=dict(inputs),
        output_data={"response": response},
        expected_data=dict(expectations),
        retrieval_snippets=context,
        span_id=(
            span_id
            if isinstance(span_id, str) and span_id
            else None
        ),
        parent_span_id=(
            parent_span_id
            if isinstance(parent_span_id, str) and parent_span_id
            else None
        ),
        trace_provider=(
            trace_provider
            if isinstance(trace_provider, str) and trace_provider
            else None
        ),
    )


def records_to_rows(
    records: list[dict[str, Any]], *, response_source: str = "baseline"
) -> list[EvaluationRow]:
    """Convert golden dataset records into evaluation rows."""
    return [record_to_row(r, response_source=response_source) for r in records]
