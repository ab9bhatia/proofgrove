"""Tests for CSV parser and upload endpoint."""

from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from evalhub.api.dependencies import get_registry_service
from evalhub.datasets.csv_parser import parse_csv
from evalhub.datasets.exceptions import DatasetValidationError
from evalhub.datasets.models import DatasetRecord
from evalhub.evaluation.dataset_bridge import (
    _provided_response,
    missing_provided_response,
    record_to_row,
)
from evalhub.main import app

# ------------------------------------------------------------------
# Unit tests: parse_csv
# ------------------------------------------------------------------


class TestParseCsvCanonical:
    """Tests for Serial No / Question / Expected Output / Metadata columns."""

    def test_canonical_columns(self) -> None:
        csv_text = (
            "Serial No,Question,Expected Output,Risk\n"
            "1,What is X?,X is Y,Low\n"
            "2,What is Z?,Z is W,High\n"
        )
        records = parse_csv(csv_text)

        assert len(records) == 2
        assert records[0]["inputs"]["question"] == "What is X?"
        assert records[0]["inputs"]["query"] == "What is X?"
        assert records[0]["expectations"]["expected_output"] == "X is Y"
        assert records[0]["expectations"]["expected_response"] == "X is Y"
        assert records[0]["tags"] == {"risk": "Low", "serial_no": "1"}
        assert records[1]["tags"]["serial_no"] == "2"
        assert records[1]["tags"]["risk"] == "High"

    def test_context_and_expected_actions_reach_the_bridge(self) -> None:
        """The per-kind signal columns land where ``dataset_bridge`` reads them.

        ``Context`` is a RAG retrieval passage (``inputs``); ``Expected Actions``
        is the ";"-separated ``tool(args)`` encoding the bridge already parses
        (``expectations``, under the first key it probes).
        """
        from evalhub.evaluation.dataset_bridge import record_to_row

        csv_text = (
            "Serial No,Question,Expected Output,Risk,Context,Expected Actions\n"
            "1,What is X?,X is Y,Low,X is defined as Y in the handbook,"
            "\"search(query='X');lookup(entity='X')\"\n"
        )
        records = parse_csv(csv_text)

        assert records[0]["inputs"]["context"] == "X is defined as Y in the handbook"
        assert (
            records[0]["expectations"]["expected_actions"]
            == "search(query='X');lookup(entity='X')"
        )

        row = record_to_row(records[0])
        assert row.context == ["X is defined as Y in the handbook"]
        assert row.expected_tools == ["search", "lookup"]

    def test_metadata_column_lands_where_the_scorers_read(self) -> None:
        """One JSON blob, routed into the dicts storage already uses."""
        from evalhub.evaluation.dataset_bridge import record_to_row

        csv_text = (
            "Serial No,Question,Expected Output,Metadata\n"
            '1,What is X?,X is Y,"{""risk"": ""Low"", ""context"": ""X is Y in the handbook"", '
            '""expected_actions"": ""search(query=\'X\');lookup(entity=\'X\')"", '
            '""reviewer"": ""ana""}"\n'
        )
        records = parse_csv(csv_text)

        assert records[0]["inputs"]["context"] == "X is Y in the handbook"
        assert records[0]["inputs"]["reviewer"] == "ana"
        assert records[0]["tags"]["risk"] == "Low"
        row = record_to_row(records[0])
        assert row.expected_tools == ["search", "lookup"]

    def test_metadata_round_trips_through_an_export(self) -> None:
        """Download → edit → re-upload must not lose metadata.

        ``record_metadata`` is the exact inverse of the import routing, so a
        record rebuilt from its own exported blob is the record it started as.
        """
        from evalhub.datasets.csv_parser import metadata_to_record, record_metadata

        original = {
            "inputs": {"question": "q", "query": "q", "context": "ctx", "reviewer": "ana"},
            "expectations": {
                "expected_output": "a",
                "expected_response": "a",
                "expected_actions": "search(q=1)",
            },
            "tags": {"serial_no": "1", "risk": "Low", "domain": "support"},
        }

        metadata = record_metadata(original)
        assert "question" not in metadata and "expected_output" not in metadata

        inputs = {"question": "q", "query": "q"}
        expectations = {"expected_output": "a", "expected_response": "a"}
        tags = {"serial_no": "1"}
        metadata_to_record(metadata, inputs, expectations, tags)

        assert inputs == original["inputs"]
        assert expectations == original["expectations"]
        assert tags == original["tags"]

    def test_unparseable_metadata_is_rejected_with_its_row(self) -> None:
        csv_text = "Serial No,Question,Expected Output,Metadata\n1,q,a,not-json\n"
        with pytest.raises(DatasetValidationError, match="Row 1"):
            parse_csv(csv_text)

        listed = "Serial No,Question,Expected Output,Metadata\n1,q,a,\"[1, 2]\"\n"
        with pytest.raises(DatasetValidationError, match="JSON object"):
            parse_csv(listed)

    def test_blank_metadata_is_no_metadata(self) -> None:
        records = parse_csv("Serial No,Question,Expected Output,Metadata\n1,q,a,\n")
        assert records[0]["inputs"] == {"question": "q", "query": "q"}
        assert records[0]["tags"] == {"serial_no": "1"}

    def test_missing_serial_defaults_to_row_index(self) -> None:
        csv_text = "Question,Expected Output,Risk\nHello?,World,Medium\n"
        records = parse_csv(csv_text)

        assert records[0]["tags"]["serial_no"] == "1"
        assert records[0]["tags"]["risk"] == "Medium"

    def test_spreadsheet_formula_guard_round_trips(self) -> None:
        """A dataset exported with formula guards re-imports unchanged.

        The UI prefixes formula-trigger cells with an apostrophe so a
        ``=HYPERLINK(...)`` question cannot execute in Excel/Sheets; the parser
        removes exactly that guard so the stored text is the original.
        """
        csv_text = (
            "Serial No,Question,Expected Output,Risk\n"
            "1,\"'=HYPERLINK(\"\"http://evil\"\",\"\"click\"\")\",'@SUM(A1:A2),'-2+3\n"
        )
        records = parse_csv(csv_text)

        assert records[0]["inputs"]["question"] == '=HYPERLINK("http://evil","click")'
        assert records[0]["expectations"]["expected_output"] == "@SUM(A1:A2)"
        assert records[0]["tags"]["risk"] == "-2+3"

    def test_guard_ahead_of_an_indented_formula_round_trips(self) -> None:
        csv_text = "Serial No,Question,Expected Output,Risk\n1,' =1+1,' @SUM(A1),Low\n"
        records = parse_csv(csv_text)

        assert records[0]["inputs"]["question"] == " =1+1"
        assert records[0]["expectations"]["expected_output"] == " @SUM(A1)"

    def test_escaped_leading_apostrophe_round_trips(self) -> None:
        """A user's own apostrophe in front of a formula character survives.

        "' =SUM(A1:A2)" reads exactly like the guard the exporter writes for
        " =SUM(A1:A2)", so the exporter escapes it with a second apostrophe.
        Dropping one restores the cell instead of eating the user's apostrophe.
        """
        csv_text = (
            "Serial No,Question,Expected Output,Risk\n"
            "1,'' =SUM(A1:A2),''=1+1,Low\n"
        )
        records = parse_csv(csv_text)

        assert records[0]["inputs"]["question"] == "' =SUM(A1:A2)"
        assert records[0]["expectations"]["expected_output"] == "'=1+1"

    def test_legitimate_leading_apostrophe_survives(self) -> None:
        csv_text = (
            "Serial No,Question,Expected Output,Risk\n"
            "1,Who wrote 'Hamlet'?,'tis Shakespeare,Low\n"
        )
        records = parse_csv(csv_text)

        assert records[0]["inputs"]["question"] == "Who wrote 'Hamlet'?"
        assert records[0]["expectations"]["expected_output"] == "'tis Shakespeare"


