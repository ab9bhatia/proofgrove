// @vitest-environment jsdom
import { act, render, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BakeoffResume } from "./bakeoff-resume";
import { readLaunches, rememberLaunch, updateLaunch } from "@/lib/bakeoff-store";
import { groupLaunch, refreshTargets } from "@/lib/bakeoff-grouping";
vi.mock("@/lib/bakeoff-grouping", () => ({
  refreshTargets: vi.fn(async (targets) => targets),
  groupLaunch: vi.fn(async () => { throw new Error("Unavailable"); }),
}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("stops retrying failed grouping without losing completed run links", async () => {
  const data = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
  vi.useFakeTimers();
  rememberLaunch({ launchId: "test", tenantId: "test", datasetName: "test", workspaceId: null, createdAt: new Date().toISOString(), targets: ["a", "b"].map(modelId => ({ modelId, runId: modelId, status: "completed", error: null })) });
  render(<BakeoffResume />);
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(groupLaunch).toHaveBeenCalledTimes(3);
  expect(readLaunches()[0]).toMatchObject({ groupingFailed: true, attempts: 3 });
  expect(readLaunches()[0].targets.map(t => t.runId)).toEqual(["a", "b"]);
});

it("keeps pending runs through a connection failure and resumes once after remount", async () => {
  const data = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
  vi.useFakeTimers();
  const targets = ["a", "b"].map(modelId => ({ modelId, runId: modelId, status: "running", error: null }));
  rememberLaunch({ launchId: "resume", tenantId: "test", datasetName: "test", workspaceId: null, createdAt: new Date().toISOString(), targets });
  vi.mocked(refreshTargets).mockRejectedValueOnce(new Error("Network unavailable"));
  const first = render(<BakeoffResume />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(readLaunches()[0].targets).toEqual(targets);
  expect(groupLaunch).not.toHaveBeenCalled();
  first.unmount();
  vi.mocked(refreshTargets).mockResolvedValue(targets.map(target => ({ ...target, status: "completed" })));
  vi.mocked(groupLaunch).mockImplementation(async launch => {
    updateLaunch(launch.launchId, { workspaceId: "comparison", groupedAt: new Date().toISOString() });
    return "comparison";
  });
  render(<BakeoffResume />);
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(groupLaunch).toHaveBeenCalledTimes(1);
  expect(readLaunches()[0].workspaceId).toBe("comparison");
});
