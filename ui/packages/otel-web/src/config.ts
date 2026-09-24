// Telemetry configuration shared by the browser SDK and the BFF route handler.
//
// The browser never reads environment variables. Next inlines NEXT_PUBLIC_*
// at build time, which cannot express a per-environment toggle for a single
// shared image, so the config is resolved server-side (in a layout or page)
// and handed to the client provider as props. `resolveTelemetryConfig` is the
// server-side half; `TelemetryClientConfig` is the serialisable subset that is
// safe to send to a browser.

/** Config handed to the browser. Everything here becomes public — keep it dull. */
export interface TelemetryClientConfig {
  /** Master switch. When false the SDK never initialises. */
  enabled: boolean;
  /** `service.name` for the app, e.g. `evalai-agent-ui`. */
  serviceName: string;
  /** Release identifier, normally the git SHA. */
  serviceVersion: string;
  /** `deployment.environment`, e.g. `local`, `dev`, `prod`. */
  environment: string;
  /** `ctx.app` — the Proofgrove application that triggered the signal. */
  app: string;
  /** Same-origin base path of the BFF telemetry relay. */
  ingestPath: string;
  /** Fraction of traces sampled, 0..1. Vitals and errors ignore this. */
  traceSampleRatio: number;
}

/** Environment variable names read by `resolveTelemetryConfig`. */
export const ENV_RUM_ENABLED = "EVALAI_RUM_ENABLED";
export const ENV_ENVIRONMENT = "DEPLOYMENT_ENVIRONMENT";
export const ENV_APP_VERSION = "APP_VERSION";
export const ENV_TRACE_SAMPLE_RATIO = "EVALAI_RUM_TRACE_SAMPLE_RATIO";

/** Default relay path. Mirrored by the route handler's file location. */
export const DEFAULT_INGEST_PATH = "/api/telemetry";

/**
 * Browser traces are sampled in full by default and thinned at the collector.
 *
 * Head sampling here is not a local decision: an unsampled browser span still
 * propagates `traceparent` with `sampled=0`, and the Go and Python SDKs both
 * default to a parent-based sampler — so dropping 90% in the browser would also
 * drop 90% of the *backend* traces those requests produce.
 */
const DEFAULT_TRACE_SAMPLE_RATIO = 1.0;

function parseRatio(raw: string | undefined): number {
  if (!raw) return DEFAULT_TRACE_SAMPLE_RATIO;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_TRACE_SAMPLE_RATIO;
  }
  return parsed;
}

/**
 * Build the browser config from server-side environment.
 *
 * Call this in a server component and pass the result to `TelemetryProvider`.
 * Telemetry is opt-in: absent or unrecognised `EVALAI_RUM_ENABLED` means off,
 * so a misconfigured environment stays silent rather than shipping data
 * somewhere unintended.
 */
export function resolveTelemetryConfig(
  serviceName: string,
  app: string,
  env: NodeJS.ProcessEnv = process.env,
): TelemetryClientConfig {
  return {
    enabled: (env[ENV_RUM_ENABLED] ?? "").toLowerCase() === "true",
    serviceName,
    app,
    serviceVersion: env[ENV_APP_VERSION] ?? "unknown",
    environment: env[ENV_ENVIRONMENT] ?? "unknown",
    ingestPath: DEFAULT_INGEST_PATH,
    traceSampleRatio: parseRatio(env[ENV_TRACE_SAMPLE_RATIO]),
  };
}
