// Attribute keys defined by ADR-26-05-19 (Full Platform Observability), as
// consumed from the browser. This is the TypeScript mirror of
// `libs/evalai-otel-go/attributes.go` and
// `libs/evalai-otel/src/evalai_otel/_attributes.py` — use these constants,
// never string literals, so a typo in one app can't silently split dashboards.
//
// Trust model: everything a browser sends is a claim. Two controls follow from
// that, and both are allowlists rather than denylists — a denylist forwards
// every key nobody thought to enumerate, including ones a future OTel release
// introduces.
//
//  * Resource attributes are not filtered at all: the relay **discards** the
//    browser's resource and synthesises its own, because it already knows every
//    legitimate value from its own environment.
//  * Record attributes (span, data point, event, link) are filtered against
//    `ALLOWED_RECORD_ATTRIBUTES` and individually validated.

// Resource attributes — set by the relay, never accepted from a browser.
export const ATTR_SERVICE_NAME = "service.name";
export const ATTR_SERVICE_VERSION = "service.version";
export const ATTR_DEPLOYMENT_ENVIRONMENT = "deployment.environment";
export const ATTR_CTX_EMITTER_APP = "ctx.emitter_app";
export const ATTR_CTX_APP = "ctx.app";
export const ATTR_CTX_TENANT = "ctx.tenant";

// Pseudonymised end-user identity. Computed at the relay from the
// gateway-asserted subject and a per-tenant salt — never sent by the browser,
// and never attached to metrics, where it would be unbounded cardinality.
//
// The key is OTel's `user.hash`, canonical since the 2026-07-16 amendment to
// ADR-26-05-19; `enduser.id_hash` is a deprecated alias that new emitters must
// not extend. The Go/Python libs still emit the alias pending their own
// migration, and the amendment directs queries to treat both as equivalent
// until then.
export const ATTR_USER_HASH = "user.hash";

// Signal attributes attached per record.
export const ATTR_HTTP_ROUTE = "http.route";
export const ATTR_EVENT_NAME = "event.name";
export const ATTR_ERROR_TYPE = "error.type";
export const ATTR_URL_FULL = "url.full";
export const ATTR_USER_AGENT_ORIGINAL = "user_agent.original";

// Browser-specific extensions introduced by
// ADR-26-08-12 (Frontend RUM Ingest via the UI Backend-for-Frontend).
export const ATTR_BROWSER_VITAL_RATING = "browser.vital.rating";
export const ATTR_BROWSER_SESSION_ID = "session.id";
export const ATTR_BROWSER_NAVIGATION_TYPE = "browser.navigation.type";

// Derived server-side from the request's User-Agent header, never accepted
// from the browser as an attribute. Bounded, low-entropy replacements for
// `user_agent.original`, which is a fingerprinting vector.
export const ATTR_BROWSER_NAME = "browser.name";
export const ATTR_BROWSER_VERSION = "browser.version";
export const ATTR_BROWSER_MOBILE = "browser.mobile";

// Metric names. Prefixed `browser.` so RUM series are trivially separable from
// backend series in both PromQL and Kusto.
export const METRIC_WEB_VITAL_LCP = "browser.web_vitals.lcp";
export const METRIC_WEB_VITAL_INP = "browser.web_vitals.inp";
export const METRIC_WEB_VITAL_CLS = "browser.web_vitals.cls";
export const METRIC_WEB_VITAL_TTFB = "browser.web_vitals.ttfb";
export const METRIC_WEB_VITAL_FCP = "browser.web_vitals.fcp";
export const METRIC_PAGE_LOAD_TIME = "browser.page.load_time";

/** The `event.name` value on every client-side error record. */
export const EVENT_BROWSER_ERROR = "browser.error";

/**
 * Metric names the relay will forward. Anything else is dropped.
 *
 * Metric names become series names; an unvalidated name is unbounded
 * cardinality with a browser holding the pen.
 */
export const ALLOWED_METRIC_NAMES: ReadonlySet<string> = new Set([
  METRIC_WEB_VITAL_LCP,
  METRIC_WEB_VITAL_INP,
  METRIC_WEB_VITAL_CLS,
  METRIC_WEB_VITAL_TTFB,
  METRIC_WEB_VITAL_FCP,
  METRIC_PAGE_LOAD_TIME,
]);

/**
 * Record-level attribute keys the relay will forward.
 *
 * Everything the OTel browser instrumentations legitimately emit and nothing
 * else. `user_agent.original` is deliberately absent — it is replaced by the
 * server-derived `browser.*` fields. `url.full` is present but rewritten (query
 * string and fragment discarded) before it is forwarded.
 */
export const ALLOWED_RECORD_ATTRIBUTES: ReadonlySet<string> = new Set([
  ATTR_HTTP_ROUTE,
  ATTR_URL_FULL,
  ATTR_ERROR_TYPE,
  ATTR_EVENT_NAME,
  ATTR_BROWSER_VITAL_RATING,
  ATTR_BROWSER_NAVIGATION_TYPE,
  "http.request.method",
  "http.response.status_code",
  "url.scheme",
  "server.address",
  "server.port",
]);

/** Bounded value sets. Anything outside these is dropped, not passed through. */
export const ALLOWED_VITAL_RATINGS: ReadonlySet<string> = new Set([
  "good",
  "needs-improvement",
  "poor",
]);

export const ALLOWED_NAVIGATION_TYPES: ReadonlySet<string> = new Set([
  "navigate",
  "reload",
  "back-forward",
  "back-forward-cache",
  "prerender",
  "restore",
  "soft-navigation",
]);
