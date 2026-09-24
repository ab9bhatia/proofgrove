import { describe, expect, it } from "vitest";
import { makeRouteMatcher } from "../routes";
import {
  DEFAULT_INGEST_LIMITS,
  guardPayload,
  sanitizeUrl,
  type RelayContext,
} from "./guard";

const TEMPLATES = ["/", "/tenants", "/tenants/[id]"];

function makeContext(overrides: Partial<RelayContext> = {}): RelayContext {
  const match = makeRouteMatcher(TEMPLATES);
  const known = new Set(TEMPLATES);
  return {
    serviceName: "evalai-agent-ui",
    serviceVersion: "abc123",
    environment: "local",
    app: "evalai",
    emitterApp: "evalai",
    tenant: "acme",
    browser: { name: "chrome", version: "120", mobile: false },
    userHash: "deadbeef".repeat(8),
    normalizeRoute: (raw: string) => (known.has(raw) ? raw : match(raw)),
    ...overrides,
  };
}

function attrs(payload: unknown): Array<{ key: string; value: unknown }> {
  return (payload as any).resourceSpans[0].resource.attributes;
}

function keysOf(payload: unknown): string[] {
  return attrs(payload).map((a) => a.key);
}

function tracesBody(
  spanCount: number,
  spanAttributes: unknown[] = [],
  resourceAttributes: unknown[] = [],
) {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [
          {
            scope: { name: "evil", attributes: [{ key: "ctx.tenant", value: { stringValue: "forged" } }] },
            spans: Array.from({ length: spanCount }, (_, i) => ({
              name: `span-${i}`,
              attributes: spanAttributes,
            })),
          },
        ],
      },
    ],
  });
}

describe("resource is synthesised, never accepted", () => {
  it("discards a browser-supplied tenant and stamps the trusted one", () => {
    const body = tracesBody(1, [], [
      { key: "ctx.tenant", value: { stringValue: "victim-tenant" } },
    ]);
    const result = guardPayload(body, "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");

    const tenants = attrs(result.payload).filter((a) => a.key === "ctx.tenant");
    expect(tenants).toHaveLength(1);
    expect((tenants[0].value as any).stringValue).toBe("acme");
  });

  it("discards a forged k8s namespace — the defect the first draft shipped", () => {
    const body = tracesBody(1, [], [
      { key: "k8s.namespace.name", value: { stringValue: "tenant-victim" } },
      { key: "k8s.pod.name", value: { stringValue: "fake-pod" } },
      { key: "service.name", value: { stringValue: "authz-service" } },
    ]);
    const result = guardPayload(body, "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");

    const keys = keysOf(result.payload);
    expect(keys).not.toContain("k8s.namespace.name");
    expect(keys).not.toContain("k8s.pod.name");

    const service = attrs(result.payload).find((a) => a.key === "service.name");
    expect((service!.value as any).stringValue).toBe("evalai-agent-ui");
  });

  it("discards an underscore variant that would collide after label normalisation", () => {
    const body = tracesBody(1, [], [
      { key: "ctx_tenant", value: { stringValue: "forged" } },
    ]);
    const result = guardPayload(body, "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    expect(keysOf(result.payload)).not.toContain("ctx_tenant");
  });

  it("stamps server-derived browser fields and never user_agent.original", () => {
    const body = tracesBody(1, [
      { key: "user_agent.original", value: { stringValue: "Mozilla/5.0 (very long fingerprint)" } },
    ]);
    const result = guardPayload(body, "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");

    expect(keysOf(result.payload)).toContain("browser.name");
    const span = (result.payload as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.attributes.map((a: any) => a.key)).not.toContain(
      "user_agent.original",
    );
  });

  it("stamps user.hash on traces", () => {
    const result = guardPayload(tracesBody(1), "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    const hash = attrs(result.payload).find((a) => a.key === "user.hash");
    expect(hash).toBeDefined();
    expect((hash!.value as any).stringValue).toBe("deadbeef".repeat(8));
  });

  it("never stamps user.hash on metrics", () => {
    // One series per user is an unbounded dimension and would defeat the
    // aggregation the metrics exist for.
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "browser.web_vitals.lcp",
                  histogram: { dataPoints: [{ attributes: [] }] },
                },
              ],
            },
          ],
        },
      ],
    };
    const result = guardPayload(JSON.stringify(payload), "metrics", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    const keys = (result.payload as any).resourceMetrics[0].resource.attributes.map(
      (a: any) => a.key,
    );
    expect(keys).not.toContain("user.hash");
  });

  it("omits user.hash entirely when no salt produced a hash", () => {
    const result = guardPayload(
      tracesBody(1),
      "traces",
      makeContext({ userHash: "" }),
    );
    if (!result.ok) throw new Error("expected acceptance");
    expect(keysOf(result.payload)).not.toContain("user.hash");
  });

  it("drops a browser-asserted user.hash", () => {
    const body = tracesBody(1, [
      { key: "user.hash", value: { stringValue: "forged" } },
    ]);
    const result = guardPayload(body, "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    const span = (result.payload as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.attributes).toEqual([]);
  });

  it("omits ctx.tenant outside a tenant namespace", () => {
    const result = guardPayload(
      tracesBody(1),
      "traces",
      makeContext({ tenant: "" }),
    );
    if (!result.ok) throw new Error("expected acceptance");
    expect(keysOf(result.payload)).not.toContain("ctx.tenant");
  });
});

