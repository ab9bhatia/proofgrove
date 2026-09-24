import type { EvaluationScope } from "@/lib/api";

/** Canonical depth labels shared by setup and report surfaces. */
export const EVALUATION_SCOPE_LABELS: Record<EvaluationScope, string> = {
  final_response: "Final response",
  tool_interactions: "Tool interactions",
  full_execution: "Full execution",
};

export function evaluationScopeLabel(scope: EvaluationScope | null | undefined): string {
  return scope ? EVALUATION_SCOPE_LABELS[scope] ?? "Scope not recorded" : "Scope not recorded";
}

/**
 * User chose a narrower evaluation depth than this evidence layer. This is the
 * explanation only — call sites that want a "Not configured." lede add it themselves,
 * so the two never stutter into "Not configured. Not configured for the selected…".
 */
export function evidenceDepthNotConfiguredCopy(selectedScope: EvaluationScope): string {
  return `The selected ${evaluationScopeLabel(selectedScope)} depth did not include this evidence.`;
}

/** The run never recorded which depth it ran at, so nothing can be claimed about scope. */
export function evidenceDepthNotRecordedCopy(): string {
  return `${evaluationScopeLabel(null)} for this run, so whether this evidence was in scope is unknown.`;
}

/** Evidence was never recorded on this run (predates capability or capture gap). */
export function evidenceDepthNotCapturedCopy(scope: EvaluationScope): string {
  return `${evaluationScopeLabel(scope)} was not captured for this run.`;
}
