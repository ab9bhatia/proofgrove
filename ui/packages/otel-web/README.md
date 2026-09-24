# `@evalai/otel-web`

Real-user monitoring for the Proofgrove UIs: Core Web Vitals, browser traces, and
client-side error capture, exported through the app's own backend-for-frontend.

Design intent and the reasoning behind the ingest path live in
[ADR-26-08-12-frontend-rum-ingest-via-bff](../../../../docs/adr/ADR-26-08-12-frontend-rum-ingest-via-bff.md),
which extends [ADR-26-05-19-full-platform-observability](../../../../docs/adr/ADR-26-05-19-full-platform-observability.md).

## How telemetry leaves the browser

```text
browser ──same-origin POST──▶ /api/telemetry/v1/{traces,metrics,errors}
                                       │  (Next route handler, this package)
                                       ├─ traces, metrics ──OTLP──▶ evalai-collector
                                       └─ errors ──structured JSON on stdout──▶ OTel agent
```

The browser never addresses `evalai-collector` directly. It cannot: the
collector is in-cluster and the Azure backends behind it are private-link only.
Relaying through the BFF means the telemetry POST inherits the app's existing
OIDC and `ext_authz` chain, needs no CORS, and — because the collector's
`k8sattributes` processor reads the *relay pod's* namespace — yields a tenant
attribution the browser cannot forge.

Client errors take the stdout path rather than OTLP because `evalai-collector`
declares only `metrics` and `traces` pipelines. Writing them to stdout puts
them on the same route every backend service already uses.

Be precise about what that inherits. The node agent reads container output
without a JSON parser, so a structured line arrives as a **string body**: the
body-pattern redaction of
[ADR-26-07-21](../../../../docs/adr/ADR-26-07-21-log-redaction-at-otel-agent.md)
applies to it, but the attribute-keyed redaction and salted identity hashing do
not. `sanitize.ts` is therefore a primary control here, not defence in depth.

## Wiring an app

**1. Route handler** — `app/api/telemetry/[...signal]/route.ts`:

```ts
import { createTelemetryHandler } from "@evalai/otel-web/server";
import { ROUTE_TEMPLATES } from "@/lib/route-templates";

export const POST = createTelemetryHandler({
  serviceName: "evalai-agent-ui",
  app: "evalai",
  // Required: the relay validates every client-supplied `http.route` against
  // this list. Client-side matching is a convenience, not a control.
  routeTemplates: ROUTE_TEMPLATES,
});
```

**2. Provider** — in the root layout (a server component), resolve config
server-side and hand it to the client provider:

```tsx
import { TelemetryProvider, resolveTelemetryConfig } from "@evalai/otel-web";
import { ROUTE_TEMPLATES } from "@/lib/route-templates";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const telemetry = resolveTelemetryConfig("evalai-agent-ui", "evalai");
  return (
    <html>
      <body>
        <TelemetryProvider config={telemetry} routeTemplates={ROUTE_TEMPLATES} />
        {children}
      </body>
    </html>
  );
}
```

**3. Transpile** — add the package to `next.config.ts`:

```ts
transpilePackages: ["@evalai/shared", "@evalai/otel-web"],
```

Config is resolved server-side rather than through `NEXT_PUBLIC_*` because
those are inlined at build time and cannot express a per-environment toggle for
one shared image.

## Configuration

Read from the pod environment, injected by the tenant-operator.

| Variable | Purpose |
|---|---|
| `EVALAI_RUM_ENABLED` | Master switch. Anything but `true` disables telemetry. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL. Absent means the relay is inert. |
| `DEPLOYMENT_ENVIRONMENT` | `deployment.environment` label. |
| `APP_VERSION` | `service.version`, normally the git SHA. |
| `EVALAI_RUM_TRACE_SAMPLE_RATIO` | Trace sample ratio, `0`–`1`. Defaults to `1.0` — see below before lowering it. |
| `POD_NAMESPACE` | Source of the trusted `ctx.tenant`. |

