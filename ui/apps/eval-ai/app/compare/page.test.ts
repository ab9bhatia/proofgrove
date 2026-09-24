import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ExperimentDefinition, RunResult } from "@/lib/api";
import {
  buildExperimentGroups,
  ExperimentActionDialog,
  ExperimentPagination,
  experimentLifecycleIds,
  ExperimentLibrary,
} from "./page";

function experiment(id: string, name: string, createdAt: string): ExperimentDefinition {
  return {
    experiment_id: id,
    name,
    dataset_version: "support.v2",
    target_endpoint: "tenant-classroom/support-agent",
    scenario: "agentic",
    market: "global",
    judge_model: "gpt-4.1-mini",
    judge_temperature: 0,
    has_ground_truth: true,
    status: "active",
    tags: { evaluation_name: name },
    created_at: createdAt,
  };
}

function run(id: string, definition: ExperimentDefinition, startedAt: string): RunResult {
  return {
    run_id: id,
    experiment: definition,
    started_at: startedAt,
    completed_at: startedAt,
    status: "completed",
    overall_gate: "pass",
    root_cause: null,
    metric_results: [],
    kpi_results: [],
    review_queue: [],
    active_metrics: [],
  };
}

describe("persisted Experiments library", () => {
  it("does not let the newest run speak for the whole group", () => {
    // A group whose most recent run scored stored responses reported
    // "Not invoked" and "Existing responses" for siblings that had hit a real
    // endpoint, and dropped that endpoint from the search index with it.
    const definition = experiment("exp-mixed", "Support quality", "2026-08-14T10:00:00Z");
    const invoked = run("run-agent", definition, "2026-08-14T11:00:00Z");
    const stored = {
      ...run("run-provided", definition, "2026-08-15T11:00:00Z"),
      response_source: "provided",
    } as never;

    const groups = buildExperimentGroups([definition], [stored, invoked]);

    expect(groups[0]?.targetLabel).not.toBe("Not invoked");
    expect(groups[0]?.typeLabel).toBe("Mixed");
  });

  it("groups persisted configurations by evaluation name and keeps their runs", () => {
    const baseline = experiment("exp-base", "Support quality", "2026-08-14T10:00:00Z");
    const candidate = experiment("exp-candidate", "Support quality", "2026-08-15T10:00:00Z");
    const groups = buildExperimentGroups(
      [baseline, candidate],
      [run("run-base", baseline, "2026-08-14T11:00:00Z"), run("run-candidate", candidate, "2026-08-15T11:00:00Z")],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.definitions).toHaveLength(2);
    expect(groups[0]?.runs.map((item) => item.run_id)).toEqual(["run-candidate", "run-base"]);
    expect(groups[0]?.latest.experiment_id).toBe("exp-candidate");
  });

  it("labels a stored-response experiment from its latest run", () => {
    const definition = experiment("exp-1", "Stored responses", "2026-08-15T10:00:00Z");
    definition.target_endpoint = "golden-dataset:stored.v1";
    const stored = run("run-1", definition, "2026-08-15T11:00:00Z");
    stored.response_source = "provided";
    const group = buildExperimentGroups([definition], [stored])[0]!;

    expect(group).toMatchObject({
      typeLabel: "Existing responses",
      targetLabel: "Not invoked",
    });
    const html = renderToStaticMarkup(
      createElement(ExperimentLibrary, {
        groups: [group],
        expandedKey: null,
        onToggle: () => undefined,
      }),
    );
    expect(html).not.toContain("golden-dataset:stored.v1");
  });

  it("renders desktop and narrow layouts without a forced horizontal scroller", () => {
    const definition = experiment("exp-1", "Support quality", "2026-08-15T10:00:00Z");
    const groups = buildExperimentGroups([definition], [run("run-1", definition, "2026-08-15T11:00:00Z")]);
    const html = renderToStaticMarkup(
      createElement(ExperimentLibrary, {
        groups,
        expandedKey: null,
        onToggle: () => undefined,
      }),
    );

    expect(html).toContain("Support quality");
    expect(html).toContain("table-fixed");
    expect(html).toContain("md:hidden");
    expect(html).not.toContain("overflow-x-auto");
    expect(html).not.toMatch(/min-w-\[/);
  });

  it("keeps run and lifecycle actions inside the expanded experiment", () => {
    const definition = experiment("exp-1", "Support quality", "2026-08-15T10:00:00Z");
    const groups = buildExperimentGroups([definition], [run("run-1", definition, "2026-08-15T11:00:00Z")]);
    const html = renderToStaticMarkup(
      createElement(ExperimentLibrary, {
        groups,
        expandedKey: groups[0]?.key ?? null,
        onToggle: () => undefined,
        onRunAgain: () => undefined,
        onLifecycle: () => undefined,
      }),
    );

    expect(html).toContain("Rescore saved evidence");
    expect(html).toContain("More actions for Support quality");
    expect(html).not.toContain("Archive experiment");
  });

  it("explains the diagnostic rescore before it starts", () => {
    const definition = experiment("exp-1", "Support quality", "2026-08-15T10:00:00Z");
    const group = buildExperimentGroups([definition], [])[0]!;
    const html = renderToStaticMarkup(
      createElement(ExperimentActionDialog, {
        action: "run",
        group,
        busy: false,
        error: null,
        onCancel: () => undefined,
        onConfirm: () => undefined,
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Rescore saved evidence?");
    expect(html).toContain("The target will not be invoked");
    expect(html).toContain("diagnostic only with no release verdict or gate");
    expect(html).toContain("Start diagnostic rescore");
  });

  it("applies lifecycle changes to every relevant saved configuration", () => {
    const active = experiment("exp-active", "Support quality", "2026-08-15T10:00:00Z");
    const archived = {
      ...experiment("exp-archived", "Support quality", "2026-08-14T10:00:00Z"),
      status: "archived",
    };
    const group = buildExperimentGroups([active, archived], [])[0]!;

    expect(experimentLifecycleIds(group, "archive")).toEqual(["exp-active"]);
    expect(experimentLifecycleIds(group, "restore")).toEqual(["exp-archived"]);
  });

  it("describes the visible experiment page without adding table overflow", () => {
    const html = renderToStaticMarkup(
      createElement(ExperimentPagination, {
        page: 2,
        pageCount: 3,
        total: 14,
        pageSize: 6,
        onPageChange: () => undefined,
      }),
    );

    expect(html).toContain("Showing 7–12 of 14 experiments");
    expect(html).toContain("Page 2 of 3");
    expect(html).toContain("Previous experiments");
    expect(html).toContain("Next experiments");
  });
});
