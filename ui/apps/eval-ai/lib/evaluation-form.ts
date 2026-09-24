import type { DatasetInfo } from "@/lib/api";

/** The three response sources exposed by the Evaluate entry screen. */
export type EvaluationKind = "agent" | "llm" | "provided";

export const EVALUATION_KINDS: readonly EvaluationKind[] = ["agent", "llm", "provided"];

export function evaluationKindLabel(kind: EvaluationKind): string {
  if (kind === "agent") return "Agent";
  if (kind === "llm") return "LLM";
  return "Existing responses";
}

/**
 * What makes a dataset unusable: rows without a question to send, or without an expected
 * output to grade the answer against. Both halves are required — a question with nothing
 * to grade against cannot be evaluated either. Everything else a row carries is metadata,
 * which decides which metrics can be graded — never which mode can run, and never whether
 * the dataset can be picked, except that Existing responses also requires the
 * response it is being asked to score.
 *
 * `undefined`/`null` means the backend did not compute it on this response: unknown, which
 * is never presented as unusable.
 */
export function datasetMissingFields(dataset: DatasetInfo): string[] {
  return dataset.missing_row_fields ?? [];
}

export function datasetIsUnusable(dataset: DatasetInfo, kind: EvaluationKind): boolean {
  return (
    datasetMissingFields(dataset).length > 0 ||
    (kind === "provided" && dataset.missing_provided_response === true)
  );
}

/** "question", or "question and expected output" — what the notice names as missing. */
export function missingFieldsLabel(fields: string[]): string {
  return fields.length > 1 ? `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)}` : fields[0] ?? "";
}
