import { afterEach, describe, expect, it, vi } from "vitest";

// feature-flags reads process.env at module load, so each test resets
// modules and the env before re-importing.
async function loadFlags(envValue: string | undefined) {
  vi.resetModules();
  if (envValue === undefined) {
    delete process.env.NEXT_PUBLIC_UI_MODE;
  } else {
    process.env.NEXT_PUBLIC_UI_MODE = envValue;
  }
  return await import("./feature-flags");
}

const ORIGINAL = process.env.NEXT_PUBLIC_UI_MODE;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.NEXT_PUBLIC_UI_MODE;
  } else {
    process.env.NEXT_PUBLIC_UI_MODE = ORIGINAL;
  }
});

describe("UI_MODE parsing", () => {
  it("defaults to live when unset", async () => {
    const { UI_MODE, IS_LIVE_MODE, IS_MOCK_MODE } = await loadFlags(undefined);
    expect(UI_MODE).toBe("live");
    expect(IS_LIVE_MODE).toBe(true);
    expect(IS_MOCK_MODE).toBe(false);
  });

  it("returns mock when env is 'mock'", async () => {
    const { UI_MODE, IS_LIVE_MODE, IS_MOCK_MODE } = await loadFlags("mock");
    expect(UI_MODE).toBe("mock");
    expect(IS_LIVE_MODE).toBe(false);
    expect(IS_MOCK_MODE).toBe(true);
  });

  it("is case insensitive", async () => {
    const { UI_MODE } = await loadFlags("MOCK");
    expect(UI_MODE).toBe("mock");
  });

  it("falls back to live for any unknown value", async () => {
    const { UI_MODE } = await loadFlags("banana");
    expect(UI_MODE).toBe("live");
  });

  it("explicit 'live' resolves to live", async () => {
    const { UI_MODE } = await loadFlags("live");
    expect(UI_MODE).toBe("live");
  });
});

describe("makeIsWired", () => {
  it("returns true for everything in mock mode regardless of the set", async () => {
    const { makeIsWired } = await loadFlags("mock");
    const isWired = makeIsWired(new Set(["/"]));
    expect(isWired("/")).toBe(true);
    expect(isWired("/anything")).toBe(true);
    expect(isWired("/anything?with=query")).toBe(true);
  });

  it("returns true only for hrefs in the set in live mode", async () => {
    const { makeIsWired } = await loadFlags("live");
    const isWired = makeIsWired(new Set(["/", "/agents", "/tools"]));
    expect(isWired("/")).toBe(true);
    expect(isWired("/agents")).toBe(true);
    expect(isWired("/tools")).toBe(true);
    expect(isWired("/chat")).toBe(false);
    expect(isWired("/admin")).toBe(false);
  });

  it("strips query string before checking", async () => {
    const { makeIsWired } = await loadFlags("live");
    const isWired = makeIsWired(new Set(["/", "/control-center"]));
    expect(isWired("/?foo=bar")).toBe(true);
    expect(isWired("/control-center?tab=recent")).toBe(true);
    expect(isWired("/chat?project=hr")).toBe(false);
  });

  it("returns false for live mode hrefs not in the set", async () => {
    const { makeIsWired } = await loadFlags("live");
    const isWired = makeIsWired(new Set([]));
    expect(isWired("/")).toBe(false);
    expect(isWired("/anything")).toBe(false);
  });
});