describe("record attributes are allowlisted", () => {
  it("drops disallowed span attributes and keeps allowed ones", () => {
    const body = tracesBody(1, [
      { key: "user.hash", value: { stringValue: "deadbeef" } },
      { key: "totally.made.up", value: { stringValue: "x" } },
      { key: "http.route", value: { stringValue: "/tenants/[id]" } },
    ]);
    const result = guardPayload(body, "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");

    const span = (result.payload as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.attributes.map((a: any) => a.key)).toEqual(["http.route"]);
  });

  it("scrubs span event and link attributes", () => {
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: "s",
                  attributes: [],
                  events: [
                    {
                      name: "e",
                      attributes: [{ key: "ctx.tenant", value: { stringValue: "forged" } }],
                    },
                  ],
                  links: [
                    {
                      traceId: "a".repeat(32),
                      spanId: "b".repeat(16),
                      attributes: [
                        { key: "enduser.id", value: { stringValue: "alice@example.com" } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = guardPayload(JSON.stringify(payload), "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");

    const span = (result.payload as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.events[0].attributes).toEqual([]);
    expect(span.links[0].attributes).toEqual([]);
  });

  it("drops scope attributes entirely", () => {
    const result = guardPayload(tracesBody(1), "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    const scope = (result.payload as any).resourceSpans[0].scopeSpans[0].scope;
    expect(scope.attributes).toBeUndefined();
  });

  it("rejects nested attribute values that could hide disallowed keys", () => {
    const body = tracesBody(1, [
      { key: "http.route", value: { kvlistValue: { values: [] } } },
      { key: "url.full", value: { arrayValue: { values: [] } } },
    ]);
    const result = guardPayload(body, "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    const span = (result.payload as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.attributes).toEqual([]);
  });
});

describe("spans are rebuilt, not filtered in place", () => {
  it("drops status.message while keeping the status code", () => {
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: "s",
                  attributes: [],
                  status: { code: 2, message: "user alice@example.com owns doc SECRET-42" },
                },
              ],
            },
          ],
        },
      ],
    };
    const result = guardPayload(JSON.stringify(payload), "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    const span = (result.payload as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.status).toEqual({ code: 2 });
    expect(JSON.stringify(result.payload)).not.toContain("alice@example.com");
  });

  it("drops span and link traceState", () => {
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: "s",
                  attributes: [],
                  traceState: "vendor=exfiltrated-value",
                  links: [
                    {
                      traceId: "a".repeat(32),
                      spanId: "b".repeat(16),
                      traceState: "vendor=more-exfiltration",
                      attributes: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = guardPayload(JSON.stringify(payload), "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    expect(JSON.stringify(result.payload)).not.toContain("exfiltrat");
    const link = (result.payload as any).resourceSpans[0].scopeSpans[0].spans[0].links[0];
    expect(Object.keys(link).sort()).toEqual(["attributes", "spanId", "traceId"]);
  });

  it("drops fields a client invents on a span", () => {
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                { name: "s", attributes: [], smuggled: "x".repeat(1000), droppedAttributesCount: 999 },
              ],
            },
          ],
        },
      ],
    };
    const result = guardPayload(JSON.stringify(payload), "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    const span = (result.payload as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.smuggled).toBeUndefined();
    expect(span.droppedAttributesCount).toBeUndefined();
  });

  it("validates span and link ids as hex rather than copying them", () => {
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: "s",
                  attributes: [],
                  traceId: "../../etc/passwd",
                  spanId: "not-hex",
                  links: [{ traceId: "junk", spanId: "junk", attributes: [] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = guardPayload(JSON.stringify(payload), "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    const span = (result.payload as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBeUndefined();
    expect(span.spanId).toBeUndefined();
    // A link with invalid ids references nothing and is dropped whole.
    expect(span.links).toBeUndefined();
  });

  it("preserves the fields a legitimate SDK span needs", () => {
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "5b8efff798038103d269b633813fc60c",
                  spanId: "eee19b7ec3c1b174",
                  name: "documentLoad",
                  kind: 1,
                  startTimeUnixNano: "1786000000000000000",
                  endTimeUnixNano: "1786000001500000000",
                  attributes: [{ key: "http.route", value: { stringValue: "/tenants" } }],
                  events: [
                    { name: "domInteractive", timeUnixNano: "1786000000400000000", attributes: [] },
                  ],
                  status: { code: 0 },
                },
              ],
            },
          ],
        },
      ],
    };
    const result = guardPayload(JSON.stringify(payload), "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    const span = (result.payload as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe("5b8efff798038103d269b633813fc60c");
    expect(span.spanId).toBe("eee19b7ec3c1b174");
    expect(span.kind).toBe(1);
    expect(span.startTimeUnixNano).toBe("1786000000000000000");
    expect(span.endTimeUnixNano).toBe("1786000001500000000");
    expect(span.events[0].name).toBe("domInteractive");
    expect(span.events[0].timeUnixNano).toBe("1786000000400000000");
    expect(span.status).toEqual({ code: 0 });
  });
});

