// Core Web Vitals as OTLP metrics.
//
// OpenTelemetry's browser auto-instrumentation reports document-load and
// resource timing but does not compute LCP, INP, or CLS — those need the
// `web-vitals` library, which implements the same definitions Chrome reports.
//
// Vitals are histograms because the questions asked of them are distributional
// ("p75 LCP for this route") and Google's thresholds are defined on the 75th
// percentile. Two things matter for that to actually work:
//
//  * **Explicit buckets.** The SDK default is [0, 5, …, 10000], which puts
//    every CLS value (0–1) in a single bucket, making p75 CLS uncomputable, and
//    straddles the LCP and FCP thresholds. Each vital gets boundaries placed on
//    its own good/needs-improvement/poor thresholds.
//  * **Bounded labels.** Per ADR-26-05-19 only the route template and a folded
//    navigation type are attached. The vital's *rating* is deliberately not a
//    label: it is a pure function of the value being bucketed, so it would
//    triple the series count while adding nothing a Grafana threshold can't
//    derive.

import type { Meter } from "@opentelemetry/api";
import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from "web-vitals";
import {
  ATTR_BROWSER_NAVIGATION_TYPE,
  ATTR_HTTP_ROUTE,
  METRIC_PAGE_LOAD_TIME,
  METRIC_WEB_VITAL_CLS,
  METRIC_WEB_VITAL_FCP,
  METRIC_WEB_VITAL_INP,
  METRIC_WEB_VITAL_LCP,
  METRIC_WEB_VITAL_TTFB,
} from "./attributes";

interface VitalSpec {
  metric: string;
  unit: string;
  boundaries: number[];
}

/**
 * Bucket boundaries straddle each vital's published good / needs-improvement /
 * poor thresholds so a percentile lands meaningfully either side of them.
 */
const VITAL_SPECS: Record<string, VitalSpec> = {
  LCP: {
    metric: METRIC_WEB_VITAL_LCP,
    unit: "ms",
    boundaries: [500, 1000, 1800, 2500, 3000, 4000, 6000, 8000, 12000],
  },
  FCP: {
    metric: METRIC_WEB_VITAL_FCP,
    unit: "ms",
    boundaries: [500, 1000, 1800, 2500, 3000, 4000, 6000, 8000, 12000],
  },
  INP: {
    metric: METRIC_WEB_VITAL_INP,
    unit: "ms",
    boundaries: [50, 100, 200, 300, 500, 750, 1000, 2000],
  },
  TTFB: {
    metric: METRIC_WEB_VITAL_TTFB,
    unit: "ms",
    boundaries: [100, 200, 400, 600, 800, 1200, 1800, 3000],
  },
  CLS: {
    // Unitless layout-shift ratio, thresholds at 0.1 and 0.25.
    metric: METRIC_WEB_VITAL_CLS,
    unit: "1",
    boundaries: [0.01, 0.05, 0.1, 0.15, 0.25, 0.4, 0.6, 1],
  },
};

/** Fold web-vitals' navigation types into four, to bound the label. */
export function foldNavigationType(raw: string): string {
  if (raw === "navigate" || raw === "reload") return raw;
  // The Navigation Timing API spells this `back_forward`; web-vitals spells it
  // `back-forward`. Both reach this function, so both must fold to one label.
  if (
    raw === "back-forward" ||
    raw === "back_forward" ||
    raw === "back-forward-cache"
  ) {
    return "back-forward";
  }
  return "prerender";
}

/**
 * Page load time: navigation start to the load event completing.
 *
 * Required by the story alongside the Core Web Vitals. It is not a web vital
 * and `web-vitals` does not report it, so it is read from the Navigation
 * Timing API. Kept as a separate metric rather than inferred from the
 * document-load span duration, because the acceptance criteria ask for it as a
 * captured measure and a metric survives trace sampling.
 */
export function registerPageLoadTime(options: WebVitalsOptions): void {
  const { meter, resolveRoute } = options;

  const histogram = meter.createHistogram(METRIC_PAGE_LOAD_TIME, {
    unit: "ms",
    description: "Navigation start to load event end, reported by the browser",
    advice: {
      explicitBucketBoundaries: [
        250, 500, 1000, 2000, 3000, 5000, 8000, 12000, 20000,
      ],
    },
  });

  const record = (): void => {
    const [nav] = performance.getEntriesByType(
      "navigation",
    ) as PerformanceNavigationTiming[];
    // `loadEventEnd` is 0 until the load event has finished; recording then
    // would report a negative duration.
    if (!nav || nav.loadEventEnd === 0) return;
    histogram.record(nav.loadEventEnd - nav.startTime, {
      [ATTR_HTTP_ROUTE]: resolveRoute(),
      [ATTR_BROWSER_NAVIGATION_TYPE]: foldNavigationType(nav.type),
    });
  };

  if (document.readyState === "complete") {
    record();
    return;
  }
  // `load` fires before `loadEventEnd` is written, so yield a task first.
  window.addEventListener(
    "load",
    () => {
      setTimeout(record, 0);
    },
    { once: true },
  );
}

export interface WebVitalsOptions {
  meter: Meter;
  /** Resolves the current pathname to a bounded route template. */
  resolveRoute: () => string;
}

/**
 * Subscribe to Core Web Vitals and record each as a histogram observation.
 *
 * `web-vitals` fires each callback at most once per page life-cycle (INP and
 * CLS on visibility change), so no debouncing is needed. The route is resolved
 * at emit time rather than at subscribe time, because a client-side navigation
 * may have happened in between.
 */
export function registerWebVitals(options: WebVitalsOptions): void {
  const { meter, resolveRoute } = options;

  const histograms = new Map<string, ReturnType<Meter["createHistogram"]>>();
  for (const [vital, spec] of Object.entries(VITAL_SPECS)) {
    histograms.set(
      vital,
      meter.createHistogram(spec.metric, {
        unit: spec.unit,
        description: `Core Web Vital ${vital} reported by the browser`,
        advice: { explicitBucketBoundaries: spec.boundaries },
      }),
    );
  }

  const record = (metric: Metric): void => {
    const histogram = histograms.get(metric.name);
    if (!histogram) return;
    histogram.record(metric.value, {
      [ATTR_HTTP_ROUTE]: resolveRoute(),
      [ATTR_BROWSER_NAVIGATION_TYPE]: foldNavigationType(metric.navigationType),
    });
  };

  onLCP(record);
  onINP(record);
  onCLS(record);
  onFCP(record);
  onTTFB(record);
}
