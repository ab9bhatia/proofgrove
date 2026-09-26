"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Ban,
  Check,
  Download,
  Loader2,
  Sparkles,
  UploadCloud,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@evalai/shared/utils";
import { SegmentedChoice } from "@/components/segmented-choice";
import {
  agentsApi,
  api,
  evaluationApi,
  fullName,
  type LlmCatalogEntry,
  type ToolServer,
} from "@/lib/api";
import {
  type GenerationJob,
  datasetGenerationApi,
  describeGenerationPhase,
  generationProgressLabel,
  isCancellableGenerationPhase,
  isTerminalGenerationPhase,
  readGenerationJobParam,
  watchGenerationJob,
  writeGenerationJobParam,
} from "@/lib/dataset-generation";
import { ApiError } from "@/lib/api-errors";
import { findSelectedModel, modelSelectionId } from "@/lib/model-selection";
import { inputClass } from "@/components/evaluation/form-primitives";
import {
  DatasetModePicker,
  type DatasetOnboardMode,
} from "@/components/dataset-mode-picker";

type GenerationMethod = "llms" | "tools";

const METHOD_OPTIONS: {
  id: GenerationMethod;
  label: string;
  desc: string;
  details: string[];
  icon: typeof Sparkles;
}[] = [
  {
    id: "llms",
    label: "LLMs",
    desc: "Generate data using powerful LLMs with configurable prompts.",
    details: [
      "Provide one generation prompt / instruction.",
      "Set Size to the number of CSV rows to create.",
      "Proofgrove calls the selected generation model to synthesize records directly.",
      "No MCP grounding is used for this method.",
    ],
    icon: Sparkles,
  },
  {
    id: "tools",
    label: "Agent Orchestration",
    desc: "Ground generation through MCP tools, then synthesize evaluation cases.",
    details: [
      "Provide one generation prompt / instruction (same as LLMs).",
      "Set Size to the number of CSV rows to create.",
      "Proofgrove expands the prompt into seed lookups, grounds each via the selected MCP tool, then synthesizes golden rows.",
      "Uses the platform default synthesis model (no generation model picker).",
    ],
    icon: Wrench,
  },
];

const DEFAULT_LLM_PROMPT =
  "Generate realistic customer-support evaluation cases covering refunds, account verification, and policy clarifications. Each case should include a user question and the ideal support response.";

export function GenerationMethodPicker({
  value,
  onChange,
}: {
  value: GenerationMethod | null;
  onChange: (value: GenerationMethod) => void;
}) {
  // Same control as the Generate / Import CSV choice above it. These were two
  // different shapes for the same kind of decision — a segmented switch and a
  // pair of bordered cards with Select/Selected pills — which made one step of
  // one flow look like two unrelated screens.
  const active = METHOD_OPTIONS.find((option) => option.id === value) ?? null;

  return (
    <div className="space-y-2">
      <SegmentedChoice
        options={METHOD_OPTIONS.map((option) => ({
          value: option.id,
          label: option.label,
          hint: option.desc,
          icon: option.icon,
        }))}
        value={value}
        onChange={onChange}
        label="Generation method"
        idPrefix="generation-method"
      />
      {/* One description that follows the choice, rather than both competing
          for attention at once. */}
      <p id="generation-method-selected-description" className="text-xs leading-5 text-muted-foreground">
        {active ? active.desc : "Choose how the evaluation cases are produced."}
      </p>
    </div>
  );
}

