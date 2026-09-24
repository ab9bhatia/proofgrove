import { describe, expect, it } from "vitest";
import type { DatasetInfo, PromptVersion, TraceProject } from "@/lib/api";
import { NOVA_PREPARED, preparedArtifacts, preparedDataset, preparedEvaluationHref, preparedEvaluationKind, preparedExperimentName, type PreparedInventory } from "./prepared-evaluation";

function inventory(): PreparedInventory {
  const dataset = { status: "PUBLISHED", record_count: 8, missing_row_fields: [], missing_provided_response: false } as unknown as DatasetInfo;
  return {
    golden: { ...dataset, dataset_name: NOVA_PREPARED.goldenDataset },
    rehearsal: { ...dataset, dataset_name: NOVA_PREPARED.rehearsalDataset },
    metrics: NOVA_PREPARED.metrics.map((metric_id) => ({ metric_id, name: metric_id, description: "Text overlap", available_in_run: true })),
    prompts: [1, 2].map((version) => ({ prompt_id: NOVA_PREPARED.promptId, version, content: "Refund policy", archived_at: null }) as PromptVersion),
    projects: [{ project_id: NOVA_PREPARED.project, status: "active", purpose: "system" } as TraceProject],
    models: [{ model_id: "configured-model", name: "Actual configured model", source: "custom" }],
    lab: { live: true, model: "configured-model" },
  };
}

describe("prepared Nova entry isolation", () => {
  it("requires explicit opt-in and never applies to reruns, assignments or unrelated datasets", () => {
    expect(preparedEvaluationKind(new URLSearchParams(), "provided")).toBeNull();
    for (const suffix of ["rerun=1", "fromRun=old-run", "run=old-run", "assignment=policy", "assignmentVersion=1", "dataset=my-cases"]) {
      expect(preparedEvaluationKind(new URLSearchParams(`prepared=nova-refunds&${suffix}`), "provided")).toBeNull();
    }
    expect(preparedEvaluationKind(new URLSearchParams("prepared=nova-refunds"), "agent")).toBeNull();
    expect(preparedEvaluationKind(new URLSearchParams("prepared=unknown"), "llm")).toBeNull();
  });
  it("creates fresh links with the correct response source and no rerun parameters", () => {
    for (const kind of ["llm", "provided"] as const) {
      const params = new URL(preparedEvaluationHref(kind), "http://localhost").searchParams;
      expect(preparedEvaluationKind(params, kind)).toBe(kind);
      expect(params.get("dataset")).toBe(preparedDataset(kind));
      expect(params.has("fromRun")).toBe(false);
    }
  });
  it("gives new experiments distinct, understandable names", () => {
    expect(preparedExperimentName("provided", new Date("2026-09-24T08:00:00.000Z"))).toBe("Nova refunds · offline rehearsal · 2026-09-24T08:00:00.000Z");
    expect(preparedExperimentName("llm", new Date("2026-09-24T08:00:00.001Z"))).not.toEqual(preparedExperimentName("llm", new Date("2026-09-24T08:00:00.000Z")));
  });
});

describe("prepared artifacts readiness", () => {
  it("resolves exact metrics, prompt version and the actual configured model", () => {
    const ready = preparedArtifacts(inventory());
    expect(ready.liveReady).toBe(true);
    expect(ready.offlineReady).toBe(true);
    expect(ready.metricIds).toEqual(["nlp.f1_score", "nlp.rouge", "nlp.bleu"]);
    expect(ready.prompt?.version).toBe(2);
    expect(ready.model?.model_id).toBe("configured-model");
  });
  it("selects the configured endpoint when two providers share a model name", () => {
    const input = inventory();
    const local = { ...input.models[0], endpoint: "http://127.0.0.1:11434/v1" };
    const cloud = { ...input.models[0], endpoint: "https://api.openai.com/v1" };
    const ready = preparedArtifacts({ ...input, models: [local, cloud], lab: { live: true, model: "configured-model", endpoint: cloud.endpoint } });
    expect(ready.model).toBe(cloud);
  });
  it("keeps offline runnable without prompts, provider configuration or models", () => {
    const ready = preparedArtifacts({ ...inventory(), prompts: [], models: [], lab: { live: false, model: null } });
    expect(ready.offlineReady).toBe(true);
    expect(ready.liveReady).toBe(false);
    expect(ready.model).toBeNull();
  });
  it("never substitutes a catalog example for an unavailable configured model", () => {
    expect(preparedArtifacts({ ...inventory(), lab: { live: true, model: "missing-model" } }).liveReady).toBe(false);
    expect(preparedArtifacts({ ...inventory(), lab: { live: false, model: "configured-model" } }).model).toBeNull();
    expect(preparedArtifacts({ ...inventory(), lab: null }).liveReady).toBe(false);
  });
  it("blocks both starts when an exact metric or the active project is missing", () => {
    const input = inventory();
    for (const incomplete of [
      { ...input, metrics: input.metrics.slice(0, 2) },
      { ...input, metrics: input.metrics.map((m) => ({ ...m, available_in_run: false })) },
      { ...input, projects: input.projects.map((p) => ({ ...p, status: "archived" as const })) },
      { ...input, projects: input.projects.map((p) => ({ ...p, purpose: "catalog_registry" as const })) },
    ]) {
      const ready = preparedArtifacts(incomplete);
      expect(ready.offlineReady).toBe(false);
      expect(ready.liveReady).toBe(false);
    }
  });
  it("requires confirmed stored-response coverage and keeps draft datasets out", () => {
    const input = inventory();
    for (const missing_provided_response of [undefined, null, true]) {
      expect(preparedArtifacts({ ...input, rehearsal: { ...input.rehearsal!, missing_provided_response } }).offlineReady).toBe(false);
    }
    expect(preparedArtifacts({ ...input, rehearsal: { ...input.rehearsal!, status: "DRAFT" } }).offlineReady).toBe(false);
    expect(preparedArtifacts({ ...input, golden: { ...input.golden!, missing_row_fields: ["expected output"] } }).liveReady).toBe(false);
    expect(preparedArtifacts({ ...input, prompts: input.prompts.map((p) => ({ ...p, archived_at: "2026-09-24" })) }).liveReady).toBe(false);
  });
});
