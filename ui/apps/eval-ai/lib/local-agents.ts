import type { AgentSummary, TargetVersion } from "@/lib/api";

export const NOVA_AGENT_DEMO = {
  agentRef: "local:nova-refunds",
  dataset: "agent_nova_refunds_v1",
  metrics: ["agent.tool_call_accuracy", "agent.tool_selection", "agent.tool_input_accuracy"],
} as const;

export const NOVA_AGENT_EVALUATION_HREF = `/evaluate?${new URLSearchParams({
  type: "agent", agent: NOVA_AGENT_DEMO.agentRef, dataset: NOVA_AGENT_DEMO.dataset,
})}`;

export function isLocalWorkflowAgent(agent: TargetVersion): boolean {
  return agent.configuration?.catalog_source === "local_workflow";
}

export function localAgentReference(agent: TargetVersion): string {
  const ref = agent.configuration?.agent_ref;
  return typeof ref === "string" && ref ? ref : agent.target_id;
}

export function localAgentText(agent: TargetVersion, key: string): string {
  const value = agent.configuration?.[key];
  return typeof value === "string" ? value : "";
}

export function localAgentStrings(agent: TargetVersion, key: string): string[] {
  const value = agent.configuration?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function agentEvaluationHref(agent: TargetVersion): string {
  const query = new URLSearchParams({ type: "agent", agent: localAgentReference(agent) });
  const dataset = localAgentText(agent, "recommended_dataset_id");
  if (dataset) query.set("dataset", dataset);
  return `/evaluate?${query.toString()}`;
}

export function runnableAgentMetricIds(agent: AgentSummary, metrics: Array<{ metric_id: string; available_in_run?: boolean }>): string[] {
  const runnable = new Set(metrics.filter((metric) => metric.available_in_run !== false).map((metric) => metric.metric_id));
  return (agent.recommended_metric_ids ?? []).filter((id) => runnable.has(id));
}

export function agentBaselineName(agent: AgentSummary): string {
  return `${agent.display_name || agent.name} · baseline`;
}

/** A deliberate evaluation name belongs to the user, even when its target changes. */
export function nameAfterAgentChange(current: string, previous: AgentSummary | null, next: AgentSummary | null): string {
  return previous && next && current === agentBaselineName(previous) ? agentBaselineName(next) : current;
}
