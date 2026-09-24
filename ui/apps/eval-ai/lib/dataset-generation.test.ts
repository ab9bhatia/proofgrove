import { describe, expect, it, vi } from "vitest";

import {
  GEN_JOB_PARAM,
  type GenerationJob,
  type GenerationJobPhase,
  describeGenerationPhase,
  generationProgressLabel,
  isCancellableGenerationPhase,
  isTerminalGenerationPhase,
  readGenerationJobParam,
  watchGenerationJob,
  writeGenerationJobParam,
} from "@/lib/dataset-generation";

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    job_id: "job-1",
    tenant: "tenant-acme",
    dataset_name: "support_cases",
    phase: "queued",
    progress: null,
    error: null,
    result_dataset_name: null,
    created_at: "2026-08-24T00:00:00+00:00",
    updated_at: "2026-08-24T00:00:00+00:00",
    ...overrides,
  };
}

describe("phase semantics", () => {
  it("marks exactly completed/failed/cancelled as terminal", () => {
    const terminal: GenerationJobPhase[] = ["completed", "failed", "cancelled"];
    const active: GenerationJobPhase[] = ["queued", "generating", "validating"];
    for (const phase of terminal) expect(isTerminalGenerationPhase(phase)).toBe(true);
    for (const phase of active) expect(isTerminalGenerationPhase(phase)).toBe(false);
  });

  it("only not-yet-terminal phases are cancellable", () => {
    expect(isCancellableGenerationPhase("queued")).toBe(true);
    expect(isCancellableGenerationPhase("generating")).toBe(true);
    expect(isCancellableGenerationPhase("validating")).toBe(true);
    expect(isCancellableGenerationPhase("completed")).toBe(false);
    expect(isCancellableGenerationPhase("failed")).toBe(false);
    expect(isCancellableGenerationPhase("cancelled")).toBe(false);
  });
});

describe("describeGenerationPhase (phase rendering)", () => {
  it("renders active phases with an active tone", () => {
    expect(describeGenerationPhase(job({ phase: "queued" }))).toMatchObject({
      label: "Queued",
      tone: "active",
    });
    expect(describeGenerationPhase(job({ phase: "generating" }))).toMatchObject({
      label: "Generating",
      tone: "active",
    });
    expect(describeGenerationPhase(job({ phase: "validating" }))).toMatchObject({
      label: "Validating",
      tone: "active",
    });
  });

  it("renders completion with the real registered dataset name", () => {
    const view = describeGenerationPhase(
      job({
        phase: "completed",
        progress: { done: 10, total: 10 },
        result_dataset_name: "support_cases_v2",
      }),
    );
    expect(view.label).toBe("Completed");
    expect(view.tone).toBe("success");
    expect(view.detail).toContain("support_cases_v2");
    expect(view.detail).toContain("10 records");
  });

  it("renders failure with the honest server error", () => {
    const view = describeGenerationPhase(
      job({ phase: "failed", error: "no grounding material" }),
    );
    expect(view.label).toBe("Failed");
    expect(view.tone).toBe("error");
    expect(view.detail).toContain("no grounding material");
  });

  it("renders an interrupted job distinctly — no fake resume", () => {
    const view = describeGenerationPhase(job({ phase: "failed", error: "interrupted" }));
    expect(view.label).toBe("Interrupted");
    expect(view.tone).toBe("error");
    expect(view.detail).toMatch(/restarted/i);
  });

  it("renders cancellation as a muted, honest terminal state", () => {
    const view = describeGenerationPhase(job({ phase: "cancelled" }));
    expect(view.label).toBe("Cancelled");
    expect(view.tone).toBe("muted");
    expect(view.detail).toMatch(/No dataset was registered/);
  });
});

describe("generationProgressLabel", () => {
  it("reports progress only when honestly known", () => {
    expect(generationProgressLabel(null)).toBeNull();
    expect(generationProgressLabel({ done: 0, total: 0 })).toBeNull();
    expect(generationProgressLabel({ done: 3, total: 10 })).toBe("3 of 10 rows");
  });
});

describe("genJob URL param round-trip", () => {
  it("writes then reads the same job id", () => {
    const query = writeGenerationJobParam("", "job-abc");
    expect(readGenerationJobParam(query)).toBe("job-abc");
  });

  it("preserves unrelated params when writing", () => {
    const query = writeGenerationJobParam("type=rag&status=DRAFT", "job-abc");
    const params = new URLSearchParams(query);
    expect(params.get("type")).toBe("rag");
    expect(params.get("status")).toBe("DRAFT");
    expect(params.get(GEN_JOB_PARAM)).toBe("job-abc");
  });

  it("removes the param when cleared, keeping the rest of the query", () => {
    const withJob = writeGenerationJobParam("type=rag", "job-abc");
    const cleared = writeGenerationJobParam(withJob, null);
    expect(readGenerationJobParam(cleared)).toBeNull();
    expect(new URLSearchParams(cleared).get("type")).toBe("rag");
  });

  it("reads null for a missing or blank param", () => {
    expect(readGenerationJobParam("")).toBeNull();
    expect(readGenerationJobParam(`${GEN_JOB_PARAM}=`)).toBeNull();
    expect(readGenerationJobParam(new URLSearchParams("other=1"))).toBeNull();
  });
});

describe("watchGenerationJob", () => {
  it("reports every phase and resolves at the terminal one", async () => {
    const phases: GenerationJob[] = [
      job({ phase: "queued" }),
      job({ phase: "generating", progress: { done: 0, total: 5 } }),
      job({ phase: "validating", progress: { done: 5, total: 5 } }),
      job({
        phase: "completed",
        progress: { done: 5, total: 5 },
        result_dataset_name: "support_cases",
      }),
    ];
    let call = 0;
    const fetchJob = vi.fn(async () => phases[Math.min(call++, phases.length - 1)]);
    const seen: string[] = [];

    const terminal = await watchGenerationJob("job-1", {
      fetchJob,
      intervalMs: 0,
      onUpdate: (j) => seen.push(j.phase),
    });

    expect(terminal.phase).toBe("completed");
    expect(seen).toEqual(["queued", "generating", "validating", "completed"]);
  });

  it("stops watching at cancelled — an honest terminal state", async () => {
    const fetchJob = vi.fn(async () => job({ phase: "cancelled" }));
    const terminal = await watchGenerationJob("job-1", { fetchJob, intervalMs: 0 });
    expect(terminal.phase).toBe("cancelled");
    expect(fetchJob).toHaveBeenCalledTimes(1);
  });

  it("tolerates transient fetch errors, then surfaces persistent ones", async () => {
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("502 bad gateway");
      return job({ phase: "completed" });
    });
    const terminal = await watchGenerationJob("job-1", {
      fetchJob: flaky,
      intervalMs: 0,
    });
    expect(terminal.phase).toBe("completed");

    const alwaysDown = vi.fn(async () => {
      throw new Error("503 unavailable");
    });
    await expect(
      watchGenerationJob("job-1", {
        fetchJob: alwaysDown,
        intervalMs: 0,
        maxTransientErrors: 2,
      }),
    ).rejects.toThrow("503 unavailable");
  });

  it("aborts via the signal without cancelling the server job", async () => {
    const controller = new AbortController();
    const fetchJob = vi.fn(async () => {
      controller.abort();
      return job({ phase: "generating" });
    });
    await expect(
      watchGenerationJob("job-1", {
        fetchJob,
        intervalMs: 0,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects an empty job id", async () => {
    await expect(watchGenerationJob("", { intervalMs: 0 })).rejects.toThrow(
      /missing generation job id/,
    );
  });
});
