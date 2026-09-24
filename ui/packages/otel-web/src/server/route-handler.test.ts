import { describe, expect, it, vi } from "vitest";
import { createTelemetryHandler, tenantFromNamespace } from "./route-handler";

const ENDPOINT = "http://evalai-collector.observability.svc.cluster.local:4318";
const TEMPLATES = ["/", "/tenants", "/tenants/[id]"];

function makeContext(signal: string[]) {
  return { params: Promise.resolve({ signal }) };
}

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://app.example/api/telemetry", {
    method: "POST",
    headers: {
      "x-evalai-sub": "user-1",
      "sec-fetch-site": "same-origin",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    serviceName: "evalai-agent-ui",
    app: "evalai",
    routeTemplates: TEMPLATES,
    env: {
      EVALAI_RUM_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT,
      POD_NAMESPACE: "tenant-acme",
      DEPLOYMENT_ENVIRONMENT: "local",
      APP_VERSION: "abc123",
    } as NodeJS.ProcessEnv,
    ...overrides,
  } as never;
}

const EMPTY_TRACES = { resourceSpans: [] };

describe("tenantFromNamespace", () => {
  it("extracts the slug from a tenant namespace", () => {
    expect(tenantFromNamespace("tenant-acme")).toBe("acme");
  });

  it("returns empty for non-tenant namespaces", () => {
    expect(tenantFromNamespace("evalai-platform")).toBe("");
    expect(tenantFromNamespace(undefined)).toBe("");
  });
});

describe("access controls", () => {
  it("refuses requests when RUM is disabled", async () => {
    const fetchImpl = vi.fn();
    const handler = createTelemetryHandler(
      options({
        fetchImpl,
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT } as NodeJS.ProcessEnv,
      }),
    );
    const response = await handler(
      makeRequest(EMPTY_TRACES),
      makeContext(["v1", "traces"]),
    );
    expect(response.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when the collector endpoint is unset", async () => {
    const handler = createTelemetryHandler(
      options({ env: { EVALAI_RUM_ENABLED: "true" } as NodeJS.ProcessEnv }),
    );
    const response = await handler(
      makeRequest(EMPTY_TRACES),
      makeContext(["v1", "traces"]),
    );
    expect(response.status).toBe(503);
  });

  it("refuses a request without the gateway identity header", async () => {
    const handler = createTelemetryHandler(options());
    const request = new Request("https://app.example/api/telemetry", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body: JSON.stringify(EMPTY_TRACES),
    });
    const response = await handler(request, makeContext(["v1", "traces"]));
    expect(response.status).toBe(401);
  });

  it("refuses a cross-site submission", async () => {
    const handler = createTelemetryHandler(options());
    const response = await handler(
      makeRequest(EMPTY_TRACES, { "sec-fetch-site": "cross-site" }),
      makeContext(["v1", "traces"]),
    );
    expect(response.status).toBe(403);
  });
});

