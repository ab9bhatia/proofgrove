// Client-side error capture.
//
// Errors do not travel as OTLP. `evalai-collector` declares only `metrics` and
// `traces` pipelines, so there is nowhere for a browser log record to go.
// Instead the browser posts errors to the BFF, which writes them to stdout
// where the node OTel agent collects them into Log Analytics — the same path
// every backend service already uses, including its redaction stage.
//
// Delivery uses `sendBeacon` where available: an error frequently precedes a
// navigation or a tab close, and a normal fetch would be cancelled.

import { sanitizeMessage, sanitizeStack, sanitizeErrorType } from "./sanitize";

export interface ErrorCaptureOptions {
  /** Same-origin ingest base, e.g. `/api/telemetry`. */
  ingestPath: string;
  /** Resolves the current pathname to a bounded route template. */
  resolveRoute: () => string;
  /** Ephemeral per-tab identifier. Never a user identity. */
  sessionId: string;
  /** Max errors reported per page life-cycle, to bound a render loop. */
  maxPerPage?: number;
}

const DEFAULT_MAX_PER_PAGE = 10;

interface QueuedError {
  name: string;
  message: string;
  stack: string;
  route: string;
  sessionId: string;
  traceId?: string;
}

/**
 * Install `error` and `unhandledrejection` listeners.
 *
 * Returns a teardown function. A render loop that throws on every frame would
 * otherwise turn one bug into unbounded ingestion cost, so reporting stops
 * after `maxPerPage` errors — the first few are what matter for triage.
 */
export function registerErrorCapture(options: ErrorCaptureOptions): () => void {
  const {
    ingestPath,
    resolveRoute,
    sessionId,
    maxPerPage = DEFAULT_MAX_PER_PAGE,
  } = options;

  let reported = 0;
  const queue: QueuedError[] = [];

  const send = (): void => {
    if (queue.length === 0) return;
    const body = JSON.stringify({ errors: queue.splice(0, queue.length) });
    const url = `${ingestPath}/v1/errors`;

    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) return;
    }
    void fetch(url, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      keepalive: true,
    }).catch(() => {
      // Telemetry delivery must never surface to the user.
    });
  };

  const capture = (raw: unknown): void => {
    if (reported >= maxPerPage) return;
    reported++;
    queue.push({
      name: sanitizeErrorType(raw),
      message: sanitizeMessage(
        raw instanceof Error ? raw.message : raw,
      ),
      stack: sanitizeStack(raw instanceof Error ? raw.stack : undefined),
      route: resolveRoute(),
      sessionId,
    });
    send();
  };

  const onError = (event: ErrorEvent): void => {
    capture(event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    capture(event.reason);
  };
  const onPageHide = (): void => send();

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("pagehide", onPageHide);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("pagehide", onPageHide);
  };
}