class TestParseCsvPrefixed:
    """Tests for prefix-based column mapping (input_*, expect_*, tag_*)."""

    def test_basic_prefixed(self) -> None:
        csv_text = "input_question,input_context,expect_answer,tag_domain\nWhat is X?,X is Y,Y,science\n"
        records = parse_csv(csv_text)

        assert len(records) == 1
        assert records[0]["inputs"] == {"question": "What is X?", "context": "X is Y"}
        assert records[0]["expectations"] == {"answer": "Y"}
        assert records[0]["tags"] == {"domain": "science"}

    def test_unmapped_columns_go_to_inputs(self) -> None:
        csv_text = "input_question,extra_col,expect_a\nq1,val,a1\n"
        records = parse_csv(csv_text)

        assert records[0]["inputs"]["question"] == "q1"
        assert records[0]["inputs"]["extra_col"] == "val"
        assert records[0]["expectations"]["a"] == "a1"

    def test_multiple_rows(self) -> None:
        csv_text = "input_question,expect_a\nq1,a1\nq2,a2\nq3,a3\n"
        records = parse_csv(csv_text)

        assert len(records) == 3


class TestParseCsvShorthand:
    """Tests for shorthand column mapping (RAG-style)."""

    def test_rag_columns_use_canonical_when_question_present(self) -> None:
        # question + expected_answer trigger canonical mode (preferred schema).
        csv_text = "question,context,expected_answer,domain\nWhat?,Some ctx,Answer,ai\n"
        records = parse_csv(csv_text)

        assert len(records) == 1
        assert records[0]["inputs"]["question"] == "What?"
        assert records[0]["inputs"]["context"] == "Some ctx"
        assert records[0]["expectations"]["expected_output"] == "Answer"
        assert records[0]["tags"]["domain"] == "ai"
        assert records[0]["tags"]["serial_no"] == "1"

    def test_shorthand_without_a_question_column_is_rejected(self) -> None:
        """A context-only shorthand file used to import as rows nothing could
        ask; the bridge reads no question from them, so they are refused."""
        csv_text = "context,domain,source\nSome ctx,ai,wiki\n"
        with pytest.raises(DatasetValidationError, match=r"Row\(s\) 1: Question is empty"):
            parse_csv(csv_text)


