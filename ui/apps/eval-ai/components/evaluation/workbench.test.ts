import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { ScriptTarget, transpileModule } from "typescript";

import type {
  DatasetInfo,
  DatasetPage,
  MetricCatalogEntry,
  QualityContractTemplate,
  TraceProject,
} from "@/lib/api";
import { ApiError } from "@/lib/api-errors";
import { datasetIsUnusable, datasetMissingFields } from "@/lib/evaluation-form";
import {
  describeRunFailure,
  datasetPickerCountLabel,
  datasetPickerOptions,
  ensureRequestedDataset,
  requestedDatasetUnavailableNotice,
  groupMetricsByFamily,
  loadDatasetPickerPage,
  metricIdsCompatibleWithScope,
  recommendedMetricIdsForScope,
  requiredScopeForMetricIds,
  resolveScoringMetricIds,
  selectableTracingProjects,
  tracingProjectOptionState,
} from "./workbench";

describe("scoring model placement", () => {
  const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");
  const advanced = readFileSync(new URL("./advanced-settings.tsx", import.meta.url), "utf8");

  it("hosts the scoring model in step 3 for a provided run, and only there", () => {
    // A provided run invokes no target, so step 3 asked for nothing while the one
    // system it does use — the model that scores the stored answers — sat collapsed
    // inside step 4's Advanced configurations.
    const step3 = source.slice(
      source.indexOf('id="evaluation-step-3"'),
      source.indexOf('id="evaluation-step-4"'),
    );
    expect(step3).toContain("<ScoringModelControl");
    // Rendering it in both places would put two inputs behind one value.
    expect(source).toContain('judgeHosted={chosenKind === "provided"}');
    expect(advanced).toContain("{judgeRequired && !judgeHosted ? (");
  });

  it("calls step 3 the same thing in the strip, the card and the button", () => {
    // Renaming only the card left three names for one step: the progress strip
    // said "Existing responses", the card said "Scoring model", and Continue
    // said "response source". Found by walking the real UI, not by a test.
    expect(source).toContain('evaluationSetupStepLabels(chosenKind === "provided" ? "Scoring model" : evaluationTypeLabel)');
    expect(source).toContain('"Continue to scoring model"');
    expect(source).not.toContain('"Continue to response source"');
  });

  it("offers no way to launch a run that scores nothing", () => {
    // Turning the old toggle off swapped in a mock judge, and mock output records
    // as UNSCORED/SIMULATED — the run completed, looked finished, and asserted
    // nothing for every judged check. `judge_mode` still exists server-side.
    expect(source).toContain("const effectiveJudgeEnabled = judgeRequired;");
    expect(source).not.toContain("setEnableJudge");
    expect(advanced).not.toContain("onEnableJudgeChange");
  });

  it("names the scoring model as the scorer, never as the system under test", () => {
    expect(advanced).toContain('label="Scoring model"');
    expect(advanced).not.toContain('label="LLM judge"');
    expect(advanced).not.toContain('aria-label="Judge model"');
  });
});

