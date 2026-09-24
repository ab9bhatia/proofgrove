"use client";

import { useCallback, useEffect, useState } from "react";
import {
  FlaskConical,
  LogIn,
  ServerCrash,
  ShieldAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react";

import {
  classifyEvalHubGate,
  evalHubGateCopy,
  type EvalHubGateState,
} from "@/lib/api-errors";

type State = "checking" | "up" | EvalHubGateState;

const POLL_MS = 5000;

const STATE_ICON: Record<EvalHubGateState, LucideIcon> = {
  offline: WifiOff,
  "session-expired": LogIn,
  "permission-denied": ShieldAlert,
  "service-unavailable": ServerCrash,
  unprovisioned: FlaskConical,
};

/**
 * Probe `/api/status` once and resolve to the gate state it implies. Returns
 * `"up"` only when the backend reports itself available; every failure resolves
 * to the specific {@link EvalHubGateState} for its signal. Kept side-effect free
 * so callers only ever `setState` after awaiting (never synchronously).
 */
async function probeEvalHub(): Promise<"up" | EvalHubGateState> {
  // No point probing when the browser already knows it is offline.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return classifyEvalHubGate({ online: false });
  }

  let res: Response;
  try {
    res = await fetch("/api/status", { cache: "no-store" });
  } catch {
    // fetch only rejects on connectivity failures, not on HTTP error codes.
    return classifyEvalHubGate({ networkError: true });
  }

  if (!res.ok) {
    return classifyEvalHubGate({ status: res.status });
  }

  try {
    const body = (await res.json()) as { available?: boolean };
    if (body.available === true) return "up";
    return classifyEvalHubGate({ available: false });
  } catch {
    return classifyEvalHubGate({ status: 502 });
  }
}

/**
 * Gates functional pages on Proofgrove backend reachability. The backend is
 * provisioned on demand, so until it exists this shows a calm "not enabled yet"
 * panel and polls /api/status; the moment the backend is reachable it mounts the
 * wrapped content (which then loads against a live backend). Wrap page content
 * so the page's own data-loading only runs once the backend is up.
 *
 * Failures are not all the same: a dropped connection, an expired session, a
 * denied permission, a service outage, and a genuinely undeployed backend each
 * need different recovery guidance. We branch on the real signal (connectivity,
 * HTTP status, or the health flag) via {@link classifyEvalHubGate} rather than
 * collapsing everything into "not provisioned".
 */
export function EvalHubGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>("checking");

  // setState lives in the `.then` callback (deferred), never synchronously in
  // the effect body, so the readiness poll does not trigger cascading renders.
  const check = useCallback(() => probeEvalHub().then(setState), []);

  useEffect(() => {
    check();
  }, [check]);

  // Recovery poll: schedule the next probe only after the current one settles
  // (never a fixed interval that could overlap slow probes), and abort any
  // in-flight/pending probe on cleanup so a stale result can't set state.
  useEffect(() => {
    if (state === "up") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      void probeEvalHub().then((next) => {
        if (cancelled) return;
        setState(next);
        timer = setTimeout(tick, POLL_MS);
      });
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [state]);

  const retry = useCallback(() => {
    setState("checking");
    check();
  }, [check]);

  const signInAgain = useCallback(() => {
    // Re-trigger the upstream auth flow: reloading the current location makes
    // the auth proxy redirect an unauthenticated request to sign-in and back
    // to this same page, preserving the return URL.
    window.location.assign(window.location.href);
  }, []);

  if (state === "up") return <>{children}</>;

  if (state === "checking") {
    return (
      <div className="panel mx-auto flex w-full min-w-0 max-w-lg flex-col items-center justify-center gap-4 px-6 py-16 text-center sm:px-8">
        <FlaskConical className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="max-w-full break-words text-sm text-muted-foreground"
        >
          Connecting to Proofgrove…
        </p>
      </div>
    );
  }

  return <EvalHubGatePanel state={state} onRetry={retry} onSignInAgain={signInAgain} />;
}

/**
 * Presentational gate panel for a non-recoverable-yet state. Exported for tests.
 *
 * Mobile-safe by construction: the container never exceeds the viewport
 * (`w-full min-w-0 max-w-lg` with horizontal padding), all copy wraps
 * (`break-words`), and the action buttons stack vertically at small widths and
 * only sit side by side from `sm:` up — no horizontal overflow at 390px.
 */
export function EvalHubGatePanel({
  state,
  onRetry,
  onSignInAgain,
}: {
  state: EvalHubGateState;
  onRetry: () => void;
  onSignInAgain: () => void;
}) {
  const copy = evalHubGateCopy(state);
  const Icon = STATE_ICON[state];

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-lg flex-col items-center justify-center gap-4 px-4 py-24 text-center sm:px-6">
      <Icon className="h-10 w-10 shrink-0 text-muted-foreground" aria-hidden="true" />
      <h2 className="max-w-full break-words font-display text-2xl font-semibold tracking-tight">{copy.title}</h2>
      <p className="max-w-full break-words text-sm text-muted-foreground">{copy.description}</p>
      {copy.autoRecovers ? (
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="flex max-w-full flex-wrap items-center justify-center gap-2 break-words text-xs text-muted-foreground"
        >
          <span
            className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted border-t-evalai-green"
            aria-hidden="true"
          />
          Checking for the service…
        </p>
      ) : (
        <>
          <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {copy.title}
          </p>
          <div className="flex w-full min-w-0 max-w-full flex-col items-stretch justify-center gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
            {state === "session-expired" ? (
              <button
                type="button"
                onClick={onSignInAgain}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-foreground shadow-sm transition-[filter,transform] duration-150 hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <LogIn className="size-4" aria-hidden="true" />
                Sign in again
              </button>
            ) : null}
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-card px-4 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Retry
            </button>
          </div>
        </>
      )}
    </div>
  );
}
