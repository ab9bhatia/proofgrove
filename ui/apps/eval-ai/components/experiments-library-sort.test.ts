import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { RunResult } from "@/lib/api";
import {
  groupRunsByName,
  librarySortIndicator,
  nextLibrarySort,
  sortExperimentGroups,
} from "@/components/experiments-library";
import { libraryCsv } from "@/lib/eval-export";

function run(id: string, name: string, startedAt: string, score: number | null = null): RunResult {
  return {
    run_id: id,
    experiment: {
      experiment_id: `exp-${name}`,
      name,
      dataset_version: "dataset.v1",
      target_endpoint: "agent",
      scenario: "agentic",
      market: "global",
      judge_model: "judge",
      judge_temperature: 0,
      has_ground_truth: true,
    },
    status: "completed",
    metric_results: [],
    kpi_results:
      score == null
        ? []
        : [
            {
              kpi_id: "k1",
              run_id: id,
              composite_score: score,
              gate_result: "pass",
              constituent_scores: [],
              threshold_pass: 0.8,
              threshold_warn: 0.6,
            },
          ],
    overall_gate: "pass",
    verdict_status: "conclusive",
    root_cause: null,
    review_queue: [],
    active_metrics: [],
    started_at: startedAt,
    completed_at: startedAt,
  } as unknown as RunResult;
}

// The selection guard compares `group.key` against a key derived from the
// selected run. Those were two different value spaces — "evaluation:<id>" versus
// the lowercased evaluation name — so the comparison was false for every row the
// moment anything was selected, and because the guard short-circuits on null,
// the *first* checkbox worked and every one after it silently did nothing.
describe("run grouping keys are one value space", () => {
  it("keys a group by experiment id, not by the display name", () => {
    const [group] = groupRunsByName([
      run("a1", "Alpha", "2026-08-10T10:00:00Z", 0.5),
      run("a2", "Alpha", "2026-08-11T10:00:00Z", 0.5),
    ]);

    expect(group.key).toBe("evaluation:exp-Alpha");
    // The exact mismatch the selection guard used to make. If a future change
    // makes these equal, the guard can safely go back to comparing names.
    expect(group.key).not.toBe("alpha");
  });

  it("gives every run of one evaluation the same group key to compare against", () => {
    const runs = [
      run("a1", "Alpha", "2026-08-10T10:00:00Z", 0.5),
      run("a2", "Alpha", "2026-08-11T10:00:00Z", 0.5),
      run("b1", "Beta", "2026-08-12T10:00:00Z", 0.9),
    ];
    const groups = groupRunsByName(runs);
    const keyFor = (runId: string) =>
      groups.find((group) => group.runs.some((candidate) => candidate.run_id === runId))?.key ?? null;

    // Selecting a1 must leave a2 selectable, and b1 not.
    expect(keyFor("a2")).toBe(keyFor("a1"));
    expect(keyFor("b1")).not.toBe(keyFor("a1"));
  });
});

describe("sortExperimentGroups", () => {
  it("sorts by runs / latest score / last run and toggles direction", () => {
    const groups = groupRunsByName([
      run("a1", "Alpha", "2026-08-10T10:00:00Z", 0.5),
      run("a2", "Alpha", "2026-08-11T10:00:00Z", 0.5),
      run("b1", "Beta", "2026-08-12T10:00:00Z", 0.9),
    ]);

    const byRunsAsc = sortExperimentGroups(groups, "runs", "asc");
    expect(byRunsAsc.map((group) => group.name)).toEqual(["Beta", "Alpha"]);

    const byScoreDesc = sortExperimentGroups(groups, "latest_score", "desc");
    expect(byScoreDesc[0]?.name).toBe("Beta");

    const byLastAsc = sortExperimentGroups(groups, "last_run", "asc");
    expect(byLastAsc.map((group) => group.name)).toEqual(["Alpha", "Beta"]);

    expect(nextLibrarySort("runs", "desc", "runs")).toEqual({ sortKey: "runs", sortDir: "asc" });
    expect(nextLibrarySort("runs", "asc", "latest_score")).toEqual({
      sortKey: "latest_score",
      sortDir: "desc",
    });
  });
});

describe("libraryCsv", () => {
  it("serializes exactly the filtered group rows", () => {
    const csv = libraryCsv([
      {
        name: "Alpha",
        runs: 2,
        latestScore: "50%",
        latestOutcome: "Pass",
        lastRun: "Aug 11, 2026",
      },
    ]);
    expect(csv.split("\n")[0]).toBe("evaluation,runs,latest_score,latest_outcome,last_run");
    expect(csv).toContain("Alpha,2,50%,Pass");
    expect(csv).toContain('"Aug 11, 2026"');
  });
});

describe("sortable column headers", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "experiments-library.tsx"),
    "utf8",
  );

  it("pairs every aria-sort header with a visible chevron", () => {
    // aria-sort is invisible; a sighted user needs the direction on screen.
    const ariaSortHeaders = source.match(/aria-sort=/g) ?? [];
    const indicators = source.match(/<SortIndicator\b/g) ?? [];
    expect(ariaSortHeaders).toHaveLength(4);
    expect(indicators).toHaveLength(ariaSortHeaders.length);
  });

  it("does not re-implement native button activation", () => {
    // `<button>` already fires click on Enter/Space; the hand-rolled handler was
    // dead code that could only diverge from the native behaviour.
    expect(source).not.toMatch(/event\.currentTarget as HTMLButtonElement\)\.click\(\)/);
  });
});

describe("librarySortIndicator", () => {
  it("marks only the active column, and which way it points", () => {
    expect(librarySortIndicator("runs", "desc", "runs")).toEqual({
      direction: "desc",
      hint: "Sorted descending. Activate to sort ascending.",
    });
    expect(librarySortIndicator("runs", "asc", "runs")).toEqual({
      direction: "asc",
      hint: "Sorted ascending. Activate to sort descending.",
    });
    expect(librarySortIndicator("runs", "asc", "last_run")).toEqual({
      direction: null,
      hint: "Not sorted. Activate to sort descending.",
    });
  });

  it("agrees with the direction the header click will produce", () => {
    // The hint promises what nextLibrarySort actually does.
    expect(nextLibrarySort("runs", "desc", "runs").sortDir).toBe("asc");
    expect(nextLibrarySort("runs", "asc", "runs").sortDir).toBe("desc");
    expect(nextLibrarySort("runs", "asc", "last_run").sortDir).toBe("desc");
  });
});
