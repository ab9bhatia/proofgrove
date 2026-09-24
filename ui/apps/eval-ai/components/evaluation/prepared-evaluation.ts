import type { DatasetInfo, LlmCatalogEntry, MetricCatalogEntry, PromptVersion, TraceProject } from "@/lib/api";
import { findSelectedModel, modelSelectionId } from "@/lib/model-selection";
import type { EvaluationKind } from "@/lib/evaluation-form";

export const NOVA_PREPARED = {
  id: "nova-refunds",
  goldenDataset: "nova_refunds_golden_v1",
  rehearsalDataset: "nova_refunds_rehearsal_v1",
  project: "nova-customer-operations",
  promptId: "nova-refund-assistant",
  promptVersion: 2,
  metrics: ["nlp.f1_score", "nlp.rouge", "nlp.bleu"],
} as const;

export type PreparedKind = "llm" | "provided";
export interface LabAvailability { live: boolean; model: string | null; provider?: string; mode?: string; endpoint?: string | null }
export interface PreparedInventory {
  golden: DatasetInfo | null;
  rehearsal: DatasetInfo | null;
  prompts: PromptVersion[];
  metrics: MetricCatalogEntry[];
  projects: TraceProject[];
  models: LlmCatalogEntry[];
  lab: LabAvailability | null;
}

/** A preset is an explicit, fresh entry. Historical runs and other authored links win. */
export function preparedEvaluationKind(params: Pick<URLSearchParams, "get">, kind: EvaluationKind): PreparedKind | null {
  if (params.get("prepared") !== NOVA_PREPARED.id || kind === "agent") return null;
  if (["rerun", "fromRun", "run", "assignment", "assignmentVersion"].some((key) => params.get(key))) return null;
  const dataset = kind === "llm" ? NOVA_PREPARED.goldenDataset : NOVA_PREPARED.rehearsalDataset;
  if (params.get("dataset") && params.get("dataset") !== dataset) return null;
  return kind;
}

export function preparedDataset(kind: PreparedKind): string {
  return kind === "llm" ? NOVA_PREPARED.goldenDataset : NOVA_PREPARED.rehearsalDataset;
}

export function preparedEvaluationHref(kind: PreparedKind): string {
  return `/evaluate?${new URLSearchParams({ type: kind, prepared: NOVA_PREPARED.id, dataset: preparedDataset(kind) })}`;
}

export function preparedArtifacts(inventory: PreparedInventory) {
  const usable = (dataset: DatasetInfo | null, provided: boolean) => Boolean(
    dataset?.status === "PUBLISHED" && (dataset.record_count ?? 0) > 0 &&
    !dataset.missing_row_fields?.length && (!provided || dataset.missing_provided_response === false),
  );
  const metricIds = NOVA_PREPARED.metrics.filter((id) => inventory.metrics.some((m) => m.metric_id === id && m.available_in_run !== false));
  const prompt = inventory.prompts.find((p) => p.prompt_id === NOVA_PREPARED.promptId && p.version === NOVA_PREPARED.promptVersion && !p.archived_at && p.content.trim()) ?? null;
  const promptVersions = inventory.prompts.filter((p) => p.prompt_id === NOVA_PREPARED.promptId && !p.archived_at && p.content.trim()).map((p) => p.version).sort((a, b) => a - b);
  const project = inventory.projects.find((p) => p.project_id === NOVA_PREPARED.project && p.status === "active" && p.purpose === "system") ?? null;
  const model = inventory.lab?.live && inventory.lab.model
    ? findSelectedModel(inventory.models, inventory.lab.endpoint ? modelSelectionId({ model_id: inventory.lab.model, endpoint: inventory.lab.endpoint }) : inventory.lab.model)
    : null;
  const metricsReady = metricIds.length === NOVA_PREPARED.metrics.length;
  const goldenReady = usable(inventory.golden, false);
  const rehearsalReady = usable(inventory.rehearsal, true);
  return { metricIds, prompt, promptVersions, project, model, goldenReady, rehearsalReady, metricsReady,
    offlineReady: Boolean(rehearsalReady && metricsReady && project),
    liveReady: Boolean(goldenReady && metricsReady && project && prompt && model),
  };
}

export async function readLabAvailability(): Promise<LabAvailability> {
  const response = await fetch("/api/lab-mode", { cache: "no-store" });
  if (!response.ok) throw new Error("Model configuration could not be read.");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") throw new Error("Invalid model configuration.");
  const value = body as Record<string, unknown>;
  return {
    live: value.live === true,
    model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : null,
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
    ...(typeof value.mode === "string" ? { mode: value.mode } : {}),
    ...(typeof value.endpoint === "string" ? { endpoint: value.endpoint } : {}),
  };
}

export function preparedExperimentName(kind: PreparedKind, now = new Date()): string {
  return `Nova refunds · ${kind === "provided" ? "offline rehearsal" : "live model"} · ${now.toISOString()}`;
}
