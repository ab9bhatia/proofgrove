// Client-safe entry point for `@evalai/otel-web`.
//
// This barrel deliberately does **not** re-export `./init`, `./web-vitals`, or
// `./errors`. Those pull in the OpenTelemetry browser SDK, and a static
// re-export here would drag ~46 KB gzipped into the bundle of every consumer
// that imports anything from this package — defeating the dynamic import in
// `TelemetryProvider` that keeps the SDK off the critical path. `init` is
// reached only through the provider.
//
// The BFF route-handler factory lives at `@evalai/otel-web/server` so server
// code never leaks into a browser bundle.

export * from "./attributes";

export {
  DEFAULT_INGEST_PATH,
  ENV_APP_VERSION,
  ENV_ENVIRONMENT,
  ENV_RUM_ENABLED,
  ENV_TRACE_SAMPLE_RATIO,
  resolveTelemetryConfig,
  type TelemetryClientConfig,
} from "./config";

export {
  INVALID_ROUTE,
  UNMATCHED_ROUTE,
  compileRoutes,
  makeRouteMatcher,
} from "./routes";

export {
  MAX_MESSAGE_CHARS,
  MAX_STACK_CHARS,
  MAX_STACK_FRAMES,
  sanitizeErrorType,
  sanitizeMessage,
  sanitizeStack,
} from "./sanitize";

export {
  TelemetryProvider,
  type TelemetryProviderProps,
} from "./provider";