class TestParseCsvValidation:
    """Tests for CSV validation errors."""

    def test_empty_content_raises(self) -> None:
        with pytest.raises(DatasetValidationError, match="no header"):
            parse_csv("")

    def test_header_only_raises(self) -> None:
        with pytest.raises(DatasetValidationError, match="no data rows"):
            parse_csv("col_a,col_b\n")

    def test_bytes_input(self) -> None:
        csv_bytes = b"input_question,expect_a\nq1,a1\n"
        records = parse_csv(csv_bytes)

        assert len(records) == 1

    def test_exceeds_row_limit(self) -> None:
        header = "input_question,expect_a\n"
        rows = "".join(f"q{i},a{i}\n" for i in range(2001))
        with pytest.raises(DatasetValidationError, match="2001 rows"):
            parse_csv(header + rows)


class TestParseCsvRecordCompatibility:
    """Verify parsed dicts are valid DatasetRecord inputs."""

    def test_parsed_records_create_valid_models(self) -> None:
        csv_text = "input_question,expect_answer,tag_domain\nWhat?,Answer,ai\n"
        records = parse_csv(csv_text)

        typed = [DatasetRecord(**r) for r in records]
        assert len(typed) == 1
        assert typed[0].inputs == {"question": "What?"}
        assert typed[0].expectations == {"answer": "Answer"}
        assert typed[0].tags == {"domain": "ai"}

    def test_canonical_records_create_valid_models(self) -> None:
        csv_text = "Serial No,Question,Expected Output,Risk\n1,What?,Answer,Low\n"
        records = parse_csv(csv_text)

        typed = [DatasetRecord(**r) for r in records]
        assert typed[0].inputs["question"] == "What?"
        assert typed[0].expectations["expected_output"] == "Answer"
        assert typed[0].tags["risk"] == "Low"


# ------------------------------------------------------------------
# Integration tests: POST /datasets/{name}/upload-csv
# ------------------------------------------------------------------


@pytest.fixture
def mock_svc() -> MagicMock:
    """Create a mock DatasetRegistryService."""
    svc = MagicMock()
    svc.get_dataset_tenant.return_value = "t1"
    return svc


@pytest.fixture
async def client(mock_svc: MagicMock):
    """Create an httpx AsyncClient with mocked dependencies."""
    app.dependency_overrides[get_registry_service] = lambda: mock_svc
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": "t1"},
    ) as ac:
        yield ac
    app.dependency_overrides.clear()


