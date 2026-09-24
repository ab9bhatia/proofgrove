import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { proxy } from "./route";

function context(...path: string[]) {
  return { params: Promise.resolve({ path }) };
}

describe("Proofgrove BFF proxy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["classroom", "tenant-classroom"])("forwards the exact slug %s from pod context, ignoring browser headers", async (slug) => {
    vi.stubEnv("POD_NAMESPACE", `tenant-${slug}`);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxy(
      new Request("http://localhost/api/eval-hub/datasets", {
        headers: { "x-evalai-tenant": "another-tenant" },
      }),
      context("datasets"),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("x-evalai-tenant")).toBe(slug);
  });

  it("carries Envoy's authenticated subject over the internal BFF hop", async () => {
    vi.stubEnv("POD_NAMESPACE", "tenant-classroom");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await proxy(
      new Request("http://localhost/api/eval-hub/datasets", {
        headers: { "x-evalai-sub": "user-123" },
      }),
      context("datasets"),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("x-evalai-sub")).toBe("user-123");
  });

  it("fails closed without trusted tenant context", async () => {
    vi.stubEnv("POD_NAMESPACE", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await proxy(
      new Request("http://localhost/api/eval-hub/datasets", {
        headers: { "x-evalai-tenant": "attacker-selected" },
      }),
      context("datasets"),
    );

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });

  it("does not reflect raw backend failures", async () => {
    vi.stubEnv("POD_NAMESPACE", "tenant-classroom");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          "SQLSTATE password=secret prompt=customer-private-response",
          { status: 500 },
        ),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await proxy(
      new Request("http://localhost/api/eval-hub/datasets/private-run"),
      context("datasets", "private-run"),
    );
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(body).not.toContain("secret");
    expect(body).not.toContain("customer-private-response");
    expect(body).toContain("INTERNAL_ERROR");
  });

  it("preserves retry-after for a bounded rate-limit response", async () => {
    vi.stubEnv("POD_NAMESPACE", "tenant-classroom");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "Too Many Requests" }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "7",
          },
        }),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await proxy(
      new Request("http://localhost/api/eval-hub/evaluation/runs", {
        method: "POST",
        body: "{}",
      }),
      context("evaluation", "runs"),
    );
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("forwards a coded dict detail as the bounded problem contract only", async () => {
    vi.stubEnv("POD_NAMESPACE", "tenant-classroom");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            detail: {
              code: "exact_rerun_source_required",
              message:
                "exact_rerun requires source_run_id naming the historical run whose recorded requested scope is being replayed.",
              recovery: "Pick a source run and try again.",
              stack: "Traceback (most recent call last): secret frame",
              internal_endpoint: "http://10.0.0.8:8000",
            },
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await proxy(
      new Request("http://localhost/api/eval-hub/evaluation/dataset/run", {
        method: "POST",
        body: "{}",
      }),
      context("evaluation", "dataset", "run"),
    );
    const body = (await response.json()) as { error: Record<string, unknown> };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("exact_rerun_source_required");
    expect(body.error.message).toContain("exact_rerun requires source_run_id");
    expect(body.error.recovery).toBe("Pick a source run and try again.");
    // Only the allowlisted contract keys may cross the proxy.
    expect(Object.keys(body.error).sort()).toEqual([
      "code",
      "message",
      "recovery",
      "request_id",
    ]);
    expect(JSON.stringify(body)).not.toContain("Traceback");
    expect(JSON.stringify(body)).not.toContain("10.0.0.8");
  });

  it("forwards validation-error arrays as bounded per-field details", async () => {
    vi.stubEnv("POD_NAMESPACE", "tenant-classroom");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            detail: [
              {
                loc: ["body", "project_id"],
                msg: "Field required",
                type: "missing",
                input: { secret: "customer-payload" },
                ctx: { hint: "internal" },
              },
              {
                loc: ["body", "options", "evaluation_scope"],
                msg: "Input should be a valid scope",
                type: "enum",
              },
            ],
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await proxy(
      new Request("http://localhost/api/eval-hub/evaluation", {
        method: "POST",
        body: "{}",
      }),
      context("evaluation"),
    );
    const body = (await response.json()) as {
      error: { message: string; details: Array<Record<string, unknown>> };
    };

    expect(response.status).toBe(422);
    expect(body.error.details).toEqual([
      { code: "missing", field: "project_id", message: "Field required" },
      {
        code: "enum",
        field: "options.evaluation_scope",
        message: "Input should be a valid scope",
      },
    ]);
    // The summary message carries every specific reason.
    expect(body.error.message).toContain("project_id: Field required");
    expect(body.error.message).toContain("options.evaluation_scope: Input should be a valid scope");
    expect(JSON.stringify(body)).not.toContain("customer-payload");
    expect(JSON.stringify(body)).not.toContain("internal");
  });

  it("does not forward arbitrary string details", async () => {
    vi.stubEnv("POD_NAMESPACE", "tenant-classroom");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "Unknown metric(s): llm.bogus" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "x".repeat(2000) }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const specific = await proxy(
      new Request("http://localhost/api/eval-hub/evaluation", { method: "POST", body: "{}" }),
      context("evaluation"),
    );
    const specificBody = (await specific.json()) as { error: { message: string } };
    expect(specific.status).toBe(422);
    expect(specificBody.error.message).toBe(
      "Some information is invalid. Review the highlighted fields and try again.",
    );

    const oversized = await proxy(
      new Request("http://localhost/api/eval-hub/evaluation", { method: "POST", body: "{}" }),
      context("evaluation"),
    );
    const oversizedBody = (await oversized.json()) as { error: { message: string } };
    expect(oversizedBody.error.message).toBe(
      "Some information is invalid. Review the highlighted fields and try again.",
    );
  });

  it("keeps the generic copy when a failure body is not parseable JSON", async () => {
    vi.stubEnv("POD_NAMESPACE", "tenant-classroom");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>gateway error</html>", { status: 422 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await proxy(
      new Request("http://localhost/api/eval-hub/evaluation", { method: "POST", body: "{}" }),
      context("evaluation"),
    );
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.message).toBe(
      "Some information is invalid. Review the highlighted fields and try again.",
    );
    expect(JSON.stringify(body)).not.toContain("gateway error");
  });

  it("does not reflect network exception details", async () => {
    vi.stubEnv("POD_NAMESPACE", "tenant-classroom");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.8:8000")),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await proxy(
      new Request("http://localhost/api/eval-hub/datasets"),
      context("datasets"),
    );
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(502);
    expect(body).not.toContain("10.0.0.8");
    expect(body).not.toContain("ECONNREFUSED");
  });

  it.each(["docs", "redoc", "openapi.json"])(
    "rejects an unallowlisted first segment (%s) without calling upstream",
    async (segment) => {
      vi.stubEnv("POD_NAMESPACE", "tenant-classroom");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const response = await proxy(
        new Request(`http://localhost/api/eval-hub/${segment}`),
        context(segment),
      );

      expect(response.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["datasets", "..", "docs"],
    ["datasets", ".", "..", "openapi.json"],
    ["evaluation", "", "redoc"],
    ["datasets", "../docs"],
  ])("rejects a non-literal segment after an allowlisted prefix (%s) without calling upstream", async (...segments) => {
    vi.stubEnv("POD_NAMESPACE", "tenant-classroom");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxy(
      new Request(`http://localhost/api/eval-hub/${segments.map(encodeURIComponent).join("/")}`),
      context(...segments),
    );

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still proxies a known first segment", async () => {
    vi.stubEnv("POD_NAMESPACE", "tenant-classroom");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxy(
      new Request("http://localhost/api/eval-hub/tracing"),
      context("tracing"),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a cross-origin mutating request without calling upstream", async () => {
    vi.stubEnv("POD_NAMESPACE", "tenant-classroom");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxy(
      new Request("http://localhost/api/eval-hub/datasets", {
        method: "POST",
        body: "{}",
        headers: { "sec-fetch-site": "cross-site" },
      }),
      context("datasets"),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still proxies a same-origin mutating request", async () => {
    vi.stubEnv("POD_NAMESPACE", "tenant-classroom");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxy(
      new Request("http://localhost/api/eval-hub/datasets", {
        method: "POST",
        body: "{}",
        headers: { "sec-fetch-site": "same-origin" },
      }),
      context("datasets"),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("still proxies a cross-site GET (allowlist and CSRF gate only mutating methods)", async () => {
    vi.stubEnv("POD_NAMESPACE", "tenant-classroom");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxy(
      new Request("http://localhost/api/eval-hub/datasets", {
        headers: { "sec-fetch-site": "cross-site" },
      }),
      context("datasets"),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
