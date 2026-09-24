// Sanitisation for browser-sourced error records.
//
// ADR-26-07-21 puts the authoritative redaction stage at the node-level OTel
// agent, and this module does not replace it. It exists because browser input
// is attacker-influenced: an authenticated user can put anything in an error
// message, and a stack trace routinely carries URLs whose query strings hold
// tokens. Trimming at the source keeps unbounded and obviously-sensitive
// values out of the log pipeline in the first place.
//
// The rule is bounded output: every function here returns a value whose size
// is capped regardless of input.

/** Hard caps. Anything longer is truncated, never rejected — a clipped error is still useful. */
export const MAX_MESSAGE_CHARS = 500;
export const MAX_STACK_CHARS = 2000;
export const MAX_STACK_FRAMES = 20;

const REDACTED = "[redacted]";

/**
 * Patterns replaced before a value is emitted.
 *
 * Deliberately conservative: these catch the shapes that show up in practice
 * (bearer tokens, JWTs, emails, query-string secrets) rather than attempting
 * general PII detection, which belongs at the collector where the salt lives.
 */
const REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // JWTs — three base64url segments. Must precede the generic token rule.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, REDACTED],
  // Authorization headers echoed into messages.
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`],
  // Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, REDACTED],
  // GUIDs. Entra `sub` and `oid` claims are GUIDs, so an error like
  // "user <guid> lacks role" leaks exactly the identifier this package
  // otherwise refuses to collect.
  [
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    REDACTED,
  ],
  // Provider-prefixed API keys.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, REDACTED],
  // PEM blocks.
  [/-----BEGIN[^-]{0,40}-----[\s\S]*?-----END[^-]{0,40}-----/g, REDACTED],
  // Sensitive parameters. `[?&#]` because implicit and hybrid OAuth flows
  // return tokens in the URL *fragment*, and `(?:^|[?&#])` because a message
  // may start mid-query-string.
  [
    /(^|[?&#])((?:access_token|id_token|refresh_token|client_secret|api[_-]?key|assertion|token|code|secret|password|key|sig|signature|sas)=)[^&\s"']+/gi,
    `$1$2${REDACTED}`,
  ],
  // Generic high-entropy blobs not matched above. False positives on long
  // base64 payloads are an acceptable price for catching opaque session
  // handles and provider tokens with no recognisable prefix.
  [/\b[A-Za-z0-9_-]{40,}\b/g, REDACTED],
];

function redact(value: string): string {
  let out = value;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}

/**
 * Reduce an error message to a bounded, redacted string.
 *
 * Non-string input is coerced rather than dropped: `throw {code: 1}` is legal
 * JavaScript and the resulting record is still worth having.
 */
export function sanitizeMessage(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const text = typeof raw === "string" ? raw : safeStringify(raw);
  return truncate(redact(text), MAX_MESSAGE_CHARS);
}

/**
 * Reduce a stack trace to a bounded, redacted head.
 *
 * Only the top frames are kept — they identify the fault; the tail is
 * framework noise that multiplies ingestion cost.
 */
export function sanitizeStack(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  const head = raw.split("\n").slice(0, MAX_STACK_FRAMES).join("\n");
  return truncate(redact(head), MAX_STACK_CHARS);
}

/**
 * Best-effort stringify that never throws on cyclic or exotic input.
 *
 * Arbitrary thrown *objects* are reduced to their constructor name rather than
 * serialised. In an agent-building product the object present at the moment of
 * failure plausibly carries prompt text, tool arguments, or retrieved document
 * content — bounding its length bounds the volume, not the sensitivity.
 */
function safeStringify(value: unknown): string {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value != null && typeof value === "object") {
      return `[${value.constructor?.name ?? "Object"}]`;
    }
    return String(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Derive a bounded `error.type` from a thrown value.
 *
 * Constructor names are attacker-controllable in principle, so the result is
 * clamped and stripped of anything but identifier characters to keep it usable
 * as a grouping key.
 */
export function sanitizeErrorType(raw: unknown): string {
  const name =
    raw instanceof Error
      ? raw.name
      : typeof raw === "object" && raw !== null && "name" in raw
        ? String((raw as { name: unknown }).name)
        : "Error";
  const cleaned = name.replace(/[^A-Za-z0-9_.$]/g, "");
  return truncate(cleaned || "Error", 64);
}
