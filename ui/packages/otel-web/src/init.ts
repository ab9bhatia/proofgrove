// Browser SDK bootstrap.
//
// Everything exports same-origin to the BFF relay (ADR-26-08-12); the browser
// never addresses `evalai-collector` directly. Initialisation is idempotent and
// silent when disabled — a UI must never fail to render because observability
// is misconfigured.
//
// Several defaults in the OTel browser SDK are wrong for this pipeline and are
// overridden below. Each override has a comment saying why, because they all
// look like gratuitous configuration until you know what the default does.

import { metrics } from "@opentelemetry/api";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import {
  AggregationTemporalityPreference,
  OTLPMetricExporter,
} from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";

import {
  ATTR_CTX_APP,
  ATTR_CTX_EMITTER_APP,
  ATTR_DEPLOYMENT_ENVIRONMENT,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "./attributes";
import type { TelemetryClientConfig } from "./config";
import { registerErrorCapture } from "./errors";
import { makeRouteMatcher } from "./routes";
import { registerPageLoadTime, registerWebVitals } from "./web-vitals";

/** Vitals are flushed on this cadence; page-hide forces an immediate flush. */
const METRIC_EXPORT_INTERVAL_MS = 15_000;

/**
 * Span batching.
 *
 * The SDK default is 512 spans per export, which exceeds the relay's per-batch
 * ceiling and, at ~500 B/span, also exceeds the 60 KB above which browsers
 * refuse `keepalive` — so a default-configured client would lose its entire
 * document-load trace on every page view.
 */
const MAX_EXPORT_BATCH_SIZE = 100;
const MAX_QUEUE_SIZE = 1000;
const SCHEDULED_DELAY_MS = 5_000;

const INSTRUMENTATION_SCOPE = "@evalai/otel-web";

let started = false;

export interface InitOptions {
  config: TelemetryClientConfig;
  /** Next App Router templates for this app, used to bound route labels. */
  routeTemplates: readonly string[];
}

/** Ephemeral per-tab identifier. Not persisted, not a user identity. */
function newSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "";
}

/**
 * Initialise browser telemetry. Safe to call more than once.
 *
 * Returns a teardown function, or `undefined` when telemetry is disabled or
 * the environment is not a browser (Next renders components on the server
 * first, and this module must be inert there).
 */
export function initTelemetry(options: InitOptions): (() => void) | undefined {
  const { config, routeTemplates } = options;

  if (!config.enabled) return undefined;
  if (typeof window === "undefined") return undefined;
  if (started) return undefined;
  started = true;

  const resolveRoute = (() => {
    const match = makeRouteMatcher(routeTemplates);
    return () => match(window.location.pathname);
  })();

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    [ATTR_DEPLOYMENT_ENVIRONMENT]: config.environment,
    [ATTR_CTX_APP]: config.app,
    [ATTR_CTX_EMITTER_APP]: "evalai",
  });

  const ingest = config.ingestPath.replace(/\/$/, "");
  // `ignoreUrls` is matched against the *absolute* href the fetch
  // instrumentation resolves, so an origin-relative anchored pattern can never
  // match. Without this the exporter's own POST is traced, and each export
  // produces spans that produce another export.
  const ingestPattern = new RegExp(
    `${escapeRegExp(window.location.origin + ingest)}`,
  );

  const tracerProvider = new WebTracerProvider({
    resource,
    // Head sampling in the browser also decides the fate of the *backend*
    // trace, because an unsampled parent propagates `sampled=0` and both the Go
    // and Python SDKs default to ParentBased. Sample at the collector instead,
    // where the decision is trace-consistent.
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.traceSampleRatio),
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${ingest}/v1/traces` }),
        {
          maxExportBatchSize: MAX_EXPORT_BATCH_SIZE,
          maxQueueSize: MAX_QUEUE_SIZE,
          scheduledDelayMillis: SCHEDULED_DELAY_MS,
        },
      ),
    ],
  });
  tracerProvider.register();

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${ingest}/v1/metrics`,
          // The SDK default is CUMULATIVE, which re-transmits every attribute
          // set the tab has ever recorded on every export — unbounded growth
          // for a per-GB-billed backend. It is also wrong semantically: many
          // independent browsers would publish colliding cumulative streams
          // into one series.
          temporalityPreference: AggregationTemporalityPreference.DELTA,
        }),
        exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const unregisterInstrumentations = registerInstrumentations({
    instrumentations: [
      new DocumentLoadInstrumentation({
        // Network events stay ON: they are the DOM lifecycle timings
        // (domInteractive, domComplete, loadEvent*) and the per-resource
        // request phases — i.e. exactly the "resource timing" the acceptance
        // criteria require. Suppressing them halves span size but guts the
        // signal, so the cost is absorbed by the batch limits instead.
        ignoreNetworkEvents: false,
        // Paint events are the one safe omission: they report FCP, which is
        // already emitted as a metric by web-vitals with better fidelity.
        ignorePerformancePaintEvents: true,
      }),
      new FetchInstrumentation({ ignoreUrls: [ingestPattern] }),
    ],
  });

  const meter = metrics.getMeter(INSTRUMENTATION_SCOPE);
  registerWebVitals({ meter, resolveRoute });
  registerPageLoadTime({ meter, resolveRoute });

  const teardownErrors = registerErrorCapture({
    ingestPath: ingest,
    resolveRoute,
    sessionId: newSessionId(),
  });

  // INP and CLS are only final at page-hide. `visibilitychange → hidden` is the
  // reliable terminal event (bfcache, iOS Safari, tab discard); `pagehide` does
  // not fire in every one of those paths. The browser BatchSpanProcessor
  // already registers both for traces, so only metrics need this.
  const flushMetrics = (): void => {
    void meterProvider.forceFlush().catch(() => undefined);
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") flushMetrics();
  };
  window.addEventListener("pagehide", flushMetrics);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    window.removeEventListener("pagehide", flushMetrics);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    teardownErrors();
    unregisterInstrumentations();
    void meterProvider.shutdown().catch(() => undefined);
    void tracerProvider.shutdown().catch(() => undefined);
    started = false;
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
