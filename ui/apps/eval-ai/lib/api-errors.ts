/** One entry of a multi-part problem (e.g. per-field validation failure). */
export interface ApiErrorDetail {
  code?: string;
  field?: string;
  message: string;
}

export interface PublicApiErrorBody {
  error: {
    code: string;
    message: string;
    request_id?: string;
    /** Form control the problem refers to, when the backend names one. */
    field?: string;
    /** Actionable recovery guidance, when the backend provides it. */
    recovery?: string;
    details?: ApiErrorDetail[];
  };
}

/* Bounds for the forwarded problem contract. Everything outside these limits is
 * truncated or dropped so an upstream body can never smuggle stack traces,
 * payload dumps, or unbounded text to the browser. */
const MAX_PROBLEM_TEXT = 500;
const MAX_PROBLEM_CODE = 100;
const MAX_PROBLEM_DETAILS = 8;
const MAX_UPSTREAM_BODY_BYTES = 262_144;

const DEFAULT_MESSAGES: Record<number, string> = {
  400: "The request could not be completed. Check the fields and try again.",
  401: "Your session is no longer valid. Sign in again to continue.",
  403: "You do not have permission to perform this action.",
  404: "The requested item could not be found.",
  409: "This item changed or cannot be modified in its current state.",
  413: "The uploaded file is too large.",
  422: "Some information is invalid. Review the highlighted fields and try again.",
  429: "Too many requests were sent. Wait a moment and try again.",
  502: "Proofgrove is temporarily unavailable. Try again shortly.",
  // A 503 means an Proofgrove dependency (for example the span archive) is down,
  // not that the workspace lacks Proofgrove. "Not provisioned" messaging belongs
  // exclusively to the readiness gate, which reads /api/status directly.
  503: "Part of Proofgrove is temporarily unavailable. Try again shortly.",
  504: "Proofgrove took too long to respond. Try again shortly.",
};

export function safeMessageForStatus(status: number): string {
  return (
    DEFAULT_MESSAGES[status] ??
    (status >= 500
      ? "Proofgrove could not complete the request. Try again shortly."
      : "The request could not be completed. Try again.")
  );
}

export function errorCodeForStatus(status: number): string {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status === 422) return "VALIDATION_FAILED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 502) return "UPSTREAM_UNAVAILABLE";
  if (status === 503) return "SERVICE_UNAVAILABLE";
  if (status === 504) return "UPSTREAM_TIMEOUT";
  return status >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED";
}

export function publicApiError(status: number, requestId?: string): PublicApiErrorBody {
  return {
    error: {
      code: errorCodeForStatus(status),
      message: safeMessageForStatus(status),
      ...(requestId ? { request_id: requestId } : {}),
    },
  };
}

/** Accept only non-empty strings; trim and truncate to the given bound. */
function boundedText(value: unknown, max: number = MAX_PROBLEM_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Join a FastAPI validation `loc` path into a stable field name (drops the source segment). */
function fieldFromLoc(loc: unknown): string | undefined {
  if (!Array.isArray(loc)) return undefined;
  const parts = loc
    .filter((part) => typeof part === "string" || typeof part === "number")
    .map(String);
  const withoutSource =
    parts.length > 1 && ["body", "query", "path", "header"].includes(parts[0])
      ? parts.slice(1)
      : parts;
  return boundedText(withoutSource.join("."), MAX_PROBLEM_CODE);
}

/** Allowlist one `{code?, field?, message}` detail entry; anything else is dropped. */
function problemDetail(value: unknown): ApiErrorDetail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  const message = boundedText(entry.message);
  if (!message) return undefined;
  const code = boundedText(entry.code, MAX_PROBLEM_CODE);
  const field = boundedText(entry.field, MAX_PROBLEM_CODE);
  return { message, ...(code ? { code } : {}), ...(field ? { field } : {}) };
}

/** Map one FastAPI validation-error entry (`{loc, msg, type}`) to a bounded detail. */
function validationDetail(value: unknown): ApiErrorDetail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  const message = boundedText(entry.msg);
  if (!message) return undefined;
  const code = boundedText(entry.type, MAX_PROBLEM_CODE);
  const field = fieldFromLoc(entry.loc);
  return { message, ...(code ? { code } : {}), ...(field ? { field } : {}) };
}

