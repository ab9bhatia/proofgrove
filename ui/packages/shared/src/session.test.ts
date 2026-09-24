import { afterEach, describe, expect, it, vi } from "vitest";

const sameOriginLocation = {
  href: "https://evalai-agent-ui.acme.evalai.ai/agents",
  origin: "https://evalai-agent-ui.acme.evalai.ai",
  replace: vi.fn(),
} as unknown as Location;

async function loadSession() {
  vi.resetModules();
  return import("./session");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sessionAwareFetch", () => {
  it("returns the response and redirects a marked same-origin 401", async () => {
    vi.stubGlobal("window", { location: sameOriginLocation });
    const response = new Response(null, {
      status: 401,
      headers: { "X-EvalAI-Session-Status": "rejected" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const { sessionAwareFetch } = await loadSession();

    await expect(sessionAwareFetch("/api/user")).resolves.toBe(response);
    expect(sameOriginLocation.replace).toHaveBeenCalledOnce();
    expect(sameOriginLocation.replace).toHaveBeenCalledWith("/logout");
  });

  it("starts logout only once for concurrent marked failures", async () => {
    const replace = vi.fn();
    vi.stubGlobal("window", {
      location: { ...sameOriginLocation, replace },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 401,
          headers: { "X-EvalAI-Session-Status": "rejected" },
        }),
      ),
    );
    const { sessionAwareFetch } = await loadSession();

    await Promise.all([
      sessionAwareFetch("/api/user"),
      sessionAwareFetch("/api/agents"),
    ]);
    expect(replace).toHaveBeenCalledOnce();
  });

  it.each([
    [401, undefined],
    [401, "other"],
    [403, "rejected"],
    [200, "rejected"],
  ])("passes through status %i with marker %s", async (status, marker) => {
    const replace = vi.fn();
    vi.stubGlobal("window", {
      location: { ...sameOriginLocation, replace },
    });
    const response = new Response(null, {
      status,
      headers: marker ? { "X-EvalAI-Session-Status": marker } : undefined,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const { sessionAwareFetch } = await loadSession();

    await expect(sessionAwareFetch("/api/user")).resolves.toBe(response);
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not redirect for cross-origin requests", async () => {
    const replace = vi.fn();
    vi.stubGlobal("window", {
      location: { ...sameOriginLocation, replace },
    });
    const response = new Response(null, {
      status: 401,
      headers: { "X-EvalAI-Session-Status": "rejected" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const { sessionAwareFetch } = await loadSession();

    await expect(
      sessionAwareFetch("https://api.example.test/resource"),
    ).resolves.toBe(response);
    expect(replace).not.toHaveBeenCalled();
  });

  it("is inert during server-side fetches", async () => {
    const response = new Response(null, {
      status: 401,
      headers: { "X-EvalAI-Session-Status": "rejected" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const { sessionAwareFetch } = await loadSession();

    await expect(sessionAwareFetch("https://internal.test/api")).resolves.toBe(
      response,
    );
  });
});
