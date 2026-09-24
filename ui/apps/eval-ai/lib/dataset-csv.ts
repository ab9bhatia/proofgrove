import type { DatasetRecord } from "@/lib/api";
import { escapeCsvCell } from "@/lib/csv";

export const DATASET_CSV_COLUMNS = [
  "Serial No",
  "Question",
  "Expected Output",
  "Metadata",
] as const;

export type DatasetCsvRow = {
  serialNo: string;
  question: string;
  expectedOutput: string;
  /** Compact JSON of everything the row carries beyond the two columns; "" when empty. */
  metadata: string;
};

/** Record keys presented as their own column, so they are never repeated in Metadata. */
const PRESENTED_KEYS = new Set([
  "question",
  "query",
  "expected_output",
  "expected_response",
  "serial_no",
]);

function firstString(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (value != null && typeof value !== "object" && String(value).trim()) {
      return String(value);
    }
  }
  return "";
}

/**
 * The metadata blob for a stored record: everything but the presented columns, flattened
 * out of the three storage dicts.
 *
 * Mirror of the backend's `csv_parser.record_metadata` / `metadata_to_record`, which route
 * each key back to the dict the scorers read it from — so download → edit → re-upload keeps
 * expected actions, context, risk and any custom key the row carried.
 */
export function recordMetadata(record: DatasetRecord): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const source of [record.inputs, record.expectations, record.tags]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (!PRESENTED_KEYS.has(key)) metadata[key] = value;
    }
  }
  return metadata;
}

/** Map a stored dataset record into the CSV display columns. */
export function recordToCsvRow(record: DatasetRecord, index: number): DatasetCsvRow {
  const inputs = record.inputs ?? {};
  const expectations = record.expectations ?? {};
  const tags = record.tags ?? {};
  const metadata = recordMetadata(record);

  return {
    serialNo: firstString([
      tags.serial_no,
      tags["Serial No"],
      tags.serialNo,
      index + 1,
    ]),
    question: firstString([
      inputs.question,
      inputs.query,
      inputs.prompt,
      inputs.input,
    ]),
    expectedOutput: firstString([
      expectations.expected_output,
      expectations.expected_response,
      expectations.expected_answer,
      expectations.answer,
    ]),
    metadata: Object.keys(metadata).length ? JSON.stringify(metadata) : "",
  };
}

export function recordsToCsvRows(records: DatasetRecord[]): DatasetCsvRow[] {
  return records.map((record, index) => recordToCsvRow(record, index));
}

/**
 * Serialize records to the canonical CSV format used by import/export.
 *
 * Cells go through the shared {@link escapeCsvCell}: dataset record fields are
 * attacker-controlled (they arrive verbatim through CSV upload), so a
 * `=HYPERLINK(…)` question must not become a live formula in the export.
 */
export function recordsToCsvString(records: DatasetRecord[]): string {
  const header = DATASET_CSV_COLUMNS.join(",");
  const lines = recordsToCsvRows(records).map((row) =>
    [row.serialNo, row.question, row.expectedOutput, row.metadata]
      .map(escapeCsvCell)
      .join(","),
  );
  return [header, ...lines].join("\n");
}

export function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
