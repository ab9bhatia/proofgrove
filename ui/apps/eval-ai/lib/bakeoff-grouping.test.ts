import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BakeoffLaunch } from "@/lib/bakeoff-store";

const createExperimentFromRuns = vi.fn();
const patchExperiment = vi.fn();
const getRun = vi.fn();

vi.mock("@/lib/api", () => ({
  evaluationApi: {
    createExperimentFromRuns: (...args: unknown[]) => createExperimentFromRuns(...args),
    patchExperiment: (...args: unknown[]) => patchExperiment(...args),
    getRun: (...args: unknown[]) => getRun(...args),
  },
}));

const { groupLaunch, refreshTargets } = await import("@/lib/bakeoff-grouping");
const { readLaunches, rememberLaunch } = await import("@/lib/bakeoff-store");

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

function launch(overrides: Partial<BakeoffLaunch> = {}): BakeoffLaunch {
  return {
    launchId: "launch-1",
    tenantId: "tenant-classroom",
    datasetName: "support-golden",
    targets: [
      { modelId: "a", runId: "run-a", status: "completed", error: null },
      { modelId: "b", runId: "run-b", status: "completed", error: null },
    ],
    workspaceId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  createExperimentFromRuns.mockReset();
  patchExperiment.mockReset();
  (globalThis as { window?: unknown }).window = { localStorage: fakeStorage() };
  createExperimentFromRuns.mockResolvedValue({
    experiment: { experiment_id: "ws-1", tags: { label: "nightly" } },
  });
  patchExperiment.mockResolvedValue({});
});

describe("groupLaunch", () => {
  it("creates the workspace and keeps the id on the record", async () => {
    rememberLaunch(launch());

    await expect(groupLaunch(launch())).resolves.toBe("ws-1");

    expect(createExperimentFromRuns).toHaveBeenCalledTimes(1);
    expect(createExperimentFromRuns.mock.calls[0][0]).toMatchObject({
      name: "Comparison — support-golden",
      run_ids: ["run-a", "run-b"],
      baseline_run_id: "run-a",
    });
    // The launch screen reads the workspace id back off this record. Deleting
    // it on success leaves the user watching "still going" forever.
    expect(readLaunches()[0].workspaceId).toBe("ws-1");
  });

  it("preserves the user's evaluation name when the completed runs are grouped", async () => {
    const named = launch({ evaluationName: "Prompt revision comparison" });
    rememberLaunch(named);
    await groupLaunch(named);
    expect(createExperimentFromRuns.mock.calls[0][0].name).toBe("Prompt revision comparison");
  });

  it("treats a missing record as already handled, not as work to do", async () => {
    // A pass that grouped and pruned leaves no record. A second pass must not
    // read that as "nothing stored, go ahead" and mint a duplicate workspace.
    await expect(groupLaunch(launch())).resolves.toBeNull();
    expect(createExperimentFromRuns).not.toHaveBeenCalled();
  });

  it("keeps the workspace when tagging fails", async () => {
    // The workspace already exists at this point — losing its id because a
    // cosmetic PATCH failed would strand the user with no way back to it.
    patchExperiment.mockRejectedValue(new Error("patch exploded"));
    rememberLaunch(launch());

    await expect(groupLaunch(launch())).resolves.toBe("ws-1");
    expect(readLaunches()[0].workspaceId).toBe("ws-1");
  });

  it("trusts stored state over a stale caller, so a second tab cannot duplicate", async () => {
    // Another tab grouped this launch after our caller read it.
    rememberLaunch(launch({ workspaceId: "ws-existing" }));

    await expect(groupLaunch(launch())).resolves.toBe("ws-existing");
    expect(createExperimentFromRuns).not.toHaveBeenCalled();
  });

  it("does nothing while a run is still going", async () => {
    const pending = launch({
      targets: [
        { modelId: "a", runId: "run-a", status: "completed", error: null },
        { modelId: "b", runId: "run-b", status: "running", error: null },
      ],
    });
    rememberLaunch(pending);

    await expect(groupLaunch(pending)).resolves.toBeNull();
    expect(createExperimentFromRuns).not.toHaveBeenCalled();
  });

  it("refuses a comparison of one rather than creating a useless workspace", async () => {
    const doomed = launch({
      targets: [
        { modelId: "a", runId: "run-a", status: "completed", error: null },
        { modelId: "b", runId: "run-b", status: "failed", error: "boom" },
      ],
    });
    rememberLaunch(doomed);

    await expect(groupLaunch(doomed)).resolves.toBeNull();
    expect(createExperimentFromRuns).not.toHaveBeenCalled();
  });
});

it("reports failed status reads to the progress screen and recovers on retry", async () => {
  const targets = launch().targets.map(target => ({ ...target, status: "running" }));
  getRun.mockRejectedValue(new Error("Offline"));
  await expect(refreshTargets(targets, "tenant-classroom", true)).rejects.toThrow("Offline");
  await expect(refreshTargets(targets, "tenant-classroom")).resolves.toEqual(targets);
  getRun.mockResolvedValue({ status: "completed" });
  await expect(refreshTargets(targets, "tenant-classroom", true)).resolves.toEqual(targets.map(target => ({ ...target, status: "completed" })));
});