describe("metric points are rebuilt, not filtered in place", () => {
  it("drops exemplars and their filteredAttributes", () => {
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "browser.web_vitals.lcp",
                  histogram: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        attributes: [],
                        count: "1",
                        sum: 100,
                        exemplars: [
                          {
                            filteredAttributes: [
                              { key: "ctx.tenant", value: { stringValue: "forged" } },
                              { key: "smuggle", value: { stringValue: "payload" } },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const result = guardPayload(JSON.stringify(payload), "metrics", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    const point = (result.payload as any).resourceMetrics[0].scopeMetrics[0]
      .metrics[0].histogram.dataPoints[0];
    expect(point.exemplars).toBeUndefined();
    expect(JSON.stringify(result.payload)).not.toContain("smuggle");
  });

  it("drops a browser-supplied metric description and invented units", () => {
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "browser.web_vitals.lcp",
                  description: "call +1-555-EXFIL for a good time",
                  unit: "totally-invented-unit-text",
                  histogram: { aggregationTemporality: 2, dataPoints: [{ attributes: [] }] },
                },
              ],
            },
          ],
        },
      ],
    };
    const result = guardPayload(JSON.stringify(payload), "metrics", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    const metric = (result.payload as any).resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(metric.description).toBeUndefined();
    expect(metric.unit).toBeUndefined();
    expect(metric.histogram.aggregationTemporality).toBe(2);
  });

  it("preserves the numeric fields a legitimate histogram needs", () => {
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "browser.web_vitals.lcp",
                  unit: "ms",
                  histogram: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        startTimeUnixNano: "1786000000000000000",
                        timeUnixNano: "1786000001000000000",
                        count: "1",
                        sum: 1234.5,
                        bucketCounts: ["0", "1", "0"],
                        explicitBounds: [1000, 2500],
                        attributes: [{ key: "http.route", value: { stringValue: "/tenants" } }],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const result = guardPayload(JSON.stringify(payload), "metrics", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    const metric = (result.payload as any).resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(metric.unit).toBe("ms");
    const point = metric.histogram.dataPoints[0];
    expect(point.count).toBe("1");
    expect(point.sum).toBe(1234.5);
    expect(point.bucketCounts).toEqual(["0", "1", "0"]);
    expect(point.explicitBounds).toEqual([1000, 2500]);
    expect(metric.histogram.aggregationTemporality).toBe(1);
  });
});

