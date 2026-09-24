"""Pydantic models for golden datasets + governance metadata.

Records follow the record schema (inputs, expectations, tags).
Governance metadata (tenant, product, lifecycle) is stored in a
``golden_datasets`` registry table alongside the record tables.
"""

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from evalhub.datasets.enums import ChangeReason, DatasetStatus

# Platform constraints
MAX_ROWS_PER_DATASET = 2_000
MAX_EXPECTATIONS_PER_RECORD = 20


# ------------------------------------------------------------------
# Record model
# ------------------------------------------------------------------


class DatasetRecord(BaseModel):
    """A single evaluation record in the record schema."""

    inputs: dict[str, Any]
    expectations: dict[str, Any] = Field(default_factory=dict)
    tags: dict[str, str] = Field(default_factory=dict)

    @field_validator("expectations")
    @classmethod
    def validate_expectations_limit(cls, v: dict[str, Any]) -> dict[str, Any]:
        """Enforce max 20 expectation keys per record."""
        if len(v) > MAX_EXPECTATIONS_PER_RECORD:
            msg = f"Expectations must have at most {MAX_EXPECTATIONS_PER_RECORD} keys, got {len(v)}"
            raise ValueError(msg)
        return v


# ------------------------------------------------------------------
# Governance metadata (stored in custom registry table)
# ------------------------------------------------------------------


class DatasetMetadata(BaseModel):
    """Governance metadata for a dataset — lives in dataset_registry.

    Parameters
    ----------
    tenant_id : str
        Tenant owning the dataset.
    product_id : str
        Product or service the dataset belongs to.
    status : DatasetStatus
        Current lifecycle state.
    version_number : int
        Logical version (incremented per new version).
    parent_dataset_name : str or None
        Name of the parent dataset (lineage).
    dqs : float or None
        Dataset Quality Score from validation.
    change_reason : ChangeReason or None
        Why this version was created.
    created_by : str
        User or service that created the dataset.
    """

    tenant_id: str
    product_id: str
    status: DatasetStatus = DatasetStatus.DRAFT
    version_number: int = 1
    parent_dataset_name: str | None = None
    dqs: float | None = None
    change_reason: ChangeReason | None = None
    created_by: str = "system"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


# ------------------------------------------------------------------
# API request / response models
# ------------------------------------------------------------------


class CreateDatasetRequest(BaseModel):
    """Request to create a new dataset with governance metadata."""

    # Bounded to the backing column widths (golden_datasets.dataset_name is
    # String(256), tenant_id/product_id are String(128)) so an oversized
    # request 400s at the API boundary instead of failing deep inside a
    # commit with a raw DB error.
    dataset_name: str = Field(description="dataset name (e.g. rag_onboarding)", max_length=256)
    #: Non-empty on purpose: an empty owner would satisfy every later tenant
    #: comparison and make the dataset world-readable.
    tenant_id: str = Field(min_length=1, max_length=128)
    product_id: str = Field(max_length=128)
    csv_content: str | None = Field(default=None, max_length=20_000_000)
    created_by: str = "system"


class CreateVersionRequest(BaseModel):
    """Request to create a new version from an existing dataset."""

    source_dataset_name: str = Field(description="Name of the parent dataset")
    new_dataset_name: str = Field(description="Name for the new version")
    change_reason: ChangeReason
    created_by: str = "system"


class RestoreDatasetRequest(BaseModel):
    """Request to restore a retired dataset as a copied DRAFT version."""

    created_by: str = "system"


class MergeRecordsRequest(BaseModel):
    """Request to merge records into a dataset."""

    records: list[DatasetRecord]

    @field_validator("records")
    @classmethod
    def validate_batch_size(cls, v: list[DatasetRecord]) -> list[DatasetRecord]:
        """Enforce max 2,000 rows per dataset."""
        if len(v) > MAX_ROWS_PER_DATASET:
            msg = f"Batch must have at most {MAX_ROWS_PER_DATASET} records, got {len(v)}"
            raise ValueError(msg)
        return v


class DeleteRecordsRequest(BaseModel):
    """Request to delete records by ID."""

    record_ids: list[str]


class WriteExpectedToolsRequest(BaseModel):
    """Request to write expected tools onto chosen dataset rows.

    Scoping a run and stating a row expectation are different claims: this is
    the second one, and it only ever touches ``record_ids`` the operator named.
    """

    #: At least one row: an empty selection is not a no-op, because the
    #: immutable path would still branch a new draft version to annotate
    #: nothing. A write with no chosen rows is a caller error.
    record_ids: list[str] = Field(min_length=1)
    tools: list[str]
    #: Which agent's declared inventory the names came from, recorded so a later
    #: reader can tell where the expectation originated.
    source_agent: str | None = None
    #: When the dataset is past DRAFT, copy it into the next DRAFT version and
    #: annotate that instead of refusing. Never implied — the operator opts in.
    create_version_if_immutable: bool = False
    created_by: str = "system"

    @field_validator("tools")
    @classmethod
    def _validate_tools(cls, v: list[str]) -> list[str]:
        # Public boundary onto governed golden data: the storage format joins
        # names with ";" and the bridge parses "name(args)", so those characters
        # in a name would silently split or truncate the expectation.
        cleaned: list[str] = []
        for raw in v:
            name = raw.strip()
            if not name:
                msg = "Tool names must be non-empty"
                raise ValueError(msg)
            if ";" in name or "(" in name or ")" in name:
                msg = f"Tool name {name!r} may not contain ';', '(' or ')'"
                raise ValueError(msg)
            if name not in cleaned:
                cleaned.append(name)
        return cleaned