class TestUploadCsvEndpoint:
    """Tests for POST /datasets/{name}/upload-csv."""

    async def test_upload_csv_success(
        self, client: AsyncClient, mock_svc: MagicMock,
    ) -> None:
        mock_svc.merge_records.return_value = 3
        csv_content = b"input_question,expect_answer,tag_domain\nq1,a1,d1\nq2,a2,d2\nq3,a3,d3\n"

        resp = await client.post(
            "/datasets/test_ds/upload-csv",
            files={"file": ("data.csv", csv_content, "text/csv")},
        )

        assert resp.status_code == 201
        body = resp.json()
        assert body["merged"] == 3
        assert body["dataset_name"] == "test_ds"
        assert body["source"] == "data.csv"
        mock_svc.merge_records.assert_called_once()

    async def test_upload_csv_empty_file(
        self, client: AsyncClient, mock_svc: MagicMock,
    ) -> None:
        resp = await client.post(
            "/datasets/test_ds/upload-csv",
            files={"file": ("empty.csv", b"", "text/csv")},
        )

        assert resp.status_code == 422

    async def test_upload_csv_header_only(
        self, client: AsyncClient, mock_svc: MagicMock,
    ) -> None:
        resp = await client.post(
            "/datasets/test_ds/upload-csv",
            files={"file": ("hdr.csv", b"col_a,col_b\n", "text/csv")},
        )

        assert resp.status_code == 422

    async def test_upload_csv_canonical_columns(
        self, client: AsyncClient, mock_svc: MagicMock,
    ) -> None:
        mock_svc.merge_records.return_value = 1
        csv_content = (
            b"Serial No,Question,Expected Output,Risk\n"
            b"1,What?,Ans,Low\n"
        )

        resp = await client.post(
            "/datasets/test_ds/upload-csv",
            files={"file": ("golden.csv", csv_content, "text/csv")},
        )

        assert resp.status_code == 201
        assert resp.json()["merged"] == 1

        call_args = mock_svc.merge_records.call_args
        records = call_args[0][2]
        assert records[0].inputs["question"] == "What?"
        assert records[0].expectations["expected_output"] == "Ans"
        assert records[0].tags["risk"] == "Low"
        assert records[0].tags["serial_no"] == "1"

    async def test_upload_csv_rejects_missing_content_type(
        self, client: AsyncClient, mock_svc: MagicMock,
    ) -> None:
        """A part with no content-type is refused, not silently accepted.

        The check only ever fired for a *present-but-unsupported* content
        type; an absent one (multipart clients are not required to send one)
        skipped it entirely.
        """
        resp = await client.post(
            "/datasets/test_ds/upload-csv",
            files={"file": ("data.csv", b"a,b\n1,2\n", "")},
        )
        assert resp.status_code == 415
        mock_svc.merge_records.assert_not_called()

    async def test_upload_csv_rejects_a_non_utf8_file_as_a_client_error(
        self, client: AsyncClient, mock_svc: MagicMock,
    ) -> None:
        """A Windows-1252 export is a routine user error, not a server fault.

        It used to escape ``_handle_error`` as an unrecognised exception and
        surface as a 500 with a stack trace per upload.
        """
        latin1 = "Question,Expected Output\nQu'est-ce que c\u00e7a?,R\u00e9ponse\n".encode("latin-1")
        resp = await client.post(
            "/datasets/test_ds/upload-csv",
            files={"file": ("export.csv", latin1, "text/csv")},
        )
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "CSV must be UTF-8 encoded"
        mock_svc.merge_records.assert_not_called()

    async def test_upload_csv_rejects_file_over_the_configured_limit(
        self, client: AsyncClient, mock_svc: MagicMock,
    ) -> None:
        from evalhub.settings import settings

        prior_limit = settings.max_request_body_bytes
        settings.max_request_body_bytes = 16
        try:
            resp = await client.post(
                "/datasets/test_ds/upload-csv",
                files={"file": ("data.csv", b"x" * 64, "text/csv")},
            )
        finally:
            settings.max_request_body_bytes = prior_limit
        assert resp.status_code == 413
        mock_svc.merge_records.assert_not_called()


def test_a_response_column_becomes_a_stored_answer():
    """The natural CSV for existing responses must be able to launch.

    `Response` fell through to `inputs["Response"]` verbatim, and the provided
    reader takes the exact lowercase key — so a CSV that visibly carried answers
    uploaded fine and was then refused as having none.
    """

    records = parse_csv(
        "Serial No,Question,Expected Output,Response\n"
        "1,What is X?,An X,The stored answer\n"
    )

    assert records[0]["inputs"]["response"] == "The stored answer"
    assert missing_provided_response(records) is False
    assert record_to_row(records[0], response_source="provided").response == "The stored answer"


def test_a_structured_response_is_refused_rather_than_printed():
    """A record may hold arbitrary JSON; scoring its repr is a wrong result.

    `str({"answer": True})` produced "{'answer': True}" — content the dataset
    never contained — and it passed readiness and was scored against the
    expected output.
    """

    record = {"inputs": {"query": "q"}, "expectations": {"response": {"answer": True}}}

    assert _provided_response(record) is None
    assert missing_provided_response([record]) is True


