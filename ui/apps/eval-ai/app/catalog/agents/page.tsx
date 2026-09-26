"use client";

import { TablePagination } from "@/components/table-pagination";
import { ROWS_PER_PAGE } from "@/lib/pagination";
import { PAGE_FRAME } from "@/lib/page-frame";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Plus, RefreshCw } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { ProofgroveGate } from "@/components/proofgrove-gate";
import { AgentCatalogList } from "@/components/catalog/agent-catalog-list";
import { LocalAgentCards } from "@/components/catalog/local-agent-cards";
import { CatalogToolbar, SearchField } from "@/components/toolbar";
import { isLocalWorkflowAgent, localAgentText, localAgentStrings } from "@/lib/local-agents";
import { AgentFormDialog } from "@/components/catalog/agent-form-dialog";
import { PageHeader } from "@/components/page-header";
import { agentsApi, type TargetVersion } from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import { Chip } from "@/components/status-badge";

export default function AgentCatalogPage() {
  return (
    <ProofgroveGate>
      <AgentCatalog />
    </ProofgroveGate>
  );
}

function AgentCatalog() {
  const [agents, setAgents] = useState<TargetVersion[]>([]);
  const [endpoint, setEndpoint] = useState("");
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [agentFormOpen, setAgentFormOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  // Client-side: the agent list is unpaged, so filtering it here still searches
  // every agent the tenant has.
  const visibleAgents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return agents;
    return agents.filter((agent) =>
      [agent.name, agent.target_id, agent.model_version, localAgentText(agent, "description"), localAgentText(agent, "example_query"), ...localAgentStrings(agent, "tools")]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }, [agents, query]);
  const localAgents = visibleAgents.filter(isLocalWorkflowAgent);
  const externalAgents = visibleAgents.filter((agent) => !isLocalWorkflowAgent(agent));
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAgents(await agentsApi.catalog());
    } catch (cause) {
      setError(userFacingError(cause, "Failed to load the Agent Catalog"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    agentsApi
      .catalog()
      .then((items) => {
        if (!cancelled) setAgents(items);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(userFacingError(cause, "Failed to load the Agent Catalog"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const currentPage = Math.min(page, Math.max(1, Math.ceil(externalAgents.length / ROWS_PER_PAGE)));

  async function testAndOnboard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = endpoint.trim();
    if (!value) return;
    setTesting(true);
    setFormError(null);
    setSuccess(null);
    try {
      const onboarded = await agentsApi.testAndOnboard(value);
      setSuccess(`Connectivity verified. ${onboarded.name} is now available in the Agent Catalog.`);
      setEndpoint("");
      setAgentFormOpen(false);
      await load();
    } catch (cause) {
      setFormError(userFacingError(cause, "Agent connectivity test failed"));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className={PAGE_FRAME}>
      <PageHeader
        section="Workspace"
        title="What to test"
        description="Choose an agent, try a request, then evaluate its answers and tool workflow against a golden dataset."
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw className={`mr-2 size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
            <Button
              type="button"
              size="sm"
              aria-haspopup="dialog"
              aria-expanded={agentFormOpen}
              onClick={() => setAgentFormOpen(true)}
            >
              <Plus className="mr-2 size-4" aria-hidden="true" />
              Connect an agent
            </Button>
          </>
        }
      />

      {agentFormOpen ? (
        <AgentFormDialog
          endpoint={endpoint}
          testing={testing}
          error={formError}
          onEndpointChange={setEndpoint}
          onSubmit={testAndOnboard}
          onClose={() => setAgentFormOpen(false)}
        />
      ) : null}

      {success ? (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-state-positive/30 bg-state-positive-soft px-3 py-2.5 text-sm text-state-positive dark:border-state-positive/30 dark:bg-state-positive-soft dark:text-state-positive">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{success}</span>
        </div>
      ) : null}
      {error ? (
        <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <div className="mb-6 rounded-xl border bg-muted/20 px-5 py-4 text-sm leading-6 text-muted-foreground">
        Each local agent runs tools on synthetic data, then uses your default model to write a fresh response.
        Tool calls and results are captured for evaluation. Prepared checks assess tool use; review answer quality separately. These workflows do not change external systems.
      </div>
      <div className="mb-5 rounded-xl border bg-card">
        <CatalogToolbar>
          <SearchField value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search agents, examples or tools…" label="Search agents" />
          <Chip size="md">{visibleAgents.length} {visibleAgents.length === 1 ? "agent" : "agents"}</Chip>
        </CatalogToolbar>
      </div>
      {loading ? <div role="status" className="flex justify-center gap-2 py-16 text-sm text-muted-foreground"><div className="size-5 animate-spin rounded-full border-2 border-muted border-t-primary" />Loading agents…</div> : <>
        {localAgents.length ? <section aria-label="Local agents"><LocalAgentCards agents={localAgents} /></section> : null}
        {externalAgents.length ? <section aria-labelledby="connected-agents" className="mt-8">
          <h2 id="connected-agents" className="mb-3 text-lg font-semibold tracking-tight">Connected agents</h2>
          <AgentCatalogList footer={<TablePagination total={externalAgents.length} page={currentPage} onPageChange={setPage} label="agents" />} agents={externalAgents.slice((currentPage - 1) * ROWS_PER_PAGE, currentPage * ROWS_PER_PAGE)} />
        </section> : null}
        {!visibleAgents.length && !error ? <div className="rounded-xl border border-dashed py-14 text-center text-sm text-muted-foreground">{query ? "No agents match your search." : "No agents are available. Connect an agent to get started."}{query ? <button type="button" className="ml-2 font-medium text-primary underline" onClick={() => setQuery("")}>Clear search</button> : null}</div> : null}
      </>}
    </div>
  );
}