describe("step 4 fixed-pane layout", () => {
  const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");
  const step = source.slice(source.indexOf('id="evaluation-step-4"'), source.indexOf("function DatasetPreviewDialog"));
  // Two panes of step 4 now live in their own files. The guard follows the
  // markup rather than passing because the assertion moved out of range.
  const scoring = readFileSync(new URL("./scoring-summary.tsx", import.meta.url), "utf8");
  const advanced = readFileSync(new URL("./advanced-settings.tsx", import.meta.url), "utf8");
  const runBar = readFileSync(new URL("./run-bar.tsx", import.meta.url), "utf8");

  it("puts execution depth above the catalog and Scoring row", () => {
    expect(step).toContain("xl:grid-rows-[auto_minmax(0,1fr)_auto]");
    expect(step).not.toContain("xl:grid-rows-[minmax(0,1fr)_auto_auto_auto]");
    expect(step).toContain("border-b px-5 py-4 xl:col-span-2 xl:col-start-1 xl:row-start-1");
    expect(step).toContain("flex min-h-0 flex-col overflow-y-auto border-t xl:col-start-2 xl:row-start-2");
    // The run bar owns the last grid row; it lives in its own file now.
    expect(runBar).toContain("xl:col-span-2 xl:col-start-1 xl:row-start-3");
  });

  it("locks the fields an Assignment decides, and keeps Clear reachable", () => {
    // The backend resolves a governed run from the Assignment's manifest, where
    // `manifest.metric_ids` wins over anything the form sends. Leaving checks and
    // depth editable let a user change a run that could not change.
    expect(step).toContain('<fieldset disabled={lockedByAssignment} className="contents">');
    // Clear must sit outside that fieldset or it disables itself along with
    // everything else, stranding the user on the Assignment they picked.
    const clear = step.indexOf("Clear Assignment");
    const lock = step.indexOf("<fieldset disabled={lockedByAssignment}");
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(lock);
  });

  it("keeps Scoring visible while secondary configuration shares a bounded region", () => {
    // Selected checks and configuration share the aside's single scroll area.
    expect(step).toContain("flex min-h-0 flex-col overflow-y-auto");
    expect(scoring).not.toContain("xl:h-[48%]");
    expect(scoring).not.toContain("xl:overflow-y-auto");
    expect(step).not.toContain("xl:max-h-[300px]");
    expect(scoring).not.toContain("xl:max-h-[300px]");
  });

  it("keeps Tools in the depth band and Advanced always visible", () => {
    expect(step).toContain('<details className="group mt-4 border-t">');
    expect(step).toContain("max-h-56 overflow-y-auto pb-2");
    expect(advanced).toContain('<section className="border-t px-5 pb-2" aria-labelledby="advanced-configurations-title">');
    expect(step).not.toContain('group-open:hidden">\n                    Judge');
  });

  it("explains depth requirements and renders distinct selected cards", () => {
    expect(step).toContain("xl:grid-cols-[minmax(0,1.3fr)_minmax(380px,0.8fr)]");
    expect(step).toContain("Minimum is");
    expect(step).toContain("Too shallow —");
    expect(step).toContain("mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3");
    expect(step).toContain("selected ? <Check");
  });
});