class TestParseCsvQuestionRequired:
    """Every convention is judged by the question the bridge will read back."""

    def test_prompt_header_is_a_supported_question_column(self) -> None:
        """The Violet validation-pass CSV: ``Prompt`` is a canonical alias, so
        the import is accepted and the question lands where scorers read it."""
        csv_text = (
            "Serial No,Prompt,Expected Output\n"
            '1,"What is the default Service type?","ClusterIP"\n'
            '2,"What is the ConfigMap size limit?","1 MiB"\n'
        )
        records = parse_csv(csv_text)
        assert [r["inputs"]["question"] for r in records] == [
            "What is the default Service type?",
            "What is the ConfigMap size limit?",
        ]
        assert records[0]["expectations"]["expected_output"] == "ClusterIP"

    def test_blank_question_cells_name_their_rows(self) -> None:
        csv_text = "Serial No,Question,Expected Output\n1,What is X?,X\n2,,Y\n3,   ,Z\n"
        with pytest.raises(DatasetValidationError, match=r"Row\(s\) 2, 3: Question is empty"):
            parse_csv(csv_text)

    def test_canonical_file_with_every_question_blank_names_every_row(self) -> None:
        csv_text = "Serial No,Question,Expected Output\n1,,X\n2,,Y\n"
        with pytest.raises(DatasetValidationError, match=r"Row\(s\) 1, 2: Question is empty"):
            parse_csv(csv_text)

    def test_prefixed_file_without_a_question_key_is_rejected(self) -> None:
        csv_text = "input_context,expect_answer\nX is Y,Y\n"
        with pytest.raises(DatasetValidationError, match=r"Row\(s\) 1: Question is empty"):
            parse_csv(csv_text)

    @pytest.mark.parametrize("header", ["input_question", "input_query", "input_prompt", "input_input"])
    def test_prefixed_question_aliases_are_preserved(self, header: str) -> None:
        records = parse_csv(f"{header},expect_answer\nWhat is X?,Y\n")
        assert len(records) == 1
        assert records[0]["inputs"][header.removeprefix("input_")] == "What is X?"

    def test_prefixed_blank_question_is_rejected(self) -> None:
        with pytest.raises(DatasetValidationError, match=r"Row\(s\) 2: Question is empty"):
            parse_csv("input_question,expect_answer\nWhat is X?,Y\n,Z\n")

    def test_whitespace_in_the_first_alias_is_judged_like_the_bridge(self) -> None:
        """``dataset_bridge._first`` returns the first truthy alias and never
        looks at the next one, so a whitespace-only ``input_question`` beside a
        real ``input_query`` would execute with a blank query. The parser must
        refuse that row rather than accept it on the strength of the alias the
        bridge will ignore."""
        with pytest.raises(DatasetValidationError, match=r"Row\(s\) 1: Question is empty"):
            parse_csv("input_question,input_query,expect_answer\n   ,What is X?,X\n")
        # An empty first alias is falsy, so the bridge falls through to the
        # real question and the row is usable.
        records = parse_csv("input_question,input_query,expect_answer\n,What is X?,X\n")
        assert records[0]["inputs"]["query"] == "What is X?"

    def test_whitespace_only_question_is_not_a_question(self) -> None:
        with pytest.raises(DatasetValidationError, match="Question is empty"):
            parse_csv("Question,Expected Output\nWhat is X?,X\n\t,Y\n")


class TestUploadCsvRejectsBeforePersisting:
    """A refused CSV must not reach the registry at all (no partial records)."""

    async def test_upload_without_question_column_is_422_and_stores_nothing(
        self, client: AsyncClient, mock_svc: MagicMock,
    ) -> None:
        resp = await client.post(
            "/datasets/test_ds/upload-csv",
            files={"file": ("bad.csv", b"input_context,expect_answer\nX is Y,Y\n", "text/csv")},
        )
        assert resp.status_code == 422
        assert "Row(s) 1: Question is empty" in resp.json()["detail"]
        mock_svc.merge_records.assert_not_called()

    async def test_upload_with_a_blank_question_row_is_422_and_stores_nothing(
        self, client: AsyncClient, mock_svc: MagicMock,
    ) -> None:
        resp = await client.post(
            "/datasets/test_ds/upload-csv",
            files={"file": ("bad.csv", b"Question,Expected Output\nWhat?,A\n,B\n", "text/csv")},
        )
        assert resp.status_code == 422
        assert "Row(s) 2: Question is empty" in resp.json()["detail"]
        mock_svc.merge_records.assert_not_called()