function detailListSummary(details: ApiErrorDetail[]): string | undefined {
  return boundedText(
    details
      .map((detail) => (detail.field ? `${detail.field}: ${detail.message}` : detail.message))
      .join(" "),
  );
}

/**
 * Derive the bounded public problem contract from an upstream FastAPI error
 * body. Only the allowlisted fields (`code`, `field`, `message`, `recovery`,
 * `details[].{code,field,message}`) inside the standard `detail` envelope are
 * forwarded, every string is truncated, and any body that does not match the
 * expected shapes falls back to the generic status-only copy. Stack traces,
 * arbitrary keys, and raw text are never reflected.
 */
export function publicApiErrorFromUpstream(
  status: number,
  bodyText: string,
  requestId?: string,
): PublicApiErrorBody {
  const fallback = publicApiError(status, requestId);
  if (!bodyText || bodyText.length > MAX_UPSTREAM_BODY_BYTES) return fallback;

  let detail: unknown;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    detail = (parsed as Record<string, unknown>).detail;
  } catch {
    return fallback;
  }

  // Arbitrary string details are not a public contract. They may contain
  // exception text or identifiers, so only coded dictionaries and FastAPI's
  // structured validation array may cross the BFF.
  if (typeof detail === "string") return fallback;

  // Validation-error array: per-field entries with the loc path as `field`.
  if (Array.isArray(detail)) {
    const details = detail
      .slice(0, MAX_PROBLEM_DETAILS)
      .map(validationDetail)
      .filter((entry): entry is ApiErrorDetail => entry !== undefined);
    if (details.length === 0) return fallback;
    return {
      error: {
        ...fallback.error,
        message: detailListSummary(details) ?? fallback.error.message,
        details,
      },
    };
  }

  // Dict detail: coded problem ({code, message, recovery?, field?, details?}).
  if (detail && typeof detail === "object") {
    const problem = detail as Record<string, unknown>;
    const code = boundedText(problem.code, MAX_PROBLEM_CODE);
    const message = boundedText(problem.message);
    const field = boundedText(problem.field, MAX_PROBLEM_CODE);
    const recovery = boundedText(problem.recovery);
    const details = Array.isArray(problem.details)
      ? problem.details
          .slice(0, MAX_PROBLEM_DETAILS)
          .map(problemDetail)
          .filter((entry): entry is ApiErrorDetail => entry !== undefined)
      : [];
    if (!message && details.length === 0) return fallback;
    return {
      error: {
        code: code ?? fallback.error.code,
        message: message ?? detailListSummary(details) ?? fallback.error.message,
        ...(requestId ? { request_id: requestId } : {}),
        ...(field ? { field } : {}),
        ...(recovery ? { recovery } : {}),
        ...(details.length > 0 ? { details } : {}),
      },
    };
  }

  return fallback;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  /** Form control the problem refers to, when the backend names one. */
  readonly field?: string;
  /** Actionable recovery guidance, when the backend provides it. */
  readonly recovery?: string;
  /** Per-part problems (e.g. per-field validation failures); may be empty. */
  readonly details: ApiErrorDetail[];

  constructor({
    status,
    code,
    message,
    requestId,
    field,
    recovery,
    details,
  }: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    field?: string;
    recovery?: string;
    details?: ApiErrorDetail[];
  }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.field = field;
    this.recovery = recovery;
    this.details = details ?? [];
  }
}