class WriteExpectedToolsResult(BaseModel):
    """Outcome of a write-back."""

    dataset_name: str
    annotated: int
    tools: list[str]
    #: True when the write landed on a newly created DRAFT version rather than
    #: the dataset the operator started from.
    created_version: bool = False
    source_dataset_name: str | None = None
    version_number: int | None = None
    status: str | None = None


class PromoteRunItemRequest(BaseModel):
    """Promote one captured run item into a dataset record."""

    run_id: str = Field(min_length=1)
    example_id: str = Field(min_length=1)
    #: Which captured text becomes the record's expected output: the model's
    #: actual answer, or the expectation the item was graded against.
    expected_source: Literal["output", "expected", "reviewer"] = "output"
    #: The answer a reviewer says the case should have had.
    #:
    #: Required when ``expected_source`` is ``reviewer`` and rejected otherwise.
    #: This is the annotation path: a human who judged the case wrong writes
    #: what the right answer was, and it becomes the record's ground truth —
    #: evidence a later run is graded against, not a note nudging a judge's
    #: opinion. Reviewers still never type a score.
    expected_text: str | None = Field(default=None, max_length=20000)
    create_version_if_immutable: bool = False
    created_by: str = "system"

    @model_validator(mode="after")
    def _reviewer_text_matches_source(self) -> "PromoteRunItemRequest":
        """The two fields have to agree, or the record's provenance is a guess.

        Silently ignoring text on a captured source would install the captured
        answer while the caller believed it had installed the reviewer's, and
        the record would claim a human wrote something they did not.
        """
        supplied = (self.expected_text or "").strip()
        if self.expected_source == "reviewer" and not supplied:
            raise ValueError("expected_text is required when promoting a reviewer's answer")
        if self.expected_source != "reviewer" and supplied:
            raise ValueError("expected_text is only accepted with expected_source='reviewer'")
        return self


class PromoteRunItemResult(BaseModel):
    """Outcome of promoting a run item."""

    dataset_name: str
    record_id: str
    #: True when this source item had already been promoted here; the existing
    #: record was refreshed rather than a new row added.
    duplicate: bool
    created_version: bool = False
    source_dataset_name: str | None = None
    version_number: int | None = None
    status: str | None = None


class DatasetFilterParams(BaseModel):
    """Query parameters for filtering datasets."""

    tenant_id: str | None = None
    product_id: str | None = None
    status: DatasetStatus | None = None
    #: Statuses to hide. Lets a caller ask for "everything still in play" without
    #: a synthetic status that would have to be kept in sync with the lifecycle.
    exclude_statuses: list[DatasetStatus] = Field(default_factory=list)


class PaginatedItems(BaseModel):
    """Server-paginated envelope for dataset list + records endpoints.

    Matches the run-history paging convention: ``items`` is one page, ``total``
    is the full (unpaged) match count and ``next_cursor`` is the opaque offset
    of the next page (``None`` once the last page has been returned).
    """

    items: list[dict[str, Any]] = Field(default_factory=list)
    total: int = 0
    limit: int = 50
    offset: int = 0
    next_cursor: str | None = None


class DatasetInfo(BaseModel):
    """Full dataset response combining records + governance metadata.

    Returned by most endpoints as the standard dataset representation.

    ``missing_row_fields`` is read from row content (see
    ``evaluation.dataset_bridge.missing_row_fields``): a dataset needs both a
    question to send to a target and an expected output to grade the answer
    against, and this names whichever half its rows do not carry. Empty means
    usable; ``None`` means it was not computed on this response — the
    create/version/restore paths return the record copy they just made without
    re-reading rows.
    """

    dataset_id: str
    name: str
    tenant_id: str
    product_id: str
    status: str
    version_number: int = 1
    parent_dataset_name: str | None = None
    dqs: float | None = None
    change_reason: str | None = None
    created_by: str = "system"
    record_count: int = 0
    missing_row_fields: list[str] | None = None
    # True when an inspected row cannot be used by response_source="provided";
    # None means the bounded row summary was not computed.
    missing_provided_response: bool | None = None
    # The library lists 117 datasets; recency is what a reader scans to choose
    # between them, and it was the one thing the row could not say.
    updated_at: datetime | None = None


class ApproveRequest(BaseModel):
    """Request to approve a VALIDATED dataset."""

    approved_by: str


class DatasetReviewRequest(BaseModel):
    """Human decision used to reject or return a dataset to draft."""

    decided_by: str
    note: str | None = None


class GenerateDatasetRequest(BaseModel):
    """Request to synthesise a golden dataset.

    ``generation_method``:
    - ``llms``: one prompt/instruction → ``num_rows`` synthetic records (no MCP grounding).
    - ``tools`` / ``agents``: one prompt/instruction → ``num_rows`` grounded records
      (instruction expanded to seed topics, each grounded via MCP, then LLM synthesis).
      Explicit multi-seed lists remain supported for backward compatibility.
    """

    dataset_name: str = Field(description="Target DRAFT dataset name to create")
    grounding_url: str | None = Field(
        default=None,
        description="MCP server /mcp endpoint to ground generation on (required unless generation_method=llms)",
    )
    grounding_tool: str = Field(default="search", description="MCP tool to call for grounding material")
    seeds: list[str] = Field(
        default_factory=list,
        description="Single generation instruction (preferred) or explicit seed topics",
    )
    num_rows: int | None = Field(
        default=None,
        description="Target row count (exact for llms; expands/caps seeds for tools/agents)",
    )
    domain: str = Field(default="", description="tag_domain applied to generated rows")
    agent: str | None = Field(default=None, description="Optional target agent '<ns>/<name>' (provenance)")
    product_id: str = "eval-hub"
    model: str | None = Field(default=None, description="Generation model (defaults to the judge model)")
    generation_method: str | None = Field(
        default=None,
        description="llms | tools | agents — selects the generation path",
    )