describe("forwarding", () => {
  it("forwards traces to the collector's OTLP endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const handler = createTelemetryHandler(options({ fetchImpl }));

    const response = await handler(
      makeRequest(EMPTY_TRACES),
      makeContext(["v1", "traces"]),
    );

    expect(response.status).toBe(204);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${ENDPOINT}/v1/traces`);
  });

  it("routes metrics to the metrics endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const handler = createTelemetryHandler(options({ fetchImpl }));

    await handler(
      makeRequest({ resourceMetrics: [] }),
      makeContext(["v1", "metrics"]),
    );

    expect(fetchImpl.mock.calls[0][0]).toBe(`${ENDPOINT}/v1/metrics`);
  });

  it("stamps the server-derived resource on the forwarded payload", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const handler = createTelemetryHandler(options({ fetchImpl }));

    await handler(
      makeRequest({
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: "ctx.tenant", value: { stringValue: "victim" } },
              ],
            },
            scopeSpans: [{ spans: [{ name: "s" }] }],
          },
        ],
      }),
      makeContext(["v1", "traces"]),
    );

    const sent = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    const resourceAttrs = sent.resourceSpans[0].resource.attributes;
    const byKey = Object.fromEntries(
      resourceAttrs.map((a: any) => [a.key, a.value.stringValue ?? a.value.boolValue]),
    );
    expect(byKey["ctx.tenant"]).toBe("acme");
    expect(byKey["service.name"]).toBe("evalai-agent-ui");
    expect(byKey["service.version"]).toBe("abc123");
    expect(byKey["browser.name"]).toBe("chrome");
    expect(byKey["browser.version"]).toBe("120");
  });

  it("does not reflect the upstream status to the client", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const handler = createTelemetryHandler(
      options({ fetchImpl, logLine: () => {} }),
    );

    const response = await handler(
      makeRequest(EMPTY_TRACES),
      makeContext(["v1", "traces"]),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "telemetry backend unavailable",
    });
  });

  it("reports an unreachable collector as 502 rather than propagating", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const handler = createTelemetryHandler(options({ fetchImpl }));

    const response = await handler(
      makeRequest(EMPTY_TRACES),
      makeContext(["v1", "traces"]),
    );
    expect(response.status).toBe(502);
  });
});

describe("collector timeout", () => {
  it("passes an abort signal to the collector fetch", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const handler = createTelemetryHandler(options({ fetchImpl }));

    await handler(makeRequest(EMPTY_TRACES), makeContext(["v1", "traces"]));

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns 502 when the collector stalls instead of hanging the pod", async () => {
    // A fetch that never resolves on its own and only rejects when the abort
    // signal fires — the stalled-collector shape.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason ?? new Error("aborted")),
          );
        }),
    );
    const handler = createTelemetryHandler(
      options({ fetchImpl, collectorTimeoutMs: 25 }),
    );

    const started = Date.now();
    const response = await handler(
      makeRequest(EMPTY_TRACES),
      makeContext(["v1", "traces"]),
    );

    expect(response.status).toBe(502);
    // Well under any default fetch timeout — the abort did the work.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("volume controls", () => {
  it("rejects on Content-Length before reading the body", async () => {
    const fetchImpl = vi.fn();
    const handler = createTelemetryHandler(options({ fetchImpl }));

    const response = await handler(
      makeRequest(EMPTY_TRACES, { "content-length": "99999999" }),
      makeContext(["v1", "traces"]),
    );

    expect(response.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports clamping as OTLP partialSuccess instead of hiding it", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const handler = createTelemetryHandler(options({ fetchImpl }));

    const response = await handler(
      makeRequest({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: Array.from({ length: 200 }, (_, i) => ({
                  name: `s${i}`,
                  attributes: [],
                })),
              },
            ],
          },
        ],
      }),
      makeContext(["v1", "traces"]),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.partialSuccess.rejectedSpans).toBe(50);
  });
});

describe("errors to stdout", () => {
  it("writes one structured JSON line per error and never forwards it", async () => {
    const fetchImpl = vi.fn();
    const lines: string[] = [];
    const handler = createTelemetryHandler(
      options({ fetchImpl, logLine: (l: string) => lines.push(l) }),
    );

    const sessionId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const response = await handler(
      makeRequest({
        errors: [
          {
            name: "TypeError",
            message: "boom",
            stack: "  at f (a.js:1)",
            route: "/tenants/[id]",
            sessionId,
          },
        ],
      }),
      makeContext(["v1", "errors"]),
    );

    expect(response.status).toBe(204);
    expect(fetchImpl).not.toHaveBeenCalled();

    const record = JSON.parse(lines[0]);
    expect(record["event.name"]).toBe("browser.error");
    expect(record["error.type"]).toBe("TypeError");
    expect(record["http.route"]).toBe("/tenants/[id]");
    expect(record["ctx.tenant"]).toBe("acme");
    expect(record["session.id"]).toBe(sessionId);
    expect(record["browser.name"]).toBe("chrome");
  });

  it("collapses an attacker-chosen route to the sentinel", async () => {
    const lines: string[] = [];
    const handler = createTelemetryHandler(
      options({ logLine: (l: string) => lines.push(l) }),
    );

    await handler(
      makeRequest({ errors: [{ message: "x", route: "/" + "z".repeat(150) }] }),
      makeContext(["v1", "errors"]),
    );

    expect(JSON.parse(lines[0])["http.route"]).toBe("/_unmatched");
  });

  it("drops a non-UUID session id and a non-hex trace id", async () => {
    const lines: string[] = [];
    const handler = createTelemetryHandler(
      options({ logLine: (l: string) => lines.push(l) }),
    );

    await handler(
      makeRequest({
        errors: [{ message: "x", sessionId: "stable-tracker", traceId: "../../etc" }],
      }),
      makeContext(["v1", "errors"]),
    );

    const record = JSON.parse(lines[0]);
    expect(record["session.id"]).toBeUndefined();
    expect(record.trace_id).toBeUndefined();
  });

  it("redacts secrets in the emitted line", async () => {
    const lines: string[] = [];
    const handler = createTelemetryHandler(
      options({ logLine: (l: string) => lines.push(l) }),
    );

    await handler(
      makeRequest({
        errors: [{ message: "failed for alice@example.com id 3f2504e0-4f89-11d3-9a0c-0305e82c3301" }],
      }),
      makeContext(["v1", "errors"]),
    );

    expect(lines[0]).not.toContain("alice@example.com");
    expect(lines[0]).not.toContain("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  });

  it("stamps a salted user.hash derived from the gateway subject", async () => {
    const lines: string[] = [];
    const handler = createTelemetryHandler(
      options({
        logLine: (l: string) => lines.push(l),
        env: {
          EVALAI_RUM_ENABLED: "true",
          OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT,
          POD_NAMESPACE: "tenant-acme",
          EVALAI_RUM_HASH_SALT: "s".repeat(64),
        } as NodeJS.ProcessEnv,
      }),
    );

    await handler(
      makeRequest({ errors: [{ message: "x" }] }, { "x-evalai-sub": "alice-subject" }),
      makeContext(["v1", "errors"]),
    );

    const record = JSON.parse(lines[0]);
    expect(record["user.hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[0]).not.toContain("alice-subject");
  });

  it("omits user.hash when no salt is configured", async () => {
    // Fail-safe: an unsalted hash is rainbow-tableable, so absence is correct.
    const lines: string[] = [];
    const handler = createTelemetryHandler(
      options({ logLine: (l: string) => lines.push(l) }),
    );

    await handler(
      makeRequest({ errors: [{ message: "x" }] }),
      makeContext(["v1", "errors"]),
    );

    const record = JSON.parse(lines[0]);
    expect(record["user.hash"]).toBeUndefined();
    // The deprecated alias must never reappear in a new emitter.
    expect(record["enduser.id_hash"]).toBeUndefined();
  });

  it("never emits the gateway identity header into the record", async () => {
    const lines: string[] = [];
    const handler = createTelemetryHandler(
      options({ logLine: (l: string) => lines.push(l) }),
    );

    await handler(
      makeRequest(
        { errors: [{ message: "x" }] },
        { "x-evalai-sub": "alice-subject-id", authorization: "Bearer secret" },
      ),
      makeContext(["v1", "errors"]),
    );

    expect(lines[0]).not.toContain("alice-subject-id");
    expect(lines[0]).not.toContain("secret");
  });
});
