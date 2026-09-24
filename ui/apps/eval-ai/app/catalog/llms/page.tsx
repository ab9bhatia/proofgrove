"use client";
import { ModelProviderSettings } from "@/components/model-provider-settings";

import { TablePagination } from "@/components/table-pagination";
import { ROWS_PER_PAGE } from "@/lib/pagination";
import { PAGE_FRAME } from "@/lib/page-frame";
import { FormEvent, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { EvalHubGate } from "@/components/eval-hub-gate";
import { LlmCatalogList } from "@/components/catalog/llm-catalog-list";
import { LlmFormDialog } from "@/components/catalog/llm-form-dialog";
import { LlmCatalogToolbar } from "@/components/catalog/llm-catalog-toolbar";
import { PageHeader } from "@/components/page-header";
import { evaluationApi, type LlmCatalogEntry, type LlmSource } from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import { Chip } from "@/components/status-badge";
import { scrollIntoPane } from "@/lib/scroll-into-pane";

export default function LlmCatalogPage() {
  return (
    <EvalHubGate>
      <Suspense
        fallback={
          <div className="flex justify-center py-24">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
          </div>
        }
      >
        <LlmCatalog />
      </Suspense>
    </EvalHubGate>
  );
}

function LlmCatalog() {
  const searchParams = useSearchParams();
  const highlightModelId = searchParams.get("model")?.trim() || "";
  const [models, setModels] = useState<LlmCatalogEntry[]>([]);
  const [providerRevision, setProviderRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<number | null>(null);
  const [sourceFilter, setSourceFilter] = useState<"all" | LlmSource>("all");
  const [loading, setLoading] = useState(true);
  const [onboarding, setOnboarding] = useState(false);
  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [description, setDescription] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setModels(await evaluationApi.listLlmCatalog());
    } catch (cause) {
      setError(userFacingError(cause, "Failed to load the LLM Catalog"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  useEffect(() => {
    if (!highlightModelId || loading) return;
    const el = document.querySelector(`[data-llm-model-id="${CSS.escape(highlightModelId)}"]`);
    scrollIntoPane(el, { behavior: "smooth", block: "center" });
  }, [highlightModelId, loading, models]);

  const visibleModels = useMemo(() => {
    const search = query.trim().toLowerCase();
    return models.filter((model) => {
      if (sourceFilter !== "all" && model.source !== sourceFilter) return false;
      if (!search) return true;
      return [model.name, model.model_id, model.description, model.endpoint, model.source]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(search);
    });
  }, [models, query, sourceFilter]);

  const currentPage = Math.min(page ?? (Math.floor(Math.max(0, visibleModels.findIndex((model) => model.model_id === highlightModelId)) / ROWS_PER_PAGE) + 1), Math.max(1, Math.ceil(visibleModels.length / ROWS_PER_PAGE)));

  async function onboardCustomLlm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = modelId.trim();
    const url = endpoint.trim();
    if (!id || !url) return;
    setOnboarding(true);
    setFormError(null);
    setSuccess(null);
    try {
      const saved = await evaluationApi.onboardCustomLlm({
        model_id: id,
        name: displayName.trim() || null,
        endpoint: url,
        description: description.trim() || null,
      });
      setSuccess(`${saved.name} was added to the LLM Catalog.`);
      setModelId("");
      setDisplayName("");
      setEndpoint("");
      setDescription("");
      setCustomFormOpen(false);
      await load();
    } catch (cause) {
      setFormError(userFacingError(cause, "Custom LLM onboarding failed"));
    } finally {
      setOnboarding(false);
    }
  }

  return (
    <div className={PAGE_FRAME}>
      <PageHeader
        section="Configure"
        title="Models"
        description="Connect OpenAI or local Ollama, then choose the model for new evaluations. Credentials stay on the backend."
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => { void load(); setProviderRevision((value) => value + 1); }}
              disabled={loading}
            >
              <RefreshCw className={`mr-2 size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
            <Button
              type="button"
              size="sm"
              aria-haspopup="dialog"
              aria-expanded={customFormOpen}
              onClick={() => setCustomFormOpen(true)}
            >
              <Plus className="mr-2 size-4" aria-hidden="true" />
              Custom endpoint
            </Button>
          </>
        }
      />

      <ModelProviderSettings refreshKey={providerRevision} onChange={() => void load()} />
      {customFormOpen ? (
        <LlmFormDialog
          modelId={modelId}
          displayName={displayName}
          endpoint={endpoint}
          description={description}
          saving={onboarding}
          error={formError}
          onModelIdChange={setModelId}
          onDisplayNameChange={setDisplayName}
          onEndpointChange={setEndpoint}
          onDescriptionChange={setDescription}
          onSubmit={(event) => void onboardCustomLlm(event)}
          onClose={() => setCustomFormOpen(false)}
        />
      ) : null}

      {success ? <div className="mb-5 rounded-lg border border-state-positive/30 bg-state-positive-soft px-3 py-2.5 text-sm text-state-positive">{success}</div> : null}
      {error ? <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</div> : null}

      <section aria-labelledby="available-models-heading" className="mt-8 border-t border-border pt-5">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="available-models-heading" className="text-lg font-semibold tracking-tight">Available models</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Models discovered from connected providers and saved custom endpoints. Select a default above; choose a different target in evaluation setup when needed.
            </p>
          </div>
          {!loading ? (
            <Chip size="md">
              {visibleModels.length} of {models.length} {models.length === 1 ? "model" : "models"}
            </Chip>
          ) : null}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="size-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
          </div>
        ) : visibleModels.length === 0 ? (
          <div className="overflow-hidden rounded-xl border bg-card">
            <LlmCatalogToolbar query={query} source={sourceFilter} onQueryChange={(value) => { setQuery(value); setPage(1); }} onSourceChange={(value) => { setSourceFilter(value); setPage(1); }} />
            <div className="space-y-3 py-14 text-center text-sm">
              <p>{models.length ? "No LLMs match the selected filters." : "No models available yet. Connect OpenAI or start local Ollama above."}</p>
              <button type="button" className="min-h-11 rounded-lg border px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setQuery(""); setSourceFilter("all"); }}>Clear filters</button>
            </div>
          </div>
        ) : (
          <LlmCatalogList footer={<TablePagination total={visibleModels.length} page={currentPage} onPageChange={setPage} label="LLMs" />}
            models={visibleModels.slice((currentPage - 1) * ROWS_PER_PAGE, currentPage * ROWS_PER_PAGE)}
            highlightedModelId={highlightModelId}
            toolbar={
              <LlmCatalogToolbar
                query={query}
                source={sourceFilter}
                onQueryChange={(value) => { setQuery(value); setPage(1); }}
                onSourceChange={(value) => { setSourceFilter(value); setPage(1); }}
              />
            }
          />
        )}
      </section>
    </div>
  );
}