/** Parse only the BFF's bounded public error contract; never reflect raw text. */
export function apiErrorFromResponse(status: number, body: string): ApiError {
  try {
    const parsed = JSON.parse(body) as Partial<PublicApiErrorBody>;
    const error = parsed.error;
    // Re-apply the proxy's bounds on the client so a gateway that replaces the
    // body can never surface unbounded or non-contract content.
    const code = error && typeof error === "object" ? boundedText(error.code, MAX_PROBLEM_CODE) : undefined;
    const message = error && typeof error === "object" ? boundedText(error.message) : undefined;
    if (code && message) {
      const details = Array.isArray(error?.details)
        ? error.details
            .slice(0, MAX_PROBLEM_DETAILS)
            .map(problemDetail)
            .filter((entry): entry is ApiErrorDetail => entry !== undefined)
        : [];
      return new ApiError({
        status,
        code,
        message,
        requestId:
          typeof error?.request_id === "string" ? error.request_id : undefined,
        field: boundedText(error?.field, MAX_PROBLEM_CODE),
        recovery: boundedText(error?.recovery),
        details,
      });
    }
  } catch {
    // A proxy or gateway may replace the response body. Use status-only copy.
  }

  return new ApiError({
    status,
    code: errorCodeForStatus(status),
    message: safeMessageForStatus(status),
  });
}

/**
 * Distinct failure states for the Proofgrove readiness gate. Collapsing these into
 * a single "not provisioned" panel gives the wrong recovery guidance, so each is
 * detected from a real signal (connectivity, HTTP status, or the health flag).
 */
export type ProofgroveGateState =
  | "offline"
  | "session-expired"
  | "permission-denied"
  | "service-unavailable"
  | "unprovisioned";

/**
 * Observable signals the gate can gather when probing `/api/status`:
 * - `online`: `navigator.onLine` (omit/`true` when the browser reports a connection).
 * - `networkError`: the probe `fetch` rejected (DNS/TLS/offline, no HTTP response).
 * - `status`: HTTP status when the probe responded but was not `ok`.
 * - `available`: the parsed `{ available }` health flag when the probe responded `ok`.
 */
export interface ProofgroveHealthSignal {
  online?: boolean;
  networkError?: boolean;
  status?: number;
  available?: boolean;
}

/** Map a health probe signal to the specific gate state (never a catch-all). */
export function classifyProofgroveGate(signal: ProofgroveHealthSignal): ProofgroveGateState {
  // Connectivity failures come first: there is no trustworthy HTTP signal to read.
  if (signal.online === false || signal.networkError) return "offline";

  const status = signal.status;
  if (typeof status === "number" && status >= 400) {
    if (status === 401) return "session-expired";
    if (status === 403) return "permission-denied";
    if (status === 408 || status >= 500) return "service-unavailable";
    // Any other gateway/client error is a service fault, not a missing deployment.
    return "service-unavailable";
  }

  // The probe answered cleanly and the backend is simply not deployed yet.
  return "unprovisioned";
}

export interface ProofgroveGateCopy {
  title: string;
  description: string;
  /** Whether background polling can recover this state on its own. */
  autoRecovers: boolean;
}

const PROOFGROVE_GATE_COPY: Record<ProofgroveGateState, ProofgroveGateCopy> = {
  offline: {
    title: "You appear to be offline",
    description:
      "Check your internet connection. This page will reconnect automatically once you are back online.",
    autoRecovers: true,
  },
  "session-expired": {
    title: "Your session has expired",
    description: "Sign in again to continue working with Proofgrove.",
    autoRecovers: false,
  },
  "permission-denied": {
    title: "You do not have access to Proofgrove",
    description:
      "Your account is not permitted to use this workspace's evaluation service. Ask a workspace administrator to grant you access.",
    autoRecovers: false,
  },
  "service-unavailable": {
    title: "Proofgrove is temporarily unavailable",
    description:
      "The evaluation service is not responding right now. This page will retry automatically.",
    autoRecovers: true,
  },
  unprovisioned: {
    title: "Start the local evaluation service",
    description:
      "Run the project start script to bring up the local API on port 8010. This page connects automatically when it is ready.",
    autoRecovers: true,
  },
};

/** Distinct user-facing copy and recovery guidance for each gate state. */
export function proofgroveGateCopy(state: ProofgroveGateState): ProofgroveGateCopy {
  return PROOFGROVE_GATE_COPY[state];
}

/** Render known public errors and replace every technical exception with safe copy. */
export function userFacingError(
  reason: unknown,
  fallback = "The request could not be completed. Try again.",
): string {
  if (!(reason instanceof ApiError)) return fallback;
  // Prefer the specific backend message, and append its recovery guidance when present.
  return reason.recovery ? `${reason.message} ${reason.recovery}` : reason.message;
}