describe("cardinality is bounded server-side", () => {
  it("collapses an unknown route to the sentinel", () => {
    const body = tracesBody(1, [
      { key: "http.route", value: { stringValue: crypto.randomUUID() } },
    ]);
    const result = guardPayload(body, "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");

    const span = (result.payload as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.attributes[0].value.stringValue).toBe("/_unmatched");
  });

  it("rejects a metric name outside the allowlist", () => {
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                { name: "attacker.chosen.series", histogram: { dataPoints: [{}] } },
              ],
            },
          ],
        },
      ],
    };
    const result = guardPayload(JSON.stringify(payload), "metrics", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    expect((result.payload as any).resourceMetrics[0].scopeMetrics[0].metrics).toEqual([]);
  });

  it("drops an out-of-range vital rating rather than passing it through", () => {
    const body = tracesBody(1, [
      { key: "browser.vital.rating", value: { stringValue: "catastrophic" } },
    ]);
    const result = guardPayload(body, "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    const span = (result.payload as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.attributes).toEqual([]);
  });

  it("strips query strings and fragments from url.full", () => {
    expect(sanitizeUrl("https://app/x?access_token=LEAK#id_token=ALSO")).toBe(
      "https://app/x",
    );
  });
});

describe("all five metric shapes are walked", () => {
  for (const shape of [
    "gauge",
    "sum",
    "histogram",
    "exponentialHistogram",
    "summary",
  ]) {
    it(`counts and scrubs ${shape} data points`, () => {
      const payload = {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "browser.web_vitals.lcp",
                    [shape]: {
                      dataPoints: [
                        {
                          attributes: [
                            { key: "ctx.tenant", value: { stringValue: "forged" } },
                            { key: "http.route", value: { stringValue: "/tenants" } },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      const result = guardPayload(
        JSON.stringify(payload),
        "metrics",
        makeContext(),
      );
      if (!result.ok) throw new Error("expected acceptance");

      const point = (result.payload as any).resourceMetrics[0].scopeMetrics[0]
        .metrics[0][shape].dataPoints[0];
      expect(point.attributes.map((a: any) => a.key)).toEqual(["http.route"]);
    });
  }

  it("counts exponentialHistogram points against the limit", () => {
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "browser.web_vitals.lcp",
                  exponentialHistogram: {
                    dataPoints: Array.from(
                      { length: DEFAULT_INGEST_LIMITS.maxMetricDataPoints + 50 },
                      () => ({ attributes: [] }),
                    ),
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const result = guardPayload(JSON.stringify(payload), "metrics", makeContext());
    if (!result.ok) throw new Error("expected acceptance");
    expect(result.clamped.rejectedDataPoints).toBe(50);
  });
});

describe("volume: clamp and report, never silently drop", () => {
  it("clamps spans over the limit and counts the excess", () => {
    const body = tracesBody(DEFAULT_INGEST_LIMITS.maxSpans + 10);
    const result = guardPayload(body, "traces", makeContext());
    if (!result.ok) throw new Error("expected acceptance");

    const spans = (result.payload as any).resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(DEFAULT_INGEST_LIMITS.maxSpans);
    expect(result.clamped.rejectedSpans).toBe(10);
  });

  it("accepts a batch exactly at the limit without clamping", () => {
    const result = guardPayload(
      tracesBody(DEFAULT_INGEST_LIMITS.maxSpans),
      "traces",
      makeContext(),
    );
    if (!result.ok) throw new Error("expected acceptance");
    expect(result.clamped.rejectedSpans).toBe(0);
  });

  it("rejects an oversize body outright", () => {
    const big = JSON.stringify({
      resourceSpans: [],
      pad: "x".repeat(DEFAULT_INGEST_LIMITS.maxBodyBytes),
    });
    expect(guardPayload(big, "traces", makeContext())).toMatchObject({
      ok: false,
      status: 413,
    });
  });
});

describe("malformed input is rejected, not clamped", () => {
  it("rejects invalid JSON", () => {
    expect(guardPayload("{not json", "traces", makeContext())).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("rejects a JSON array", () => {
    expect(guardPayload("[1,2]", "traces", makeContext())).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("rejects a payload whose shape does not match the signal", () => {
    expect(
      guardPayload('{"resourceMetrics":[]}', "traces", makeContext()),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects an unknown signal", () => {
    expect(guardPayload("{}", "logs", makeContext())).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("does not throw on structurally hostile payloads", () => {
    const hostile = JSON.stringify({
      resourceSpans: [null, 42, { scopeSpans: [{ spans: [null, "x"] }] }],
    });
    expect(() => guardPayload(hostile, "traces", makeContext())).not.toThrow();
  });
});
