/**
 * CSV cell serialisation shared by every Proofgrove export path.
 *
 * Both the evaluation extract (`lib/eval-export.ts`) and the dataset extract
 * (`lib/dataset-csv.ts`) write attacker-influenced text — evaluation names,
 * and dataset record fields that arrive verbatim through CSV upload. A single
 * implementation means neutralisation cannot be fixed on one path and left
 * open on the other.
 */

/** Cell prefixes a spreadsheet evaluates as a formula instead of showing text. */
const FORMULA_PREFIX_RE = /^[=+\-@]/;
/** Leading control characters a spreadsheet swallows before parsing the cell. */
const CONTROL_PREFIX_RE = /^[\t\r\n]/;
/** Plain numbers keep their leading minus — they are values, not formulas. */
const PLAIN_NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
/**
 * A cell that reads as guarded: one or more apostrophes in front of a formula
 * trigger. The match is the FIRST apostrophe only, so one can be added on
 * export and removed on import. Everything else — `O'Brien`, `'quoted'` — is
 * outside the encoding and never gains or loses a character.
 */
const GUARDED_PREFIX_RE = /^'(?='*(?:[\t\r\n]|[ ]*[=+\-@]))/;

/**
 * Neutralise CSV formula injection. Excel, Sheets and LibreOffice evaluate a
 * cell starting with `=`, `+`, `-` or `@` (or a leading tab/CR) as a formula,
 * and quoting does not prevent it — so an evaluation named `=HYPERLINK(…)`
 * would execute when the export is opened. A leading apostrophe forces text.
 *
 * Leading spaces are stripped by the spreadsheet before it decides, so `" =1+1"`
 * is evaluated exactly like `"=1+1"` and is tested the same way here. Plain text
 * that merely happens to be indented is left alone.
 */
export function neutralizeCsvFormula(value: string): string {
  // A cell that already reads as guarded is escaped with one more apostrophe.
  // Without it, the user's own `' =SUM(A1:A2)` is indistinguishable from the
  // guard this function writes for ` =SUM(A1:A2)`, and re-importing an export
  // would silently eat the apostrophe.
  if (GUARDED_PREFIX_RE.test(value)) return `'${value}`;
  if (CONTROL_PREFIX_RE.test(value)) return `'${value}`;
  const trimmed = value.trimStart();
  if (!FORMULA_PREFIX_RE.test(trimmed) || PLAIN_NUMBER_RE.test(trimmed)) return value;
  return `'${value}`;
}

/**
 * Exact inverse of {@link neutralizeCsvFormula}: drop the one apostrophe that
 * function adds, whether it was written as a formula guard or as the escape in
 * front of a user's own guard-like value. A leading apostrophe outside the
 * encoding (`'quoted'`, `O'Brien`) is never touched, so export → import
 * round-trips losslessly in both directions.
 */
export function stripCsvFormulaGuard(value: string): string {
  return value.replace(GUARDED_PREFIX_RE, "");
}

/** Every exported cell passes through here, so no cell escapes neutralisation. */
export function escapeCsvCell(value: string): string {
  const safe = neutralizeCsvFormula(value);
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}