export function DatasetActions({
  open,
  onOpenChange,
  onCreated,
}: {
  /** The form is now opened from the page header's "Add dataset" button, not a
   * launcher card this component drew itself. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void> | void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Durable generation job flow: the job id lives in the URL (?genJob=<id>)
  // so a reload — or navigating away and back — re-attaches to the same job.
  const watchedJobId = readGenerationJobParam(searchParams.toString());
  const [mode, setMode] = useState<DatasetOnboardMode | null>(watchedJobId ? "generate" : null);
  const [genJob, setGenJob] = useState<GenerationJob | null>(null);
  const [generationMethod, setGenerationMethod] = useState<GenerationMethod | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [productId, setProductId] = useState("proofgrove");
  const [file, setFile] = useState<File | null>(null);
  const [toolServers, setToolServers] = useState<ToolServer[]>([]);
  const [serverName, setServerName] = useState("");
  const [toolName, setToolName] = useState("");
  const [seeds, setSeeds] = useState(DEFAULT_LLM_PROMPT);
  const [maxRows, setMaxRows] = useState(5);
  const [domain, setDomain] = useState("");
  const [model, setModel] = useState("");
  const [generationModels, setGenerationModels] = useState<LlmCatalogEntry[]>([]);
  const [defaultGenerationModel, setDefaultGenerationModel] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [connectionIssue, setConnectionIssue] = useState(false);
  const [checkingConnection, setCheckingConnection] = useState(false);

  const selectedServer = toolServers.find((server) => server.name === serverName);
  const generationInstruction = useMemo(() => seeds.trim(), [seeds]);

  const loadGenerationResources = useCallback(async () => {
    setModelsLoading(true);
    setModelsError(null);
    setToolsError(null);
    const [serversResult, modelsResult, providersResult] = await Promise.allSettled([
      agentsApi.toolServers(), evaluationApi.listLlmCatalog(), evaluationApi.getModelProviders(),
    ]);
    if (serversResult.status === "fulfilled") {
      const listedServers = serversResult.value;
      setToolServers(listedServers);
      setServerName((current) => current || listedServers[0]?.name || "");
      setToolName((current) => current || listedServers[0]?.tools[0] || "");
    } else {
      setToolsError("Could not load grounding tools. Retry before using Agent Orchestration.");
    }
    if (modelsResult.status === "fulfilled") {
      const available = modelsResult.value.filter((entry) =>
        entry.source === "compass" || entry.source === "openai" || entry.source === "ollama",
      );
      setGenerationModels(available);
      const configuredDefault = providersResult.status === "fulfilled" ? providersResult.value.default : null;
      const initial = configuredDefault ? available.find((entry) =>
        entry.source === configuredDefault.provider && modelSelectionId(entry) === modelSelectionId(configuredDefault),
      ) : null;
      const initialSelection = initial ? modelSelectionId(initial) : "";
      setDefaultGenerationModel(initialSelection);
      setModel((current) => findSelectedModel(available, current) ? current : initialSelection);
    } else {
      setModelsError("Could not load generation models. Retry or check the Models page.");
    }
    setModelsLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening the dialog starts catalog I/O and its loading state
    if (open && mode === "generate") void loadGenerationResources();
  }, [open, mode, loadGenerationResources]);

  const setJobParam = useCallback(
    (jobId: string | null) => {
      const query = writeGenerationJobParam(searchParams.toString(), jobId);
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [searchParams, pathname, router],
  );

  // A reload (or navigating away and back) while a job is still running
  // should land on the open form showing its progress, not the closed header.
  useEffect(() => {
    if (watchedJobId) onOpenChange(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reopen when a watched job id appears; onOpenChange is a fresh closure per parent render
  }, [watchedJobId]);

  // Watch the job named in the URL until it reaches an honest terminal phase.
  // Watching is idempotent: a fresh mount (page navigation, reload) simply
  // re-attaches to the still-running server-side job.
  useEffect(() => {
    if (!watchedJobId) return;
    const controller = new AbortController();
    let alive = true;
    watchGenerationJob(watchedJobId, {
      signal: controller.signal,
      onUpdate: (job) => {
        if (alive) setGenJob(job);
      },
    })
      .then((terminal) => {
        if (alive && terminal.phase === "completed") void onCreated();
      })
      .catch((reason) => {
        if (!alive || controller.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not load the generation job.",
        );
      });
    return () => {
      alive = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onCreated is a fresh closure per parent render; the watch is keyed by job id only
  }, [watchedJobId]);

  // The panel shows the watched job; a genJob whose id no longer matches the
  // URL (the param was cleared externally) is stale and hidden.
  const visibleGenJob =
    genJob && (!watchedJobId || watchedJobId === genJob.job_id) ? genJob : null;

  function reportRequestError(reason: unknown) {
    const unavailable = reason instanceof ApiError && [0, 502, 503, 504].includes(reason.status);
    setConnectionIssue(unavailable);
    setError(reason instanceof Error ? reason.message : String(reason));
  }

  async function checkConnection() {
    setCheckingConnection(true);
    try {
      // Read-only probe through the same backend route used by dataset imports.
      // Never replay an interrupted create request automatically.
      await api.csvTemplate();
      setConnectionIssue(false);
      setError(null);
      setMessage("Connection is available. If an import was interrupted, check the dataset library for its name before retrying.");
    } catch (reason) {
      reportRequestError(reason);
    } finally {
      setCheckingConnection(false);
    }
  }

  async function tenantId() {
    return (await api.tenant()).tenant_id;
  }

  async function createMetadata(csvContent?: string) {
    return api.createDataset({
      dataset_name: name.trim(),
      tenant_id: await tenantId(),
      product_id: productId.trim() || "proofgrove",
      created_by: "proofgrove-ui",
      csv_content: csvContent,
    });
  }

  function resetGenerateForm() {
    setGenerationMethod(null);
    setName("");
    setDescription("");
    setDomain("");
    setMaxRows(5);
    setSeeds(DEFAULT_LLM_PROMPT);
    setModel(findSelectedModel(generationModels, defaultGenerationModel) ? defaultGenerationModel : "");
    setServerName(toolServers[0]?.name || "");
    setToolName(toolServers[0]?.tools[0] || "");
    setError(null);
    setMessage(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!mode) {
      setError("Select Generate Dataset or Import Dataset.");
      return;
    }
    setBusy(true);
    setConnectionIssue(false);
    setError(null);
    setMessage(null);
    try {
      if (!name.trim()) throw new Error("Dataset name is required.");
      if (mode === "generate") await generateDataset();
      if (mode === "import") await importDataset();
      await onCreated();
    } catch (reason) {
      reportRequestError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function generateDataset() {
    if (!generationMethod) {
      throw new Error("Select a Generation Method: LLMs or Agent Orchestration.");
    }
    if (!generationInstruction) {
      throw new Error("Enter a generation prompt / instruction.");
    }
    if (!maxRows || maxRows < 1) {
      throw new Error("Size must be at least 1 row.");
    }
    const selectedModel = findSelectedModel(generationModels, model);
    if (generationMethod === "llms" && (!selectedModel || modelsLoading || modelsError)) {
      throw new Error(modelsError || "Select an available generation model.");
    }
    if (generationMethod === "tools") {
      if (!selectedServer || !toolName) {
        throw new Error("Select a Proofgrove grounding MCP server and tool.");
      }
    }

    const job = await datasetGenerationApi.start({
      dataset_name: name.trim(),
      generation_method: generationMethod,
      grounding_url: generationMethod === "llms" ? null : selectedServer?.url ?? null,
      grounding_tool: generationMethod === "llms" ? undefined : toolName,
      seeds: [generationInstruction],
      num_rows: maxRows,
      domain: domain.trim(),
      product_id: productId.trim() || "proofgrove",
      model: generationMethod === "llms" ? selectedModel?.model_id : null,
      model_endpoint: generationMethod === "llms" ? selectedModel?.endpoint : null,
      agent: null,
    });
    // The durable job id goes into the URL; the watch effect takes over from
    // here, so navigation away and back re-attaches to the same job.
    setGenJob(job);
    setJobParam(job.job_id);
  }

  async function cancelGeneration(jobId: string) {
    try {
      setGenJob(await datasetGenerationApi.cancel(jobId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function dismissGenerationJob() {
    setGenJob(null);
    setJobParam(null);
  }

  async function importDataset() {
    if (!file) throw new Error("Choose a CSV dataset to import.");
    if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("Choose a CSV file.");
    if (file.size > 20_000_000) throw new Error("The CSV is too large. Use a file smaller than 20 MB.");
    const result = await createMetadata(await file.text());
    setFile(null);
    setMessage(
      `Imported ${result.record_count} records into “${fullName(result)}” as a Draft dataset.`,
    );
  }

  async function downloadTemplate() {
    setError(null);
    setMessage(null);
    setConnectionIssue(false);
    try {
      const template = await api.csvTemplate();
      const url = URL.createObjectURL(new Blob([template.csv], { type: "text/csv" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "evaluation-dataset-template.csv";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      reportRequestError(reason);
    }
  }

  if (!open) return null;

  return (
    <Dialog
      labelledBy="add-dataset-title"
      describedBy="add-dataset-description"
      scrimLabel="Close add dataset"
      onClose={() => onOpenChange(false)}
      width="max-w-5xl"
      className="overflow-y-auto p-5 sm:p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="add-dataset-title" className="text-lg font-semibold">Add dataset</h2>
          <p id="add-dataset-description" className="mt-1 text-sm text-muted-foreground">
            Choose a source, set its evaluation type, then continue through review.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onOpenChange(false)}
          aria-label="Close add dataset form"
        >
          <X className="mr-1.5 size-4" aria-hidden="true" />
          Close
        </Button>
      </div>

      <div className="mt-5">
        <p className="mb-2 text-sm font-medium">Source</p>
        <DatasetModePicker
          mode={mode}
          onModeChange={(next) => {
            setMode(next);
            setConnectionIssue(false);
            setGenerationMethod(null);
            setError(null);
            setMessage(null);
          }}
        />
      </div>

      {mode ? (
        <form onSubmit={submit} className="mt-5 space-y-5">
          {mode === "generate" ? (
            <>
              <GenerateDatasetLayout
                generationMethod={generationMethod}
                setGenerationMethod={setGenerationMethod}
                name={name}
                setName={setName}
                description={description}
                setDescription={setDescription}
                domain={domain}
                setDomain={setDomain}
                maxRows={maxRows}
                setMaxRows={setMaxRows}
                seeds={seeds}
                setSeeds={setSeeds}
                generationInstruction={generationInstruction}
                model={model}
                setModel={setModel}
                generationModels={generationModels}
                modelsLoading={modelsLoading}
                modelsError={modelsError}
                toolsError={toolsError}
                onRefreshModels={() => void loadGenerationResources()}
                toolServers={toolServers}
                serverName={serverName}
                setServerName={(value) => {
                  setServerName(value);
                  setToolName(toolServers.find((server) => server.name === value)?.tools[0] || "");
                }}
                selectedServer={selectedServer}
                toolName={toolName}
                setToolName={setToolName}
                busy={busy || (visibleGenJob != null && !isTerminalGenerationPhase(visibleGenJob.phase))}
                onReset={resetGenerateForm}
              />
            </>
          ) : null}

          {mode === "import" ? (
            <ImportDatasetLayout
              name={name}
              setName={setName}
              productId={productId}
              setProductId={setProductId}
              file={file}
              setFile={setFile}
              busy={busy}
              onDownloadTemplate={() => void downloadTemplate()}
              onCancel={() => onOpenChange(false)}
            />
          ) : null}

          {visibleGenJob ? (
            <GenerationJobPanel
              job={visibleGenJob}
              onCancel={() => void cancelGeneration(visibleGenJob.job_id)}
              onDismiss={dismissGenerationJob}
            />
          ) : null}

          {error && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              <p>{error}</p>
              {connectionIssue && (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <span>Check the connection without resubmitting your dataset.</span>
                  <Button type="button" variant="outline" size="sm" disabled={checkingConnection || busy} onClick={() => void checkConnection()}>
                    {checkingConnection ? "Checking…" : "Check connection"}
                  </Button>
                </div>
              )}
            </div>
          )}
          {message && (
            <p className="flex items-center gap-2 rounded-lg border border-success/25 bg-success/10 px-4 py-3 text-sm text-success-text dark:text-success">
              <Check className="size-4" aria-hidden="true" />
              {message}
            </p>
          )}
        </form>
      ) : null}

      {!mode && error ? (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}
      {!mode && message ? (
        <p className="mt-4 flex items-center gap-2 rounded-lg border border-success/25 bg-success/10 px-4 py-3 text-sm text-success-text dark:text-success">
          <Check className="size-4" aria-hidden="true" />
          {message}
        </p>
      ) : null}
    </Dialog>
  );
}

const PANEL_TONE_CLASSES: Record<string, string> = {
  active: "border-brand/25 bg-brand/5 dark:border-brand/30 dark:bg-brand/10",
  success:
    "border-success/25 bg-success/10 text-success-text dark:text-success",
  error:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  muted: "border-border bg-muted/40 text-muted-foreground",
};

/** Live status of the durable generation job named in ?genJob=<id>. */
function GenerationJobPanel({
  job,
  onCancel,
  onDismiss,
}: {
  job: GenerationJob;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const view = describeGenerationPhase(job);
  const progress = generationProgressLabel(job.progress);
  const terminal = isTerminalGenerationPhase(job.phase);
  const cancellable = isCancellableGenerationPhase(job.phase);

  return (
    <section
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-xl border px-4 py-3 text-sm",
        PANEL_TONE_CLASSES[view.tone] ?? PANEL_TONE_CLASSES.muted,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {!terminal ? (
            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          ) : view.tone === "success" ? (
            <Check className="size-4 shrink-0" aria-hidden="true" />
          ) : view.tone === "muted" ? (
            <Ban className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <X className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="font-semibold">{view.label}</span>
          {progress ? (
            <span className="text-xs text-muted-foreground">{progress}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {cancellable ? (
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              <Ban className="mr-1.5 size-3.5" aria-hidden="true" />
              Cancel generation
            </Button>
          ) : null}
          {terminal ? (
            <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          ) : null}
        </div>
      </div>
      <p className="mt-1.5 break-words">{view.detail}</p>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
        job {job.job_id}
      </p>
    </section>
  );
}

export function ImportDatasetLayout(props: {
  name: string;
  setName: (value: string) => void;
  productId: string;
  setProductId: (value: string) => void;
  file: File | null;
  setFile: (file: File | null) => void;
  busy: boolean;
  onDownloadTemplate: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid overflow-hidden rounded-xl border lg:grid-cols-2 lg:divide-x">
        <section className="p-4 sm:p-5">
          <h3 className="text-sm font-semibold">Dataset details</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Define where this dataset will be used.
          </p>

          <div className="mt-5 space-y-4">
            <Field label="Dataset name">
              <input
                className={inputClass}
                value={props.name}
                onChange={(event) => props.setName(event.target.value)}
                required
              />
            </Field>
            <Field label="Product / use case">
              <input
                className={inputClass}
                value={props.productId}
                onChange={(event) => props.setProductId(event.target.value)}
              />
            </Field>
          </div>
        </section>

        <section className="bg-muted/15 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold">CSV file</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Columns: Serial No, Question, Expected Output, Metadata. Only Question is required.
                Metadata holds case labels and expected tool calls. For a live agent evaluation,
                leave actual responses out; they are captured during the run. An optional Response
                column is only for scoring answers you already hold.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={props.onDownloadTemplate}
              className="shrink-0"
            >
              <Download className="mr-1.5 size-4" aria-hidden="true" />
              Template
            </Button>
          </div>

          <div className="mt-4 rounded-lg border bg-background p-3 text-sm">
            <a href="/samples/nova-agent-golden.csv" download="nova-agent-golden.csv" className="font-medium text-primary underline underline-offset-4">
              Download Nova agent sample (4 cases)
            </a>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Reviewed refund cases with expected answers and tool arguments. Import with a unique dataset name and product proofgrove-working-agents.
            </p>
          </div>

          <label className="mt-5 flex min-h-48 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-border bg-background/70 px-6 py-8 text-center transition-colors hover:border-primary/50 hover:bg-background">
            <UploadCloud className="mb-3 size-6 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm font-medium text-foreground">
              {props.file ? props.file.name : "Drop a CSV file here"}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              {props.file ? "Choose another file" : "or choose a file from your device"}
            </span>
            <input
              className="sr-only"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => props.setFile(event.target.files?.[0] || null)}
            />
          </label>
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
        <Button type="button" variant="outline" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={props.busy || !props.name.trim() || !props.file}>
          {props.busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
          {props.busy ? "Working…" : "Import Draft"}
        </Button>
      </div>
    </div>
  );
}

function GenerateDatasetLayout(props: {
  generationMethod: GenerationMethod | null;
  setGenerationMethod: (value: GenerationMethod | null) => void;
  name: string;
  setName: (value: string) => void;
  description: string;
  setDescription: (value: string) => void;
  domain: string;
  setDomain: (value: string) => void;
  maxRows: number;
  setMaxRows: (value: number) => void;
  seeds: string;
  setSeeds: (value: string) => void;
  generationInstruction: string;
  model: string;
  setModel: (value: string) => void;
  generationModels: LlmCatalogEntry[];
  modelsLoading: boolean;
  modelsError: string | null;
  toolsError: string | null;
  onRefreshModels: () => void;
  toolServers: ToolServer[];
  serverName: string;
  setServerName: (value: string) => void;
  selectedServer?: ToolServer;
  toolName: string;
  setToolName: (value: string) => void;
  busy: boolean;
  onReset: () => void;
}) {
  const selectedMethod = METHOD_OPTIONS.find((option) => option.id === props.generationMethod);
  const methodLabel = selectedMethod?.label ?? "—";
  const selectedGenerationModel = findSelectedModel(props.generationModels, props.model);
  const promptPreview = props.generationInstruction
    ? props.generationInstruction.length > 72
      ? `${props.generationInstruction.slice(0, 72)}…`
      : props.generationInstruction
    : "—";

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Generation Method</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Select LLMs or Agent Orchestration to open that method’s form.
          </p>
        </div>
        <GenerationMethodPicker
          value={props.generationMethod}
          onChange={props.setGenerationMethod}
        />
      </section>

      {!props.generationMethod || !selectedMethod ? (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          Choose a Generation Method to show its configuration fields.
        </p>
      ) : (
        <>
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)]">
            <section className="space-y-4 rounded-xl border border-border/90 bg-background p-4 shadow-sm sm:p-5">
              <div>
                <h3 className="text-sm font-semibold">{methodLabel} configuration</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Define the draft evaluation cases Proofgrove will generate with {methodLabel}.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Dataset Name">
                  <input
                    className={inputClass}
                    value={props.name}
                    onChange={(event) => props.setName(event.target.value)}
                    required
                    placeholder="Customer Support Conversations"
                  />
                </Field>
                <Field label="Domain / Use Case">
                  <input
                    className={inputClass}
                    value={props.domain}
                    onChange={(event) => props.setDomain(event.target.value)}
                    placeholder="Customer Support, finance, policy…"
                  />
                </Field>
              </div>

              <Field label="Description (Optional)">
                <textarea
                  className={inputClass}
                  rows={3}
                  value={props.description}
                  onChange={(event) => props.setDescription(event.target.value)}
                  placeholder="Synthetic customer support conversations across multiple industries and topics."
                />
              </Field>

              <Field label="Size">
                <div className="flex gap-2">
                  <input
                    className={inputClass}
                    type="number"
                    min={1}
                    max={50}
                    value={props.maxRows}
                    onChange={(event) =>
                      props.setMaxRows(Math.min(50, Math.max(1, Number(event.target.value) || 1)))
                    }
                  />
                  <span className="inline-flex min-w-20 items-center justify-center rounded-lg border bg-muted/40 px-3 text-sm text-muted-foreground">
                    rows
                  </span>
                </div>
                <span className="block text-xs text-muted-foreground">
                  Size sets the row count, even if your prompt mentions a different number.
                </span>
              </Field>

              {props.generationMethod === "llms" ? (
                <Field label="Generation model">
                  <select
                    className={cn(inputClass, "select-chevron pr-9")}
                    value={props.model}
                    onChange={(event) => props.setModel(event.target.value)}
                    required
                    disabled={props.modelsLoading || Boolean(props.modelsError)}
                  >
                    <option value="">
                      {props.modelsLoading ? "Loading generation models…"
                        : props.modelsError ? "Model catalog unavailable"
                        : props.generationModels.length ? "Select a generation model"
                        : "No connected generation models"}
                    </option>
                    {props.generationModels.map((entry) => (
                      <option key={modelSelectionId(entry)} value={modelSelectionId(entry)}>
                        {entry.name || entry.model_id} · {entry.source === "openai" ? "OpenAI" : entry.source === "ollama" ? "Ollama" : "Platform"}
                      </option>
                    ))}
                  </select>
                  {props.modelsError ? <span role="alert" className="block text-xs text-red-600">{props.modelsError}</span> : null}
                  {!props.modelsLoading && !props.modelsError && props.generationModels.length === 0 ? (
                    <span className="block text-xs text-muted-foreground">Connect OpenAI or start Ollama in <a className="underline" href="/catalog/llms">Models</a>, then refresh.</span>
                  ) : null}
                  <Button type="button" variant="outline" size="sm" disabled={props.modelsLoading} onClick={props.onRefreshModels}>Refresh models</Button>
                </Field>
              ) : null}

              {props.generationMethod === "tools" && props.toolsError ? (
                <p role="alert" className="text-xs text-red-600">{props.toolsError}</p>
              ) : null}
              {props.generationMethod === "tools" ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Grounding MCP server">
                    <select
                      className={cn(inputClass, "select-chevron pr-9")}
                      value={props.serverName}
                      onChange={(event) => props.setServerName(event.target.value)}
                    >
                      <option value="">Select grounding server</option>
                      {props.toolServers.map((server) => (
                        <option key={server.name} value={server.name}>
                          {server.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Grounding tool">
                    <select
                      className={cn(inputClass, "select-chevron pr-9")}
                      value={props.toolName}
                      onChange={(event) => props.setToolName(event.target.value)}
                    >
                      <option value="">Select tool</option>
                      {props.selectedServer?.tools.map((tool) => (
                        <option key={tool} value={tool}>
                          {tool}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              ) : null}

              <Field label="Generation Prompt / Instructions">
                <textarea
                  className={inputClass}
                  rows={6}
                  value={props.seeds}
                  onChange={(event) => props.setSeeds(event.target.value)}
                  placeholder="Describe the dataset you want. Proofgrove will generate the Size number of rows from this single instruction."
                />
              </Field>
              <p className="text-xs text-muted-foreground">
                Provide one prompt or instruction. Proofgrove will request{" "}
                <span className="font-medium text-foreground">{props.maxRows}</span> synthetic records
                (Serial No, Question, Expected Output, Risk)
                {props.generationMethod === "llms"
                  ? " with the selected generation model."
                  : " after grounding via the selected MCP tool."}
              </p>
            </section>

            <aside className="grid gap-4 xl:grid-rows-2">
              <section className="rounded-xl border border-border/80 bg-muted/50 p-4 dark:bg-muted/30">
                <h3 className="mb-1 text-sm font-semibold">{methodLabel} generation details</h3>
                <p className="mb-3 text-xs text-muted-foreground">{selectedMethod.desc}</p>
                <ol className="list-decimal space-y-2 pl-4 text-xs text-muted-foreground">
                  {selectedMethod.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ol>
              </section>

              <section className="rounded-xl border border-brand/25 bg-brand/5 p-4 dark:border-brand/30 dark:bg-brand/10">
                <h3 className="mb-3 text-sm font-semibold">Generation Summary</h3>
                <dl className="space-y-2 text-sm">
                  <SummaryRow label="Method" value={methodLabel} />
                  {props.generationMethod === "llms" ? (
                    <SummaryRow
                      label="Model"
                      value={selectedGenerationModel?.name || props.model.trim() || "—"}
                    />
                  ) : (
                    <SummaryRow label="Model" value="Platform default" />
                  )}
                  <SummaryRow label="Rows" value={String(props.maxRows)} />
                  <SummaryRow label="Prompt" value={promptPreview} />
                  {props.generationMethod === "tools" ? (
                    <SummaryRow
                      label="Grounding"
                      value={
                        props.selectedServer && props.toolName
                          ? `${props.selectedServer.name} / ${props.toolName}`
                          : "Not selected"
                      }
                    />
                  ) : null}
                  <SummaryRow label="Domain" value={props.domain.trim() || "—"} />
                </dl>
              </section>
            </aside>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={props.onReset} disabled={props.busy}>
              Reset
            </Button>
            <Button type="submit" disabled={props.busy || (props.generationMethod === "llms" && (props.modelsLoading || Boolean(props.modelsError) || !selectedGenerationModel))}>
              {props.busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
              {props.busy ? "Generating…" : "Generate Dataset"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="max-w-[60%] text-right font-medium break-words">{value}</dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}
