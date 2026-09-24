import { beforeEach, describe, expect, it } from "vitest";

import type { BakeoffTarget } from "@/lib/bakeoff";
import {
  forgetLaunch,
  readLaunches,
  rememberLaunch,
  updateLaunch,
  type BakeoffLaunch,
} from "@/lib/bakeoff-store";

function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage;
}

function target(overrides: Partial<BakeoffTarget> & { modelId: string }): BakeoffTarget {
  return { runId: null, status: null, error: null, ...overrides };
}

function launch(overrides: Partial<BakeoffLaunch> = {}): BakeoffLaunch {
  return {
    launchId: "launch-1",
    tenantId: "tenant-classroom",
    datasetName: "support-golden",
    targets: [
      target({ modelId: "a", runId: "run-a", status: "completed" }),
      target({ modelId: "b", runId: "run-b", status: "completed" }),
    ],
    workspaceId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { localStorage: fakeStorage() };
});

describe("launch record", () => {
  it("does not turn a successful launch into a failure when storage quota is exhausted", () => {
    const store = fakeStorage();
    store.setItem = () => { throw new Error("Quota exceeded"); };
    (globalThis as { window?: unknown }).window = { localStorage: store };
    expect(() => rememberLaunch(launch())).not.toThrow();
  });
  it("retains failed grouping and report identifiers for recovery", () => {
    rememberLaunch(launch());
    updateLaunch("launch-1", { attempts: 3, groupingFailed: true });
    expect(readLaunches()[0]).toMatchObject({ groupingFailed: true, attempts: 3 });
    expect(readLaunches()[0].targets.map(t => t.runId)).toEqual(["run-a", "run-b"]);
  });
  it("survives the tab that wrote it", () => {
    rememberLaunch(launch());

    // A new tab is a new page context over the same localStorage — which is the
    // whole reason this does not live in sessionStorage.
    const reopened = readLaunches();
    expect(reopened).toHaveLength(1);
    expect(reopened[0].datasetName).toBe("support-golden");
    expect(reopened[0].targets.map((entry) => entry.runId)).toEqual(["run-a", "run-b"]);
  });

  it("survives storage being unavailable instead of throwing", () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(readLaunches()).toEqual([]);
    expect(() => rememberLaunch(launch())).not.toThrow();
  });

  it("ignores corrupt contents rather than losing the page", () => {
    const store = fakeStorage();
    store.setItem("evalhub:bakeoff-launches", "{not json");
    (globalThis as { window?: unknown }).window = { localStorage: store };
    expect(readLaunches()).toEqual([]);
  });

  it("replaces a launch in place rather than duplicating it", () => {
    rememberLaunch(launch());
    updateLaunch("launch-1", { workspaceId: "ws-9" });

    const stored = readLaunches();
    expect(stored).toHaveLength(1);
    expect(stored[0].workspaceId).toBe("ws-9");
  });

  it("keeps a grouped launch long enough for its screen to read the workspace", () => {
    // Retention runs from groupedAt, not createdAt: a bakeoff that took longer
    // than the window would otherwise be pruned by the write that groups it.
    const old = launch({ createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
    rememberLaunch(old);
    updateLaunch("launch-1", { workspaceId: "ws-1", groupedAt: new Date().toISOString() });

    expect(readLaunches()[0]?.workspaceId).toBe("ws-1");
  });

  it("evicts a grouped launch before one that still owes a workspace", () => {
    for (let i = 0; i < 5; i += 1) {
      rememberLaunch(
        launch({
          launchId: `grouped-${i}`,
          workspaceId: `ws-${i}`,
          groupedAt: new Date().toISOString(),
        }),
      );
    }
    rememberLaunch(launch({ launchId: "pending" }));

    const stored = readLaunches();
    expect(stored.some((entry) => entry.launchId === "pending")).toBe(true);
  });

  it("forgets a launch once it is done", () => {
    rememberLaunch(launch());
    forgetLaunch("launch-1");
    expect(readLaunches()).toEqual([]);
  });
});
