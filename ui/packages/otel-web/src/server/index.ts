// Server-only entry point. Importing this from a client component pulls Node
// APIs into the browser bundle — use `@evalai/otel-web` for client code.

export {
  createTelemetryHandler,
  isSameOrigin,
  tenantFromNamespace,
  ENV_APP_VERSION,
  ENV_COLLECTOR_ENDPOINT,
  ENV_ENVIRONMENT,
  ENV_POD_NAMESPACE,
  ENV_RUM_ENABLED,
  type TelemetryHandlerOptions,
} from "./route-handler";

export {
  DEFAULT_INGEST_LIMITS,
  INGEST_SIGNALS,
  buildResource,
  guardPayload,
  sanitizeUrl,
  type BrowserInfo,
  type ClampReport,
  type GuardResult,
  type IngestLimits,
  type IngestSignal,
  type RelayContext,
} from "./guard";

export { UNKNOWN_BROWSER, parseUserAgent } from "./user-agent";
