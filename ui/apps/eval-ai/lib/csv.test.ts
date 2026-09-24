import { describe, expect, it } from "vitest";

import { escapeCsvCell, neutralizeCsvFormula, stripCsvFormulaGuard } from "@/lib/csv";
import { recordsToCsvString } from "@/lib/dataset-csv";
import type { DatasetRecord } from "@/lib/api";

function record(partial: Partial<DatasetRecord> = {}): DatasetRecord {
  return {
    dataset_record_id: "rec-1",
    inputs: {},
    expectations: {},
    tags: {},
    ...partial,
  } as DatasetRecord;
}

describe("escapeCsvCell", () => {
  it("neutralises formula triggers before quoting", () => {
    expect(escapeCsvCell("=1+1")).toBe("'=1+1");
    expect(escapeCsvCell("@SUM(A1:A2),x")).toBe('"\'@SUM(A1:A2),x"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("plain")).toBe("plain");
  });
});

describe("neutralizeCsvFormula leading whitespace", () => {
  it("guards a formula the spreadsheet reaches past a leading space", () => {
    expect(neutralizeCsvFormula(" =1+1")).toBe("' =1+1");
    expect(neutralizeCsvFormula("  @SUM(A1:A2)")).toBe("'  @SUM(A1:A2)");
    expect(neutralizeCsvFormula("\t=1+1")).toBe("'\t=1+1");
  });

  it("leaves indented plain text and indented numbers alone", () => {
    expect(neutralizeCsvFormula(" Checkout Agent")).toBe(" Checkout Agent");
    expect(neutralizeCsvFormula(" -12.5")).toBe(" -12.5");
  });
});

describe("stripCsvFormulaGuard", () => {
  it("removes exactly the guard this module writes", () => {
    for (const value of ["=1+1", "+1", "-2+3", "@SUM(A1)", "\tcmd", " =1+1", "  @SUM(A1)"]) {
      expect(stripCsvFormulaGuard(neutralizeCsvFormula(value))).toBe(value);
    }
  });

  it("round-trips a legitimate apostrophe in front of a formula character", () => {
    // These read exactly like a guard, so the exporter escapes them with one
    // more apostrophe and the import drops that one — the cell survives instead
    // of losing the user's apostrophe.
    for (const value of ["' =SUM(A1:A2)", "'=1+1", "''=1+1", "'\tcmd", "'  @SUM(A1)"]) {
      expect(neutralizeCsvFormula(value)).toBe(`'${value}`);
      expect(stripCsvFormulaGuard(neutralizeCsvFormula(value))).toBe(value);
    }
  });

  it("leaves a leading apostrophe outside the encoding alone", () => {
    for (const value of ["'quoted'", "O'Brien", "'tis Shakespeare"]) {
      expect(neutralizeCsvFormula(value)).toBe(value);
      expect(stripCsvFormulaGuard(value)).toBe(value);
    }
  });
});

describe("dataset CSV export", () => {
  it("neutralises formula-like record fields, not only quotes them", () => {
    const csv = recordsToCsvString([
      record({
        inputs: { question: '=HYPERLINK("http://evil","click")' },
        expectations: { expected_output: "@SUM(A1:A2)" },
        tags: { serial_no: "1" },
      }),
    ]);

    const [, row] = csv.split("\n");
    expect(row).toBe('1,"\'=HYPERLINK(""http://evil"",""click"")",\'@SUM(A1:A2),');
    expect(row.includes(',=HYPERLINK')).toBe(false);
  });

  it("keeps ordinary cells untouched and carries the rest of the row as metadata", () => {
    const csv = recordsToCsvString([
      record({
        inputs: { question: "What is the capital of France?", context: "Paris is the capital." },
        expectations: { expected_output: "Paris", expected_actions: "search(q='France')" },
        tags: { serial_no: "1", risk: "Low" },
      }),
    ]);

    const [header, row] = csv.split("\n");
    expect(header).toBe("Serial No,Question,Expected Output,Metadata");
    // Everything but the two presented columns, as one JSON object the parser routes back.
    expect(row).toBe(
      '1,What is the capital of France?,Paris,' +
        '"{""context"":""Paris is the capital."",""expected_actions"":""search(q=\'France\')"",""risk"":""Low""}"',
    );
  });

  it("leaves the metadata cell empty when the row carries nothing else", () => {
    const csv = recordsToCsvString([
      record({
        inputs: { question: "Q", query: "Q" },
        expectations: { expected_output: "A", expected_response: "A" },
        tags: { serial_no: "1" },
      }),
    ]);

    expect(csv.split("\n")[1]).toBe("1,Q,A,");
  });
});