Both switches fail closed: telemetry is off unless `EVALAI_RUM_ENABLED=true`,
and a missing collector endpoint makes the relay refuse rather than forward.

### Where those values come from

Nothing here is set by hand on a pod. The toggle is GitOps-managed and flows:

```text
gitops/<env>/values-env.yaml     observability.rum.enabled
                                 observability.environmentName
  └─▶ platform chart             templates/tenant-operator.yaml
        └─▶ tenant-operator      RUM_ENABLED / RUM_COLLECTOR_ENDPOINT
                                 DEPLOYMENT_ENVIRONMENT
              └─▶ tenant UI pod  EVALAI_RUM_ENABLED / OTEL_EXPORTER_OTLP_ENDPOINT
                                 DEPLOYMENT_ENVIRONMENT / POD_NAMESPACE
```

To enable RUM in an environment, set `observability.rum.enabled: true` in that
environment's `values-env.yaml`. It is currently **on for `local` only**; cloud
environments stay off until they have an Azure Monitor daily ingestion cap and
a gateway rate limit on the ingest route (ADR-26-08-12 follow-ups 6 and 7),
because browser telemetry is authenticated but attacker-influenced and Azure
Monitor bills per GB.

`POD_NAMESPACE` is injected by the operator through the downward API, not as a
literal — it is what the relay derives the trusted `ctx.tenant` from.

`APP_VERSION` is not yet injected: tenant workload images are deployed as
`:latest`, so there is no release identifier to stamp. `service.version` reads
`unknown` until SHA-based deploys land.

**Do not lower the trace sample ratio to save cost.** Head sampling in the
browser is not a local decision: an unsampled span still propagates
`traceparent` with `sampled=0`, and the Go and Python SDKs default to a
parent-based sampler — so sampling at 10% here also discards 90% of the
*backend* traces those requests generate. Sample at the collector instead.

## Trust model

Everything a browser sends is a claim, including from an authenticated session.
Two controls follow, and both are allowlists:

- **The resource is synthesised, never accepted.** The relay discards the
  client's resource entirely and builds its own from pod environment —
  `service.name`, `service.version`, `deployment.environment`, `ctx.app`,
  `ctx.tenant`. There is no path by which a client value survives, so a browser
  cannot assert another tenant's identity.
- **Record attributes are allowlisted** (`ALLOWED_RECORD_ATTRIBUTES`), with
  per-key validation: `http.route` is matched against the app's real templates,
  `url.full` has its query string and fragment discarded, and enum-valued
  attributes must be members of a fixed set. Nested attribute values are
  rejected outright because they can hide disallowed keys a level down.

Metric names are allowlisted too — an unvalidated metric name is an unbounded
series with a browser holding the pen.

## What is deliberately not collected

**No raw user identity.** `user.hash` (OTel's canonical key for the hashed
end-user id, per the 2026-07-16 amendment to ADR-26-05-19) *is* emitted, but
only as a salted
SHA-256 computed at the relay from the gateway-asserted `x-evalai-sub` header —
never from anything the browser sends. The salt is per-tenant, generated once by
the operator, so the same person hashes differently in two tenants. Without a
salt the attribute is omitted entirely rather than emitted unsalted, which
ADR-26-07-21 classifies as a raw identity leak. It is attached to traces and
error records and **never to metrics**, where one series per user would be
unbounded cardinality.

The `evalai_uid` cookie (raw JWT subject) is never attached. Records also carry
an ephemeral per-tab `session.id`, validated as a UUID at the relay so it cannot
smuggle a stable identifier.

**No full user-agent string.** `user_agent.original` is a fingerprinting vector;
the relay drops it and derives bounded `browser.name` / `browser.version` /
`browser.mobile` from the request header instead.

**No raw URLs, no session replay, and no client-side storage of any kind** — no
cookie, no `localStorage`, no `sessionStorage`. That last point is load-bearing
for the privacy position, not incidental.

## Development

```bash
pnpm --filter @evalai/otel-web typecheck
pnpm --filter @evalai/otel-web test
```
