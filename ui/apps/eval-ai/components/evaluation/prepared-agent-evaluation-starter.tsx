"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { agentsApi, api, evaluationApi, type AgentSummary, type DatasetInfo } from "@/lib/api";
import { NOVA_AGENT_DEMO, NOVA_AGENT_EVALUATION_HREF } from "@/lib/local-agents";

export function PreparedAgentEvaluationStarter() {
  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [dataset, setDataset] = useState<DatasetInfo | null>(null);
  const [metricCount, setMetricCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      agentsApi.list(true),
      api.getDataset(NOVA_AGENT_DEMO.dataset),
      evaluationApi.listMetrics(),
    ]).then(([agents, golden, metrics]) => {
      if (!active) return;
      setAgent(agents.status === "fulfilled" ? agents.value.find((item) => item.id === NOVA_AGENT_DEMO.agentRef && item.ready && item.accepted) ?? null : null);
      setDataset(golden.status === "fulfilled" ? golden.value : null);
      setMetricCount(metrics.status === "fulfilled" ? NOVA_AGENT_DEMO.metrics.filter((id) => metrics.value.some((item) => item.metric_id === id && item.available_in_run !== false)).length : 0);
      setFailed([agents, golden, metrics].some((result) => result.status === "rejected"));
      setLoading(false);
    });
    return () => { active = false; };
  }, [reload]);

  const datasetReady = Boolean(dataset?.status === "PUBLISHED" && (dataset.record_count ?? 0) > 0 && !dataset.missing_row_fields?.length);
  const checksReady = metricCount === NOVA_AGENT_DEMO.metrics.length;
  const ready = Boolean(agent && datasetReady && checksReady);
  const rows = [
    { label: "Agent", ready: Boolean(agent), detail: agent ? `${agent.display_name || agent.name} · ${agent.tools.join(" + ")}` : "Nova agent unavailable · check its response model in What to test" },
    { label: "Golden dataset", ready: datasetReady, detail: datasetReady ? `${dataset!.record_count} cases · expected answers, tool names and arguments` : "Published Nova agent cases unavailable" },
    { label: "Checks", ready: checksReady, detail: checksReady ? "Required tools, tool selection and tool arguments" : `${metricCount} of 3 workflow checks available` },
    { label: "Response model", ready: Boolean(agent?.model), detail: agent?.model ?? "Choose a connected default in Models" },
  ];

  return <section aria-labelledby="prepared-agent-title" className="panel mt-8 p-5 sm:p-6">
    <p className="proofgrove-eyebrow text-xs text-evalai-purple">Prepared agent evaluation</p>
    <h2 id="prepared-agent-title" className="mt-2 text-lg font-semibold">Evaluate Nova Refunds end to end</h2>
    <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Run the agent on four golden cases. It looks up each order, checks refund eligibility and asks the configured model to write a fresh answer. Inspect the captured tool results and scores in Experiments.</p>
    {loading ? <p className="mt-5 text-sm text-muted-foreground" role="status">Checking the agent, dataset and checks…</p> : <>
      <dl className="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {rows.map(({ label, ready: available, detail }) => <div key={label}>
          <dt className="flex items-center gap-2 text-sm font-medium">{available ? <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" /> : <Circle className="size-4 text-muted-foreground" aria-hidden="true" />}{label}</dt>
          <dd className="mt-1 pl-6 text-xs leading-5 text-muted-foreground">{detail}</dd>
        </div>)}
      </dl>
      {failed ? <p role="status" className="mt-4 text-xs text-muted-foreground">The agent setup could not be fully checked. Retry to refresh its availability.</p> : null}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {ready ? <Link href={NOVA_AGENT_EVALUATION_HREF} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Start Nova agent evaluation <ArrowRight className="size-4" aria-hidden="true" /></Link> : <button type="button" className="inline-flex min-h-11 items-center rounded-md border px-4 py-2 text-sm font-medium" onClick={() => { setLoading(true); setReload((value) => value + 1); }}>Retry agent setup</button>}
        <Link href="/catalog/agents" className="inline-flex min-h-11 items-center px-2 text-sm underline">Browse all agents</Link>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">The dataset, Nova agent and three workflow checks are preselected. These checks score tool choice and arguments; review the final answer separately. Tools use local sample orders and do not move money. Opening setup makes no model call.</p>
    </>}
  </section>;
}
