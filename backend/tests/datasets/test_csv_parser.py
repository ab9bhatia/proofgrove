"""Tests for CSV parsing edge cases."""

from proofgrove.datasets.csv_parser import parse_csv


def test_parse_csv_accepts_utf8_bom() -> None:
    """Excel-exported CSVs start with a UTF-8 BOM; header detection must not
    see it as part of the first column name."""
    body = "﻿query,expected_response\nhello,world\n".encode()
    records = parse_csv(body)
    assert len(records) == 1
    assert records[0]["inputs"]["query"] == "hello"