describe("run launch navigation", () => {
  const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

  it("sends a single launch to the run history and leaves a comparison on its panel", () => {
    // Previously both launches pushed to one run's page. For a comparison that
    // discarded the panel built to show every arm — including an arm that did
    // not start, reported by a setStatus the navigation unmounted.
    expect(source.match(/router\.push\(evaluationRunsHref\(/g)).toHaveLength(1);
    expect(source).not.toContain("router.push(runDetailsHref(");
    expect(source).toContain("Evaluation started. Opening run history…");
  });
});

describe("existing responses workbench", () => {
  const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");
  const targetStep = source.slice(
    source.indexOf('id="evaluation-step-3"'),
    source.indexOf('id="evaluation-step-4"'),
  );

  it("uses dataset responses instead of rendering or requiring a target", () => {
    expect(targetStep).toContain('chosenKind === "provided"');
    expect(targetStep).toContain("No agent, target model");
    expect(source).toContain('kind === "provided" ? true');
    expect(source).toContain('"Continue to scoring model"');
    expect(source).not.toContain("A run sends the question to its target");
    expect(source).toContain("reason && !tooShallow");
  });
});

function dataset(name: string, overrides: Partial<DatasetInfo> = {}): DatasetInfo {
  return {
    dataset_id: `dataset-${name}`,
    name,
    tenant_id: "tenant-classroom",
    product_id: "proofgrove",
    version_number: 1,
    status: "PUBLISHED",
    parent_dataset_name: null,
    dqs: null,
    change_reason: null,
    created_by: "test",
    ...overrides,
  };
}

const template: QualityContractTemplate = {
  template_id: "qc_tpl_response_clarity",
  metric_id: "quality.response_clarity",
  name: "Response Clarity",
  description: "Evaluate response clarity.",
  domain: "communication",
  criteria: "The response is clear.",
  evaluation_steps: ["Review the response."],
  threshold: 0.7,
  evaluation_params: ["input", "actual_output"],
  tags: ["communication"],
  scenario: "llm_core",
};

describe("evaluation workbench scoring resolution", () => {
  it("counts template metrics only when the template control is enabled", () => {
    expect(
      resolveScoringMetricIds(
        ["llm.correctness"],
        [template],
        [template.template_id],
        true,
      ),
    ).toEqual(["llm.correctness", "quality.response_clarity"]);

    expect(
      resolveScoringMetricIds(
        ["llm.correctness"],
        [template],
        [template.template_id],
        false,
      ),
    ).toEqual(["llm.correctness"]);
  });

  it("deduplicates a metric selected directly and through a template", () => {
    expect(
      resolveScoringMetricIds(
        ["quality.response_clarity"],
        [template],
        [template.template_id],
        true,
      ),
    ).toEqual(["quality.response_clarity"]);
  });
});

describe("dataset picker paging", () => {
  it("requests the first bounded page and appends the next page", async () => {
    const fetchPage = async (query: { limit: number; cursor?: string; status?: string }): Promise<DatasetPage> => {
      expect(query.limit).toBe(50);
      expect(query.status).toBe("PUBLISHED");
      return query.cursor
        ? { items: [dataset("second")], total: 2, limit: 50, offset: 1, next_cursor: null }
        : { items: [dataset("first")], total: 2, limit: 50, offset: 0, next_cursor: "1" };
    };

    const first = await loadDatasetPickerPage([], null, fetchPage);
    expect(first.items.map((item) => item.name)).toEqual(["first"]);
    expect(first.total).toBe(2);
    const second = await loadDatasetPickerPage(first.items, first.nextCursor, fetchPage);
    expect(second.items.map((item) => item.name)).toEqual(["first", "second"]);
    expect(second.nextCursor).toBeNull();
    expect(datasetPickerCountLabel(second.items.length, second.total)).toBe(
      "Showing 2 of 2 published datasets",
    );
  });

  it("seeds a launcher-selected dataset that is missing from the first page", async () => {
    const requested = dataset("page-two-only");
    const fetched: string[] = [];
    const result = await ensureRequestedDataset([dataset("first")], "page-two-only", async (name) => {
      fetched.push(name);
      return requested;
    });

    expect(fetched).toEqual(["page-two-only"]);
    expect(result.items.map((item) => item.name)).toEqual(["first", "page-two-only"]);
    expect(result.unreadable).toBeNull();
  });

  it("does not refetch a dataset the loaded page already contains", async () => {
    const result = await ensureRequestedDataset([dataset("first")], "first", async () => {
      throw new Error("should not fetch");
    });

    expect(result.items.map((item) => item.name)).toEqual(["first"]);
    expect((await ensureRequestedDataset(result.items, null, async () => dataset("other"))).items).toBe(
      result.items,
    );
  });

  it("reports the requested dataset when it cannot be read, and keeps the inventory", async () => {
    const current = [dataset("first")];
    const result = await ensureRequestedDataset(current, "missing", async () => {
      throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Dataset not found." });
    });

    expect(result.items).toBe(current);
    // Silence here would leave the page claiming the type was inferred from this dataset.
    expect(result.unreadable).toBe("missing");
    expect(requestedDatasetUnavailableNotice(result.unreadable!)).toContain("missing");
    expect(requestedDatasetUnavailableNotice(result.unreadable!)).toContain("could not be read");
  });

  it("refuses a dataset that is readable but not published", async () => {
    // The paged inventory is PUBLISHED-only, but `?dataset=` fetches by name and
    // bypasses it. Without this, a link to a draft seeded the form with evidence a
    // run may not use, and only failed later.
    const current = [dataset("published-one")];
    const result = await ensureRequestedDataset(current, "draft-one", async () =>
      dataset("draft-one", { status: "DRAFT" }),
    );

    expect(result.items).toBe(current);
    expect(result.unreadable).toBe("draft-one");
    expect(requestedDatasetUnavailableNotice("draft-one")).toContain("not published");
  });

  it("accepts a published dataset fetched by name", async () => {
    const current = [dataset("published-one")];
    const result = await ensureRequestedDataset(current, "published-two", async () =>
      dataset("published-two", { status: "PUBLISHED" }),
    );

    expect(result.items).toHaveLength(2);
    expect(result.unreadable).toBeNull();
  });
});

describe("dataset picker inventory", () => {
  it("lists every published dataset, whatever its rows carry beyond the question", () => {
    // Both modes send the question; metadata only decides which metrics can be graded.
    // Nothing here is filtered or marked per mode.
    const options = datasetPickerOptions([
      dataset("prompt-only", { missing_row_fields: [] }),
      dataset("tool-ground-truth", { missing_row_fields: [] }),
    ]);

    expect(options.map((option) => option.name)).toEqual(["prompt-only", "tool-ground-truth"]);
  });

  it("keeps an incomplete dataset listed so the picker can say what is missing", () => {
    const options = datasetPickerOptions([
      dataset("answers-only", { missing_row_fields: ["question"] }),
      dataset("questions-only", { missing_row_fields: ["expected output"] }),
    ]);

    expect(options.map((option) => option.name)).toEqual(["answers-only", "questions-only"]);
    expect(options.map((option) => datasetIsUnusable(option.dataset, "llm"))).toEqual([true, true]);
    expect(datasetMissingFields(options[1]!.dataset)).toEqual(["expected output"]);
  });

  it("treats an uncomputed verdict as unknown, and keeps it selectable", () => {
    const options = datasetPickerOptions([dataset("legacy", { missing_row_fields: null })]);

    expect(datasetIsUnusable(options[0]!.dataset, "provided")).toBe(false);
  });

  it("still collapses a lineage to its latest published version", () => {
    const options = datasetPickerOptions([
      dataset("support"),
      dataset("support-v2", { parent_dataset_name: "support", version_number: 2 }),
      dataset("draft", { status: "DRAFT" }),
    ]);
    expect(options.map((option) => option.name)).toEqual(["support-v2"]);
  });
});

describe("metric family grouping", () => {
  it("keeps the expanded catalog readable and ordered", () => {
    const metrics: MetricCatalogEntry[] = [
      { metric_id: "nlp.bleu", name: "BLEU", description: "BLEU" },
      { metric_id: "agent.tool_input_accuracy", name: "Tool input", description: "Tool input" },
      { metric_id: "llm.correctness", name: "Correctness", description: "Correctness" },
    ];

    expect(groupMetricsByFamily(metrics).map((family) => family.label)).toEqual([
      "Guidelines & policy",
      "Agent execution",
      "Text similarity",
    ]);
  });

  it("promotes the effective scope only when selected checks require deeper evidence", () => {
    const metrics: MetricCatalogEntry[] = [
      { metric_id: "llm.correctness", name: "Correctness", description: "Correctness", scenario: "llm_core" },
      { metric_id: "ops.latency", name: "Latency", description: "Latency" },
      { metric_id: "agent.tool_call_accuracy", name: "Tool calls", description: "Tools", required_evidence_categories: ["tool_calls"] },
    ];

    expect(requiredScopeForMetricIds(metrics, ["llm.correctness", "ops.latency"])).toBe("final_response");
    expect(requiredScopeForMetricIds(metrics, ["llm.correctness", "agent.tool_call_accuracy"])).toBe("tool_interactions");
    expect(requiredScopeForMetricIds(metrics, ["llm.correctness"])).toBe("final_response");
    expect(recommendedMetricIdsForScope("tool_interactions")).toContain("agent.tool_call_accuracy");
    expect(metricIdsCompatibleWithScope(metrics, ["llm.correctness", "agent.tool_call_accuracy", "ops.latency"], "final_response")).toEqual(["llm.correctness", "ops.latency"]);
  });
});

describe("run failure display", () => {
  it("keeps the specific message and detail list of a coded readiness failure", () => {
    const failure = describeRunFailure(
      new ApiError({
        status: 422,
        code: "VALIDATION_FAILED",
        message: "Tool call spans were not captured. The dataset has no tool interactions.",
        details: [
          { code: "evidence_missing", message: "Tool call spans were not captured." },
          { code: "scope_unsupported", message: "The dataset has no tool interactions." },
        ],
      }),
    );

    // Never the generic "review the highlighted fields" copy: the backend's
    // exact reasons stay visible, both as the headline and as the issue list.
    expect(failure.message).toBe(
      "Tool call spans were not captured. The dataset has no tool interactions.",
    );
    expect(failure.detailMessages).toEqual([
      "Tool call spans were not captured.",
      "The dataset has no tool interactions.",
    ]);
    expect(failure.projectError).toBeNull();
    expect(failure.targetError).toBeNull();
  });

  it("appends recovery guidance to a coded failure", () => {
    const failure = describeRunFailure(
      new ApiError({
        status: 422,
        code: "exact_rerun_source_required",
        message: "exact_rerun requires source_run_id naming the historical run.",
        recovery: "Pick a source run and try again.",
      }),
    );
    expect(failure.message).toBe(
      "exact_rerun requires source_run_id naming the historical run. Pick a source run and try again.",
    );
  });

  it("attaches project problems to the Tracing Project control", () => {
    const byField = describeRunFailure(
      new ApiError({
        status: 422,
        code: "VALIDATION_FAILED",
        message: "Some information is invalid.",
        details: [{ code: "missing", field: "project_id", message: "Field required" }],
      }),
    );
    expect(byField.projectError).toBe("Field required");
    expect(byField.detailMessages).toEqual(["project_id: Field required"]);

    const byMessage = describeRunFailure(
      new ApiError({
        status: 422,
        code: "VALIDATION_FAILED",
        message:
          "Selected Project is an internal catalog registry, not a system tracing workspace",
      }),
    );
    expect(byMessage.projectError).toBe(
      "Selected Project is an internal catalog registry, not a system tracing workspace",
    );
  });

  it("attaches target, dataset, scope, and check problems to their controls", () => {
    const cases = [
      ["agent_id", "targetError"],
      ["dataset_name", "datasetError"],
      ["evaluation_scope", "scopeError"],
      ["active_metrics", "checksError"],
    ] as const;

    for (const [field, slot] of cases) {
      const failure = describeRunFailure(
        new ApiError({ status: 422, code: "invalid", field, message: `${field} is invalid` }),
      );
      expect(failure[slot]).toBe(`${field} is invalid`);
    }
  });

  it("passes through plain errors unchanged", () => {
    const failure = describeRunFailure(new Error("Evaluation started without a run identifier."));
    expect(failure.message).toBe("Evaluation started without a run identifier.");
    expect(failure.detailMessages).toEqual([]);
    expect(failure.projectError).toBeNull();
  });
});


describe("tracing project options", () => {
  function project(overrides: Partial<TraceProject> = {}): TraceProject {
    return {
      project_id: "project-1",
      tenant_id: "tenant-classroom",
      name: "Support agent",
      system_type: "agent",
      owner: "quality",
      status: "active",
      purpose: "system",
      trace_count: 0,
      last_activity_at: null,
      classification_state: "classified",
      ...overrides,
    };
  }

  it("never offers an archived project, or the unassigned catch-all", () => {
    // The backend rejects archived Projects with "Selected Project is archived
    // and cannot receive new evaluation runs". They are dropped from the
    // inventory rather than shown disabled, so no later lookup can resolve one.
    const offered = selectableTracingProjects([
      project(),
      project({ project_id: "archived-1", status: "archived" }),
      project({ project_id: "unassigned" }),
    ]);
    expect(offered.map((item) => item.project_id)).toEqual(["project-1"]);
  });

  it("keeps a historical project visible but disabled — classifying it is an action", () => {
    const historical = tracingProjectOptionState(project({ purpose: "catalog_registry" }));
    expect(historical.disabled).toBe(true);
    expect(historical.note).toContain("classification");
    expect(selectableTracingProjects([project({ purpose: "catalog_registry" })])).toHaveLength(1);
  });

  it("allows an active system project", () => {
    expect(tracingProjectOptionState(project())).toEqual({ disabled: false, note: "" });
  });
});

describe("dataset status for the write-back opt-in", () => {
  // Regression: the paged list endpoint returns `dataset_name` and omits
  // `name`. A lookup matching `entry.name` therefore never resolved, so the
  // dialog saw a null status, decided the dataset was mutable, hid the
  // "copy into a new draft version" opt-in — and every write-back to a
  // published dataset came back 409 with no way for the operator to clear it.
  const published = {
    dataset_id: "ds-1",
    dataset_name: "Codex E2E Agent_v5",
    tenant_id: "tenant-classroom",
    product_id: "proofgrove",
    status: "PUBLISHED",
    version_number: 5,
    parent_dataset_name: "Codex E2E Agent_v4",
    dqs: null,
    change_reason: null,
    created_by: "test",
    record_count: 2,
  } as unknown as DatasetInfo;

  it("resolves an entry that carries only dataset_name", () => {
    const options = datasetPickerOptions([published]);
    const match = options.find((option) => option.name === "Codex E2E Agent_v5");
    expect(match).toBeDefined();
    expect(match?.dataset.status).toBe("PUBLISHED");
  });

  it("does not resolve by the absent `name` field", () => {
    // Pins why the picker options exist: the raw entry has no `name`, so any
    // lookup keyed on it silently yields undefined rather than failing.
    expect((published as { name?: string }).name).toBeUndefined();
  });
});

describe("retargeting the run at a freshly published version", () => {
  // Regression: publishing from the write-back dialog set the dataset name to
  // a version that was not in the picker inventory — the list had been paged in
  // before that version existed. Selecting a name with no matching option
  // selects nothing, so the button looked inert.
  const base = {
    dataset_id: "ds-5",
    dataset_name: "Codex E2E_v5",
    tenant_id: "tenant-classroom",
    product_id: "proofgrove",
    status: "PUBLISHED",
    version_number: 5,
    parent_dataset_name: null,
    dqs: null,
    change_reason: null,
    created_by: "test",
  } as unknown as DatasetInfo;

  const published = {
    ...base,
    dataset_id: "ds-8",
    dataset_name: "Codex E2E_v8",
    version_number: 8,
    parent_dataset_name: "Codex E2E_v5",
  } as unknown as DatasetInfo;

  it("is not selectable until it is seeded into the inventory", () => {
    const options = datasetPickerOptions([base]).map((option) => option.name);
    expect(options).not.toContain("Codex E2E_v8");
  });

  it("becomes the selected option once seeded, replacing the older version", async () => {
    const seeded = await ensureRequestedDataset([base], "Codex E2E_v8", async () => published);
    const options = datasetPickerOptions(seeded.items).map((option) => option.name);
    // Latest published per lineage: the new version wins, the old one drops.
    expect(options).toContain("Codex E2E_v8");
    expect(options).not.toContain("Codex E2E_v5");
  });

  it("leaves the picker usable when the new version cannot be read back", async () => {
    const seeded = await ensureRequestedDataset([base], "Codex E2E_v8", async () => {
      throw new Error("gone");
    });
    expect(seeded.unreadable).toBe("Codex E2E_v8");
    expect(datasetPickerOptions(seeded.items).map((o) => o.name)).toEqual(["Codex E2E_v5"]);
  });
});

describe("assignment catalogue restore", () => {
  const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

  it("restores an explicit Assignment from query params without inference", () => {
    expect(source).toContain('import { assignmentFromSearchParams } from "@/lib/assignment-links"');
    expect(source).toContain("assignmentFromSearchParams(searchParams)");
    expect(source).toContain("Choose a dataset, then run.");
    expect(source).toContain("unavailable or archived");
  });
});


describe("comparison launch side-effect ordering", () => {
  // Execute the actual nested callback without copying its implementation or
  // mounting the entire four-stage setup just to control one failed request.
  const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");
  const callback = source.slice(source.indexOf("async function launchComparison("), source.indexOf("async function runEvaluation("));
  const compiled = transpileModule(callback, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  function arrange(preparedKind: "provided" | "llm" | null = null) {
    const context = {
      api: { tenant: vi.fn().mockResolvedValue({ tenant_id: "tenant-acme" }) },
      evaluationApi: { createRunFromDataset: vi.fn().mockResolvedValueOnce({ run_id: "a", status: "pending" }).mockResolvedValueOnce({ run_id: "b", status: "pending" }) },
      compareAxis: "prompts", comparePromptRefs: ["p1", "p2"],
      withPrompt: (request: object) => request, datasetName: "dataset", evaluationName: "Compare",
      setStatus: vi.fn(), rememberActiveRunId: vi.fn(), rememberLaunch: vi.fn(),
      setFormDirty: vi.fn(), forgetRunDraft: vi.fn(), kind: "llm", preparedKind,
      setComparisonGroupingFailed: vi.fn(), setComparisonLaunchId: vi.fn(), setComparisonTargets: vi.fn(),
      userFacingError: () => "Launch failed",
    };
    const launch = new Function(...Object.keys(context), `${compiled}; return launchComparison;`)(...Object.values(context)) as (request: object) => Promise<void>;
    return { context, launch };
  }

  it("preserves the general draft when a prepared experiment is launched", async () => {
    const { context, launch } = arrange("llm");
    await launch({});
    expect(context.evaluationApi.createRunFromDataset).toHaveBeenCalledTimes(2);
    expect(context.forgetRunDraft).not.toHaveBeenCalled();
  });

  it("does not create jobs when the current tenant cannot be resolved", async () => {
    const { context, launch } = arrange();
    context.api.tenant.mockRejectedValue(new Error("Tenant unavailable"));
    await expect(launch({})).rejects.toThrow("Tenant unavailable");
    expect(context.evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });

  it("keeps started runs and a failed arm without another tenant request", async () => {
    const { context, launch } = arrange();
    context.api.tenant.mockImplementation(async () => {
      if (context.evaluationApi.createRunFromDataset.mock.calls.length) throw new Error("Post-launch tenant unavailable");
      return { tenant_id: "tenant-acme" };
    });
    context.evaluationApi.createRunFromDataset.mockReset().mockResolvedValueOnce({ run_id: "a", status: "pending" }).mockRejectedValueOnce(new Error("Second arm unavailable"));
    await launch({});
    expect(context.api.tenant).toHaveBeenCalledTimes(1);
    expect(context.setComparisonTargets).toHaveBeenCalledWith([
      { modelId: "p1", runId: "a", status: "pending", error: null },
      { modelId: "p2", runId: null, status: null, error: "Launch failed" },
    ]);
    expect(context.rememberLaunch).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-acme", targets: expect.arrayContaining([expect.objectContaining({ runId: "a" })]) }));
  });
});
