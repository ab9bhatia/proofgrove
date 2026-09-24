const KPI_LABELS: Record<string, string> = {
  "kpi.response_quality": "Response Quality",
  "kpi.retrieval_quality": "Retrieval Quality",
  "kpi.agent_effectiveness": "Agent Effectiveness",
  "kpi.safety_trust": "Safety & Trust",
  "kpi.operational_efficiency": "Operational Efficiency",
  "kpi.factual_integrity": "Factual Integrity",
  "kpi.guideline_compliance": "Guideline Compliance",
};

export function kpiLabel(kpiId: string): string {
  return KPI_LABELS[kpiId] ?? kpiId;
}
