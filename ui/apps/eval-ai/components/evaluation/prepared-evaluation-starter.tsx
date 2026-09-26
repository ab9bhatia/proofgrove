"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { api, evaluationApi, platformApi } from "@/lib/api";
import { NOVA_PREPARED, preparedArtifacts, preparedEvaluationHref, readLabAvailability, type PreparedInventory } from "./prepared-evaluation";

import { PreparedAgentEvaluationStarter } from "./prepared-agent-evaluation-starter";

const EMPTY: PreparedInventory = { golden: null, rehearsal: null, prompts: [], metrics: [], projects: [], models: [], lab: null };

export function PreparedEvaluationStarter() {
  const [showModel, setShowModel] = useState(false);
  return <>
    <PreparedAgentEvaluationStarter />
    <details className="mt-5 border-t pt-3" onToggle={(event) => setShowModel(event.currentTarget.open)}>
      <summary className="w-fit cursor-pointer rounded py-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Model-only refund evaluation and offline rehearsal</summary>
      {showModel ? <PreparedModelEvaluationStarter /> : null}
    </details>
  </>;
}

function PreparedModelEvaluationStarter() {
  const [inventory, setInventory] = useState<PreparedInventory>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      api.getDataset(NOVA_PREPARED.goldenDataset),
      api.getDataset(NOVA_PREPARED.rehearsalDataset),
      platformApi.listPrompts(NOVA_PREPARED.promptId),
      evaluationApi.listMetrics(),
      api.tenant().then((tenant) => api.listTraceProjects(tenant.tenant_id)),
      evaluationApi.listLlmCatalog(),
      readLabAvailability(),
    ]).then(([golden, rehearsal, prompts, metrics, projects, models, lab]) => {
      if (!active) return;
      setInventory({
        golden: golden.status === "fulfilled" ? golden.value : null,
        rehearsal: rehearsal.status === "fulfilled" ? rehearsal.value : null,
        prompts: prompts.status === "fulfilled" ? prompts.value : [],
        metrics: metrics.status === "fulfilled" ? metrics.value : [],
        projects: projects.status === "fulfilled" ? projects.value : [],
        models: models.status === "fulfilled" ? models.value : [],
        lab: lab.status === "fulfilled" ? lab.value : null,
      });
      setLoadFailed([golden, rehearsal, prompts, metrics, projects, models, lab].some((r) => r.status === "rejected"));
      setLoading(false);
    });
    return () => { active = false; };
  }, []);
  const state = preparedArtifacts(inventory);
  const rows = [
    { label: "Golden dataset", ready: state.goldenReady, detail: state.goldenReady ? `${inventory.golden!.record_count} refund cases with reference answers` : "Published reference cases unavailable" },
    { label: "Saved prompts", ready: Boolean(state.prompt), detail: state.prompt ? `Versions ${state.promptVersions.join(" and ")} · version 2 selected for live runs` : "Nova refund prompt version 2 unavailable" },
    { label: "Metrics", ready: state.metricsReady, detail: state.metricsReady ? "F1, ROUGE-L and BLEU · no judge model required" : `${state.metricIds.length} of 3 text metrics available` },
    { label: "Experiment project", ready: Boolean(state.project), detail: state.project?.name ?? "Active Nova project unavailable" },
    { label: inventory.lab?.provider === "ollama" ? "Local model" : "Live model", ready: Boolean(state.model), detail: state.model ? (inventory.lab?.provider === "ollama" ? `${state.model.model_id} · configured through Ollama; generates fresh answers during the run` : `${state.model.model_id} · configured; connection and access not yet verified`) : "Not configured · connect a model to run live" },
  ];
  return (
    <section aria-labelledby="prepared-nova-title" className="panel mt-8 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="proofgrove-eyebrow text-xs text-evalai-purple">Prepared model evaluation</p>
          <h2 id="prepared-nova-title" className="mt-2 text-lg font-semibold">Evaluate refund answers from an LLM</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">This separate example sends eight refund questions directly to your configured LLM, without the Nova agent or its tools. Compare its generated answers with reviewed reference answers using the prepared prompt, metrics and project.</p>
        </div>
        <span className="rounded-full border px-3 py-1 text-xs">8 retail refund cases</span>
      </div>
      {loading ? <p className="mt-5 text-sm text-muted-foreground" role="status">Checking the saved artifacts…</p> : <>
        <dl className="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(({ label, ready, detail }) => <div key={label}>
            <dt className="flex items-center gap-2 text-sm font-medium">{ready ? <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" /> : <Circle className="size-4 text-muted-foreground" aria-hidden="true" />}{label}</dt>
            <dd className="mt-1 pl-6 text-xs leading-5 text-muted-foreground">{detail}</dd>
          </div>)}
        </dl>
        {loadFailed && <p className="mt-4 text-xs text-muted-foreground" role="status">Some artifacts could not be checked. Only confirmed setups are enabled; refresh this page to check again.</p>}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {state.liveReady ? <Link className="inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={preparedEvaluationHref("llm")}>Start model-only evaluation <ArrowRight className="size-4" aria-hidden="true" /></Link> : <span className="inline-flex min-h-11 items-center rounded-md border px-4 py-2 text-sm text-muted-foreground">Configure a model and complete the artifacts to start evaluation</span>}
          <Link href="/catalog/llms" className="inline-flex min-h-11 items-center px-2 text-sm underline">Choose model / connect OpenAI</Link>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">Opening setup makes no model call. Review the configuration, then submit the run. Generated responses and scores appear in its report. F1, ROUGE-L and BLEU measure text overlap; review refund correctness separately.</p>
        <details className="mt-5 border-t pt-3">
          <summary className="w-fit cursor-pointer rounded py-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Offline rehearsal with supplied responses</summary>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-muted-foreground">This optional rehearsal scores {inventory.rehearsal?.record_count ?? "stored"} authored responses. It does not generate answers or invoke a model. Use it to explore the scoring and report flow without a provider connection.</p>
          {state.offlineReady ? <Link className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={preparedEvaluationHref("provided")}>Open offline rehearsal <ArrowRight className="size-4" aria-hidden="true" /></Link> : <p className="mt-3 text-xs text-muted-foreground">The published rehearsal dataset, metrics or project is unavailable.</p>}
        </details>
      </>}
    </section>
  );
}
