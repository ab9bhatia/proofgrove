"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  FileText,
  ListTree,
  MessageSquareText,
  ShieldAlert,
} from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { cn } from "@evalai/shared/utils";
import { ToneBadge } from "@/components/status-badge";
import { formatDuration } from "@/lib/format-duration";

export type EvidencePreviewView = "thread" | "trace" | "scores" | "manifest";
export type EvidencePreviewFilter = "attention" | "missing" | "passed" | "all";
export type EvidencePreviewState = "ready" | "loading" | "error" | "permission";

export type SimulatedEvidencePreviewConfig = {
  enabled: boolean;
  caseId?: string | null;
  view?: string | null;
  filter?: string | null;
  stepId?: string | null;
  state?: string | null;
};

type EvidenceTone = "captured" | "missing" | "failed" | "passed" | "optional";

type EvidenceStep = {
  id: string;
  label: string;
  kind: string;
  summary: string;
  detail: string;
  tone: EvidenceTone;
  durationMs?: number;
  startMs?: number;
  spanId?: string;
  parentSpanId?: string | null;
  input?: unknown;
  output?: unknown;
  annotation?: string;
  attributes: Record<string, string>;
};

type EvidenceScore = {
  id: string;
  metric: string;
  requirement: "Required" | "Optional";
  status: "Scored" | "Not scored" | "Technical error";
  score: number | null;
  threshold: number;
  rationale: string;
  tone: EvidenceTone;
  stepId?: string;
};

type EvidenceManifestRow = {
  id: string;
  category: string;
  requirement: "Required" | "Optional";
  capture: "Captured" | "Partial" | "Not captured" | "Not required";
  records: string;
  completeness: string;
  provenance: string;
  tone: EvidenceTone;
};

export type SimulatedEvidenceCase = {
  id: string;
  title: string;
  shortTitle: string;
  status: "missing" | "attention" | "passed";
  outcome: string;
  capture: string;
  summary: string;
  traceAvailable: boolean;
  totalDurationMs: number;
  steps: EvidenceStep[];
  scores: EvidenceScore[];
  manifest: EvidenceManifestRow[];
};

const SHARED_MANIFEST: EvidenceManifestRow[] = [
  {
    id: "manifest-input",
    category: "Input",
    requirement: "Required",
    capture: "Captured",
    records: "1",
    completeness: "Attested complete",
    provenance: "Versioned dataset",
    tone: "captured",
  },
  {
    id: "manifest-output",
    category: "Final output",
    requirement: "Required",
    capture: "Captured",
    records: "1",
    completeness: "Attested complete",
    provenance: "Target invocation",
    tone: "captured",
  },
];

export const SIMULATED_EVIDENCE_CASES: SimulatedEvidenceCase[] = [
  {
    id: "case-014",
    title: "Did the agent verify the customer before disclosing account details?",
    shortTitle: "Customer verification",
    status: "missing",
    outcome: "Inconclusive",
    capture: "Partial evidence",
    summary: "The required tool result was not captured, so task completion could not be scored.",
    traceAvailable: true,
    totalDurationMs: 1248,
    steps: [
      {
        id: "step-input",
        label: "Customer request",
        kind: "Input",
        summary: "“Can you confirm the balance on my account?”",
        detail: "The evaluation input was loaded from the approved dataset version.",
        tone: "captured",
        startMs: 0,
        durationMs: 8,
        spanId: "preview-span-root",
        parentSpanId: null,
        attributes: { source: "dataset-v12", record: "case-014" },
      },
      {
        id: "step-retrieval",
        label: "Retrieve verification policy",
        kind: "Retrieval",
        summary: "4 policy passages returned",
        detail: "The retrieved policy requires identity verification before account details are disclosed.",
        tone: "captured",
        startMs: 48,
        durationMs: 184,
        spanId: "preview-span-retrieval",
        parentSpanId: "preview-span-root",
        attributes: { index: "customer-policy", documents: "4" },
      },
      {
        id: "step-tool",
        label: "Look up customer account",
        kind: "Tool",
        summary: "Tool called; result not captured",
        detail: "customer.lookup was invoked, but its result payload is missing from the evidence manifest.",
        tone: "missing",
        startMs: 264,
        durationMs: 236,
        spanId: "preview-span-tool",
        parentSpanId: "preview-span-root",
        attributes: { tool: "customer.lookup", result: "not_captured" },
      },
      {
        id: "step-output",
        label: "Generate final response",
        kind: "Model",
        summary: "Response generated in 612 ms",
        detail: "The answer asks the customer to complete verification before account information is disclosed.",
        tone: "captured",
        startMs: 524,
        durationMs: 612,
        spanId: "preview-span-model",
        parentSpanId: "preview-span-root",
        attributes: { model: "gpt-4.1-mini", input_tokens: "742", output_tokens: "186" },
      },
      {
        id: "step-evaluation",
        label: "Evaluate required metrics",
        kind: "Evaluation",
        summary: "1 required metric unscored",
        detail: "Task completion could not be scored because the required tool result was unavailable.",
        tone: "missing",
        startMs: 1186,
        durationMs: 24,
        spanId: "preview-span-evaluation",
        parentSpanId: "preview-span-root",
        attributes: { metric: "agent.task_completion", reason: "evidence_unavailable" },
      },
    ],
    scores: [
      {
        id: "score-task",
        metric: "agent.task_completion",
        requirement: "Required",
        status: "Not scored",
        score: null,
        threshold: 0.8,
        rationale: "Required tool-result evidence was unavailable. No score was fabricated.",
        tone: "missing",
      },
      {
        id: "score-policy",
        metric: "guideline.identity_verification",
        requirement: "Required",
        status: "Scored",
        score: 1,
        threshold: 0.9,
        rationale: "The final response requested verification before disclosure.",
        tone: "passed",
      },
      {
        id: "score-style",
        metric: "llm.response_style",
        requirement: "Optional",
        status: "Scored",
        score: 0.86,
        threshold: 0.75,
        rationale: "The response was concise and actionable.",
        tone: "optional",
      },
    ],
    manifest: [
      ...SHARED_MANIFEST,
      {
        id: "manifest-tool-call",
        category: "Tool calls",
        requirement: "Required",
        capture: "Captured",
        records: "1",
        completeness: "Attested complete",
        provenance: "Evaluation collector",
        tone: "captured",
      },
      {
        id: "manifest-tool-result",
        category: "Tool results",
        requirement: "Required",
        capture: "Not captured",
        records: "—",
        completeness: "Incomplete",
        provenance: "Unavailable",
        tone: "missing",
      },
      {
        id: "manifest-trace",
        category: "Execution trace",
        requirement: "Optional",
        capture: "Captured",
        records: "5 spans",
        completeness: "Preview fixture",
        provenance: "Simulated",
        tone: "optional",
      },
    ],
  },
  {
    id: "case-021",
    title: "Did the agent avoid disclosing account details before verification?",
    shortTitle: "Premature disclosure",
    status: "attention",
    outcome: "Failed",
    capture: "Complete evidence",
    summary: "The evidence is complete and shows a known policy failure.",
    traceAvailable: true,
    totalDurationMs: 1420,
    steps: [
      {
        id: "failed-root",
        label: "Agent invocation",
        kind: "Agent",
        summary: "“What is the current balance?”",
        detail: "One execution handles the request from prompt preparation through the final response.",
        tone: "captured",
        startMs: 0,
        durationMs: 1420,
        spanId: "demo-trace-failed-root",
        parentSpanId: null,
        input: { message: "What is the current balance?", customer_id: "cust_demo_021" },
        output: { response: "Your current balance is AED 4,280.15." },
        attributes: { agent: "support-agent", revision: "support-agent@42" },
      },
      {
        id: "failed-prompt",
        label: "Prompt preparation",
        kind: "Chain",
        summary: "System policy and customer request assembled",
        detail: "The approved identity-verification instruction is present in the prepared prompt.",
        tone: "captured",
        startMs: 12,
        durationMs: 38,
        spanId: "demo-trace-failed-prompt",
        parentSpanId: "demo-trace-failed-root",
        input: { policy: "Verify identity before account disclosure", request: "What is the current balance?" },
        output: { prompt_version: "support-policy@7" },
        attributes: { prompt_version: "support-policy@7" },
      },
      {
        id: "failed-retrieval",
        label: "Retrieval",
        kind: "Retriever",
        summary: "Identity policy retrieved",
        detail: "The retriever returned the correct verification policy before the account lookup.",
        tone: "captured",
        startMs: 62,
        durationMs: 176,
        spanId: "demo-trace-failed-retrieval",
        parentSpanId: "demo-trace-failed-root",
        input: { query: "account balance identity verification policy" },
        output: { documents: [{ id: "policy-17", text: "Verify identity before disclosing account data." }] },
        attributes: { index: "customer-policy", documents: "1" },
      },
      {
        id: "failed-tool",
        label: "Tool call",
        kind: "Tool",
        summary: "customer.lookup returned an account balance",
        detail: "The call, arguments, successful outcome, and result were captured.",
        tone: "captured",
        startMs: 262,
        durationMs: 312,
        spanId: "demo-trace-failed-tool",
        parentSpanId: "demo-trace-failed-root",
        input: { tool: "customer.lookup", arguments: { customer_id: "cust_demo_021" } },
        output: { success: true, balance: 4280.15, currency: "AED" },
        attributes: { tool: "customer.lookup", outcome: "success" },
      },
      {
        id: "failed-generation",
        label: "LLM generation",
        kind: "Model",
        summary: "The model ignored the verification requirement",
        detail: "The generated answer disclosed the balance even though the evidence and prompt required identity verification first.",
        tone: "failed",
        startMs: 598,
        durationMs: 694,
        spanId: "demo-trace-failed-model",
        parentSpanId: "demo-trace-failed-root",
        input: { tool_result: { balance: 4280.15, currency: "AED" }, verified: false },
        output: { text: "Your current balance is AED 4,280.15." },
        annotation: "Failure begins here: the generation contradicts the retrieved verification policy.",
        attributes: {
          model: "gpt-4.1-mini",
          input_tokens: "918",
          output_tokens: "46",
          cost_usd: "0.0017",
          latency_ms: "694",
        },
      },
      {
        id: "failed-response",
        label: "Final response",
        kind: "Output",
        summary: "Balance disclosed before verification",
        detail: "The unsafe generation was returned to the customer unchanged.",
        tone: "failed",
        startMs: 1310,
        durationMs: 24,
        spanId: "demo-trace-failed-response",
        parentSpanId: "demo-trace-failed-root",
        input: { generated_text: "Your current balance is AED 4,280.15." },
        output: { response: "Your current balance is AED 4,280.15." },
        annotation: "The policy failure reaches the user-visible response at this step.",
        attributes: { outcome: "returned" },
      },
    ],
    scores: [
      {
        id: "score-policy",
        metric: "guideline.identity_verification",
        requirement: "Required",
        status: "Scored",
        score: 0,
        threshold: 0.9,
        rationale: "The response disclosed account information before identity verification.",
        tone: "failed",
        stepId: "failed-generation",
      },
      {
        id: "score-task",
        metric: "agent.task_completion",
        requirement: "Required",
        status: "Scored",
        score: 0.72,
        threshold: 0.8,
        rationale: "The task was answered, but required policy behavior was not followed.",
        tone: "failed",
        stepId: "failed-response",
      },
    ],
    manifest: [
      ...SHARED_MANIFEST,
      {
        id: "manifest-tool-call",
        category: "Tool calls",
        requirement: "Required",
        capture: "Captured",
        records: "1",
        completeness: "Attested complete",
        provenance: "Evaluation collector",
        tone: "captured",
      },
      {
        id: "manifest-tool-result",
        category: "Tool results",
        requirement: "Required",
        capture: "Captured",
        records: "1",
        completeness: "Attested complete",
        provenance: "Evaluation collector",
        tone: "captured",
      },
      {
        id: "manifest-trace",
        category: "Execution trace",
        requirement: "Required",
        capture: "Captured",
        records: "6 spans",
        completeness: "Preview fixture",
        provenance: "Simulated",
        tone: "captured",
      },
    ],
  },
  {
    id: "case-008",
    title: "Did the agent explain the verification step clearly?",
    shortTitle: "Clear next step",
    status: "passed",
    outcome: "Passed",
    capture: "Complete evidence",
    summary: "Required evidence and scoring are complete.",
    traceAvailable: false,
    totalDurationMs: 732,
    steps: [
      {
        id: "step-input",
        label: "Customer request",
        kind: "Input",
        summary: "Customer asks how to complete verification",
        detail: "The request asks for a clear explanation of the verification process.",
        tone: "captured",
        startMs: 0,
        durationMs: 6,
        spanId: "preview-pass-root",
        parentSpanId: null,
        attributes: { source: "dataset-v12", record: "case-008" },
      },
      {
        id: "step-output",
        label: "Generate final response",
        kind: "Model",
        summary: "3 verification steps explained",
        detail: "The response clearly explains the approved identity-verification steps.",
        tone: "passed",
        startMs: 58,
        durationMs: 542,
        spanId: "preview-pass-model",
        parentSpanId: "preview-pass-root",
        attributes: { model: "gpt-4.1-mini", steps: "3" },
      },
      {
        id: "step-evaluation",
        label: "Evaluate required metrics",
        kind: "Evaluation",
        summary: "All required metrics passed",
        detail: "Required coverage is 100% and the result is conclusive.",
        tone: "passed",
        startMs: 624,
        durationMs: 38,
        spanId: "preview-pass-evaluation",
        parentSpanId: "preview-pass-root",
        attributes: { required_coverage: "100%", verdict: "conclusive" },
      },
    ],
    scores: [
      {
        id: "score-clarity",
        metric: "llm.response_completeness",
        requirement: "Required",
        status: "Scored",
        score: 0.96,
        threshold: 0.8,
        rationale: "The response included every required verification step.",
        tone: "passed",
      },
      {
        id: "score-policy",
        metric: "guideline.identity_verification",
        requirement: "Required",
        status: "Scored",
        score: 1,
        threshold: 0.9,
        rationale: "The response followed the approved verification policy.",
        tone: "passed",
      },
    ],
    manifest: [
      ...SHARED_MANIFEST,
      {
        id: "manifest-tool-call",
        category: "Tool calls",
        requirement: "Optional",
        capture: "Captured",
        records: "0 · none observed",
        completeness: "Attested complete",
        provenance: "Evaluation collector",
        tone: "optional",
      },
      {
        id: "manifest-trace",
        category: "Execution trace",
        requirement: "Optional",
        capture: "Not required",
        records: "—",
        completeness: "Not required",
        provenance: "Not applicable",
        tone: "optional",
      },
    ],
  },
];

const VIEWS: Array<{ id: EvidencePreviewView; label: string; icon: typeof MessageSquareText }> = [
  { id: "thread", label: "Thread", icon: MessageSquareText },
  { id: "trace", label: "Trace", icon: ListTree },
  { id: "scores", label: "Scores", icon: CheckCircle2 },
  { id: "manifest", label: "Manifest", icon: FileText },
];

const FILTERS: Array<{ id: EvidencePreviewFilter; label: string }> = [
  { id: "attention", label: "Needs attention" },
  { id: "missing", label: "Missing evidence" },
  { id: "passed", label: "Passed" },
  { id: "all", label: "All" },
];

function isView(value: string | null | undefined): value is EvidencePreviewView {
  return VIEWS.some((item) => item.id === value);
}

function isFilter(value: string | null | undefined): value is EvidencePreviewFilter {
  return FILTERS.some((item) => item.id === value);
}

function isPreviewState(value: string | null | undefined): value is EvidencePreviewState {
  return value === "ready" || value === "loading" || value === "error" || value === "permission";
}

function caseMatchesFilter(item: SimulatedEvidenceCase, filter: EvidencePreviewFilter): boolean {
  if (filter === "all") return true;
  if (filter === "attention") return item.status !== "passed";
  return item.status === filter;
}

function toneClasses(tone: EvidenceTone): string {
  if (tone === "missing") return "text-state-caution";
  if (tone === "failed") return "text-destructive";
  if (tone === "passed") return "text-gate-pass";
  return "text-foreground";
}

function toneDotClasses(tone: EvidenceTone): string {
  if (tone === "missing") return "bg-state-caution";
  if (tone === "failed") return "bg-destructive";
  if (tone === "passed") return "bg-gate-pass";
  if (tone === "optional") return "bg-muted-foreground/50";
  return "bg-foreground/65";
}


export function evidencePreviewSearch(
  current: URLSearchParams,
  next: Partial<{
    caseId: string;
    view: EvidencePreviewView;
    filter: EvidencePreviewFilter;
    stepId: string;
  }>,
): string {
  const params = new URLSearchParams(current);
  params.set("evidencePreview", "1");
  if (next.caseId) params.set("case", next.caseId);
  if (next.view) params.set("view", next.view);
  if (next.filter) params.set("filter", next.filter);
  if (next.stepId) params.set("step", next.stepId);
  return params.toString();
}

function updatePreviewUrl(next: Parameters<typeof evidencePreviewSearch>[1]) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.search = evidencePreviewSearch(url.searchParams, next);
  window.history.replaceState(window.history.state, "", url);
}

function PreviewBoundary() {
  return (
    <div className="flex items-start gap-3 border border-state-caution/30 bg-state-caution-soft px-4 py-3 text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution">
      <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-semibold">Demo trace</p>
        <p className="mt-1 text-sm leading-6">
          This data was not captured from a running application. It cannot create or change a
          run, score, evidence status, export, or verdict.
        </p>
      </div>
    </div>
  );
}

function PreviewStatePanel({ state }: { state: Exclude<EvidencePreviewState, "ready"> }) {
  if (state === "loading") {
    return (
      <div role="status" className="flex min-h-72 items-center justify-center border-x border-b bg-background px-6 text-center">
        <div>
          <span className="mx-auto block size-6 animate-spin rounded-full border-2 border-muted border-t-foreground" aria-hidden="true" />
          <p className="mt-4 text-sm font-medium">Loading prototype evidence…</p>
          <p className="mt-1 text-sm text-muted-foreground">Preparing simulated cases and execution records.</p>
        </div>
      </div>
    );
  }
  if (state === "permission") {
    return (
      <div className="flex min-h-72 items-center justify-center border-x border-b bg-background px-6 text-center">
        <div className="max-w-md">
          <ShieldAlert className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
          <p className="mt-4 text-sm font-semibold">Evidence hidden</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Your current role cannot view case payloads or execution details. Ask a workspace administrator for evidence-review access.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-72 items-center justify-center border-x border-b bg-background px-6 text-center">
      <div className="max-w-md">
        <AlertTriangle className="mx-auto size-6 text-red-600 dark:text-red-300" aria-hidden="true" />
        <p className="mt-4 text-sm font-semibold">Prototype evidence could not be loaded</p>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          The preview fixture is unavailable. Reload this page to try again; the saved run is unaffected.
        </p>
        <button type="button" onClick={() => window.location.reload()} className="mt-4 min-h-11 rounded-full border px-4 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Reload prototype
        </button>
      </div>
    </div>
  );
}

function StatusIcon({ tone }: { tone: EvidenceTone }) {
  if (tone === "missing" || tone === "failed") {
    return <AlertTriangle className={cn("size-4", toneClasses(tone))} aria-hidden="true" />;
  }
  if (tone === "passed") {
    return <CheckCircle2 className="size-4 text-state-positive" aria-hidden="true" />;
  }
  return <CircleDashed className="size-4 text-muted-foreground" aria-hidden="true" />;
}

function CaseStatus({ item }: { item: SimulatedEvidenceCase }) {
  const tone: EvidenceTone = item.status === "passed" ? "passed" : item.status === "attention" ? "failed" : "missing";
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", toneClasses(tone))}>
      <span className={cn("size-1.5 rounded-full", toneDotClasses(tone))} aria-hidden="true" />
      {item.status === "missing" ? "Missing evidence" : item.status === "attention" ? "Failed" : "Passed"}
    </span>
  );
}

function CaseNavigator({
  cases,
  selectedId,
  onSelect,
}: {
  cases: SimulatedEvidenceCase[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (cases.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm font-medium">No cases match this filter</p>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">Choose another evidence filter to continue reviewing.</p>
      </div>
    );
  }
  return (
    <nav aria-label="Prototype evaluation cases" className="divide-y">
      {cases.map((item) => {
        const selected = item.id === selectedId;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelect(item.id)}
            className={cn(
              "min-h-11 w-full border-l-2 border-l-transparent px-4 py-3 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              selected && "border-l-foreground bg-muted/35",
            )}
          >
            <span className="block text-xs font-mono text-muted-foreground">{item.id}</span>
            <span className="mt-1 block text-sm font-medium leading-5">{item.shortTitle}</span>
            <span className="mt-2 block"><CaseStatus item={item} /></span>
          </button>
        );
      })}
    </nav>
  );
}

function ThreadView({
  item,
  selectedStepId,
  onSelect,
}: {
  item: SimulatedEvidenceCase;
  selectedStepId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <ol aria-label="Execution thread" className="divide-y">
      {item.steps.map((step, index) => {
        const selected = step.id === selectedStepId;
        return (
          <li key={step.id} className="relative pl-5">
            {index < item.steps.length - 1 ? <span className="absolute bottom-0 left-[1.7rem] top-8 w-px bg-border" aria-hidden="true" /> : null}
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(step.id)}
              className={cn(
                "relative min-h-11 w-full px-4 py-4 text-left hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selected && "bg-muted/35",
              )}
            >
              <span className={cn("absolute left-0 top-[1.45rem] size-3 rounded-full border-2 border-background", toneDotClasses(step.tone))} aria-hidden="true" />
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold">{step.label}</span>
                <span className="text-xs text-muted-foreground">{step.kind}</span>
              </span>
              <span className={cn("mt-1 block text-sm leading-6", step.tone === "captured" || step.tone === "optional" ? "text-muted-foreground" : toneClasses(step.tone))}>
                {step.summary}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function TraceView({
  item,
  selectedStepId,
  onSelect,
}: {
  item: SimulatedEvidenceCase;
  selectedStepId: string;
  onSelect: (id: string) => void;
}) {
  if (!item.traceAvailable) {
    return (
      <div className="flex min-h-64 items-center justify-center px-6 text-center">
        <div className="max-w-md">
          <ListTree className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
          <p className="mt-4 text-sm font-semibold">Trace not required for this case</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Required final-response and tool evidence is complete. No trace identity was recorded, and none is inferred.
          </p>
        </div>
      </div>
    );
  }
  return (
    <ol aria-label="Execution trace" className="divide-y">
      {item.steps.map((step, index) => {
        const start = step.startMs ?? 0;
        const duration = step.durationMs ?? 1;
        const startPct = Math.min((start / item.totalDurationMs) * 100, 98);
        const durationPct = Math.max((duration / item.totalDurationMs) * 100, 1.5);
        const selected = step.id === selectedStepId;
        return (
          <li key={step.id}>
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(step.id)}
              className={cn(
                "grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] gap-4 px-4 py-3 text-left hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selected && "bg-muted/35",
              )}
            >
              <span className="min-w-0" style={{ paddingLeft: `${index === 0 ? 0 : 16}px` }}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cn("size-1.5 shrink-0 rounded-full", toneDotClasses(step.tone))} aria-hidden="true" />
                  <span className="truncate font-mono text-xs font-semibold">{step.label}</span>
                </span>
                <span className="mt-2 block h-1 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-foreground/55" style={{ marginLeft: `${startPct}%`, width: `${Math.min(durationPct, 100 - startPct)}%` }} />
                </span>
                <span className="mt-1.5 block text-xs text-muted-foreground">{step.kind} · starts {start}ms</span>
              </span>
              <span className="font-mono text-xs font-semibold tabular-nums">{(formatDuration(step.durationMs) ?? "—")}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function ScoresView({
  item,
  selectedId,
  onSelect,
}: {
  item: SimulatedEvidenceCase;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="divide-y">
      {item.scores.map((score) => {
        const selected = selectedId === score.id;
        return (
          <button
            key={score.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(score.id)}
            className={cn(
              "grid min-h-11 w-full gap-2 px-4 py-4 text-left hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_7rem_5rem] sm:items-center",
              selected && "bg-muted/35",
            )}
          >
            <span className="min-w-0">
              <span className="block break-words font-mono text-xs font-semibold">{score.metric}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{score.requirement}</span>
            </span>
            <span className={cn("text-sm font-medium", toneClasses(score.tone))}>{score.status}</span>
            <span className="font-mono text-sm font-semibold tabular-nums sm:text-right">
              {score.score === null ? "—" : `${Math.round(score.score * 100)}%`}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ManifestView({
  item,
  selectedId,
  onSelect,
}: {
  item: SimulatedEvidenceCase;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="divide-y">
      {item.manifest.map((row) => {
        const selected = selectedId === row.id;
        return (
          <button
            key={row.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(row.id)}
            className={cn(
              "grid min-h-11 w-full gap-2 px-4 py-4 text-left hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_7rem_8rem] sm:items-center",
              selected && "bg-muted/35",
            )}
          >
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{row.category}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{row.requirement}</span>
            </span>
            <span className={cn("text-sm font-medium", toneClasses(row.tone))}>{row.capture}</span>
            <span className="font-mono text-xs tabular-nums sm:text-right">{row.records}</span>
          </button>
        );
      })}
    </div>
  );
}

function Inspector({
  item,
  view,
  selectedStepId,
  selectedScoreId,
  selectedManifestId,
}: {
  item: SimulatedEvidenceCase;
  view: EvidencePreviewView;
  selectedStepId: string;
  selectedScoreId: string;
  selectedManifestId: string;
}) {
  if (view === "scores") {
    const score = item.scores.find((candidate) => candidate.id === selectedScoreId) ?? item.scores[0];
    const attachedStep = score.stepId
      ? item.steps.find((candidate) => candidate.id === score.stepId)
      : undefined;
    return (
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">Score details</p>
        <h4 className="mt-2 break-words font-mono text-sm font-semibold">{score.metric}</h4>
        <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
          <div><dt className="text-muted-foreground">Requirement</dt><dd className="mt-1 font-medium">{score.requirement}</dd></div>
          <div><dt className="text-muted-foreground">Status</dt><dd className={cn("mt-1 font-medium", toneClasses(score.tone))}>{score.status}</dd></div>
          <div><dt className="text-muted-foreground">Score</dt><dd className={cn("mt-1", score.score === null ? "text-muted-foreground" : "font-mono tabular-nums")}>{score.score === null ? "Not scored" : `${Math.round(score.score * 100)}%`}</dd></div>
          <div><dt className="text-muted-foreground">Threshold</dt><dd className="mt-1 font-mono tabular-nums">{Math.round(score.threshold * 100)}%</dd></div>
        </dl>
        <div className="mt-5 border-t pt-4"><p className="text-xs font-semibold">Rationale</p><p className="mt-2 text-sm leading-6 text-muted-foreground">{score.rationale}</p></div>
        <div className="mt-5 border-t pt-4"><p className="text-xs font-semibold">Attached step</p><p className="mt-2 text-sm text-muted-foreground">{attachedStep?.label ?? "Run-level score"}</p></div>
      </div>
    );
  }
  if (view === "manifest") {
    const row = item.manifest.find((candidate) => candidate.id === selectedManifestId) ?? item.manifest[0];
    return (
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">Manifest details</p>
        <h4 className="mt-2 text-sm font-semibold">{row.category}</h4>
        <dl className="mt-5 space-y-4 text-sm">
          <div><dt className="text-muted-foreground">Requirement</dt><dd className="mt-1 font-medium">{row.requirement}</dd></div>
          <div><dt className="text-muted-foreground">Capture</dt><dd className={cn("mt-1 font-medium", toneClasses(row.tone))}>{row.capture}</dd></div>
          <div><dt className="text-muted-foreground">Records</dt><dd className="mt-1 font-mono tabular-nums">{row.records}</dd></div>
          <div><dt className="text-muted-foreground">Completeness</dt><dd className="mt-1">{row.completeness}</dd></div>
          <div><dt className="text-muted-foreground">Provenance</dt><dd className="mt-1">{row.provenance}</dd></div>
        </dl>
      </div>
    );
  }
  const step = item.steps.find((candidate) => candidate.id === selectedStepId) ?? item.steps[0];
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">Step details</p>
      <div className="mt-2 flex items-start gap-2">
        <StatusIcon tone={step.tone} />
        <h4 className="min-w-0 text-sm font-semibold">{step.label}</h4>
      </div>
      <p className="mt-4 text-sm leading-6 text-muted-foreground">{step.detail}</p>
      {step.annotation ? (
        <div className="mt-4 border-l-2 border-state-caution/30 bg-state-caution-soft px-3 py-2 text-sm leading-6 text-state-caution dark:bg-state-caution-soft dark:text-state-caution">
          <span className="font-semibold">Annotation:</span> {step.annotation}
        </div>
      ) : null}
      <dl className="mt-5 grid grid-cols-2 gap-4 border-t pt-4 text-sm">
        <div><dt className="text-muted-foreground">Type</dt><dd className="mt-1 font-medium">{step.kind}</dd></div>
        <div><dt className="text-muted-foreground">Duration</dt><dd className="mt-1 font-mono tabular-nums">{(formatDuration(step.durationMs) ?? "—")}</dd></div>
        <div className="col-span-2"><dt className="text-muted-foreground">Span ID</dt><dd className="mt-1 break-all font-mono text-xs" translate="no">{step.spanId ?? "Not captured for this run"}</dd></div>
        <div className="col-span-2"><dt className="text-muted-foreground">Parent span ID</dt><dd className="mt-1 break-all font-mono text-xs" translate="no">{step.parentSpanId ?? (step.spanId ? "Root span" : "Not captured for this run")}</dd></div>
      </dl>
      {step.input !== undefined ? <EvidencePayload label="Input" value={step.input} /> : null}
      {step.output !== undefined ? <EvidencePayload label="Output" value={step.output} /> : null}
      <div className="mt-5 border-t pt-4">
        <p className="text-xs font-semibold">Attributes</p>
        <dl className="mt-2 divide-y border text-xs">
          {Object.entries(step.attributes).map(([key, value]) => (
            <div key={key} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
              <dt className="break-all font-mono text-muted-foreground" translate="no">{key}</dt>
              <dd className="break-all font-mono sm:text-right" translate="no">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function EvidencePayload({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="mt-5 border-t pt-4">
      <p className="text-xs font-semibold">{label}</p>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 text-xs leading-5">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export function SimulatedEvidenceWorkbench({
  config,
  cases = SIMULATED_EVIDENCE_CASES,
}: {
  config: SimulatedEvidencePreviewConfig;
  cases?: SimulatedEvidenceCase[];
}) {
  const initialFilter = isFilter(config.filter) ? config.filter : "attention";
  const initialView = isView(config.view) ? config.view : "thread";
  const initialCase = cases.find((item) => item.id === config.caseId) ?? cases.find((item) => caseMatchesFilter(item, initialFilter)) ?? cases[0];
  const [filter, setFilter] = useState<EvidencePreviewFilter>(initialFilter);
  const [view, setView] = useState<EvidencePreviewView>(initialView);
  const [selectedCaseId, setSelectedCaseId] = useState(initialCase?.id ?? "");
  const [selectedStepId, setSelectedStepId] = useState(config.stepId ?? initialCase?.steps[0]?.id ?? "");
  const [selectedScoreId, setSelectedScoreId] = useState(initialCase?.scores[0]?.id ?? "");
  const [selectedManifestId, setSelectedManifestId] = useState(initialCase?.manifest[0]?.id ?? "");
  const previewState = isPreviewState(config.state) ? config.state : "ready";
  const selectedCase = cases.find((item) => item.id === selectedCaseId) ?? cases[0];
  const filteredCases = cases.filter((item) => caseMatchesFilter(item, filter));

  function selectCase(id: string) {
    const next = cases.find((item) => item.id === id);
    if (!next) return;
    setSelectedCaseId(id);
    setSelectedStepId(next.steps[0]?.id ?? "");
    setSelectedScoreId(next.scores[0]?.id ?? "");
    setSelectedManifestId(next.manifest[0]?.id ?? "");
    updatePreviewUrl({ caseId: id, stepId: next.steps[0]?.id ?? "" });
  }

  function selectFilter(nextFilter: EvidencePreviewFilter) {
    setFilter(nextFilter);
    const nextCases = cases.filter((item) => caseMatchesFilter(item, nextFilter));
    const nextSelected = nextCases.some((item) => item.id === selectedCaseId) ? selectedCaseId : nextCases[0]?.id;
    if (nextSelected && nextSelected !== selectedCaseId) selectCase(nextSelected);
    updatePreviewUrl({ filter: nextFilter, ...(nextSelected ? { caseId: nextSelected } : {}) });
  }

  function selectView(nextView: EvidencePreviewView) {
    setView(nextView);
    updatePreviewUrl({ view: nextView });
  }

  function moveViewFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % VIEWS.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + VIEWS.length) % VIEWS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = VIEWS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = VIEWS[nextIndex];
    selectView(next.id);
    document.getElementById(`evidence-preview-tab-${next.id}`)?.focus();
  }

  if (cases.length === 0) {
    return (
      <div>
        <PreviewBoundary />
        <div className="flex min-h-72 items-center justify-center border-x border-b bg-background px-6 text-center">
          <div><p className="text-sm font-semibold">No prototype cases</p><p className="mt-1 text-sm text-muted-foreground">Add simulated evidence cases before reviewing this workspace.</p></div>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl">
      <PreviewBoundary />
      {previewState !== "ready" ? <PreviewStatePanel state={previewState} /> : selectedCase ? (
        <div className="border-x border-b bg-background">
          <div className="flex flex-col gap-3 border-b px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">Selected demo case</span>
                <ToneBadge
                  size="md"
                  tone={selectedCase.status === "attention" ? "fail" : selectedCase.status === "missing" ? "warn" : "pass"}
                >
                  {selectedCase.status === "attention" ? "Failed example" : selectedCase.status === "missing" ? "Missing evidence example" : "Passing example"}
                </ToneBadge>
              </div>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">This prototype demonstrates inspection states only. It does not calculate a real verdict or release gate.</p>
            </div>
            <dl className="flex shrink-0 flex-wrap gap-x-5 gap-y-2 text-xs">
              <div><dt className="text-muted-foreground">Scope</dt><dd className="mt-1 font-medium">Full execution demo</dd></div>
              <div><dt className="text-muted-foreground">Example state</dt><dd className="mt-1 font-medium capitalize">{selectedCase.status}</dd></div>
            </dl>
          </div>

          <div className="grid gap-3 border-b p-3 sm:grid-cols-[11rem_minmax(0,1fr)] xl:hidden">
            <label htmlFor="evidence-preview-filter" className="text-xs font-medium text-muted-foreground">
              Show cases
              <select
                id="evidence-preview-filter"
                value={filter}
                onChange={(event) => selectFilter(event.target.value as EvidencePreviewFilter)}
                className="mt-1.5 min-h-11 w-full rounded-lg border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {FILTERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label htmlFor="evidence-preview-case" className="text-xs font-medium text-muted-foreground">
              Evaluation case
              <select
                id="evidence-preview-case"
                value={selectedCase.id}
                onChange={(event) => selectCase(event.target.value)}
                className="mt-1.5 min-h-11 w-full rounded-lg border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {filteredCases.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.shortTitle}</option>)}
              </select>
            </label>
          </div>

          <div className="xl:grid xl:grid-cols-[16rem_minmax(0,1fr)_20rem]">
            <aside className="hidden min-w-0 border-r xl:block">
              <div className="border-b p-3">
                <p className="text-xs font-semibold">Cases</p>
                <div role="group" aria-label="Filter prototype cases" className="mt-2 grid grid-cols-2 gap-1">
                  {FILTERS.map((candidate) => (
                    <button key={candidate.id} type="button" aria-pressed={filter === candidate.id} onClick={() => selectFilter(candidate.id)} className={cn("min-h-11 rounded-lg px-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", filter === candidate.id ? "bg-muted text-foreground" : "text-muted-foreground")}>
                      {candidate.label}
                    </button>
                  ))}
                </div>
              </div>
              <CaseNavigator cases={filteredCases} selectedId={selectedCase.id} onSelect={selectCase} />
            </aside>

            <section aria-labelledby="evidence-preview-case-title" className="min-w-0 border-b xl:border-b-0 xl:border-r">
              <header className="border-b px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2"><span className="font-mono text-xs text-muted-foreground">{selectedCase.id}</span><CaseStatus item={selectedCase} /></div>
                    <h3 id="evidence-preview-case-title" className="mt-2 text-pretty text-base font-semibold leading-6">{selectedCase.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{selectedCase.summary}</p>
                  </div>
                  <div className="shrink-0 text-right text-xs"><p className="text-muted-foreground">Case outcome</p><p className="mt-1 font-semibold">{selectedCase.outcome}</p></div>
                </div>
              </header>

              <div role="tablist" aria-label="Evidence views" className="grid grid-cols-4 border-b bg-muted/25 p-1">
                {VIEWS.map((candidate, index) => {
                  const Icon = candidate.icon;
                  const selected = view === candidate.id;
                  return (
                    <button
                      key={candidate.id}
                      id={`evidence-preview-tab-${candidate.id}`}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-controls="evidence-preview-panel"
                      tabIndex={selected ? 0 : -1}
                      onClick={() => selectView(candidate.id)}
                      onKeyDown={(event) => moveViewFocus(event, index)}
                      className={cn("flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg px-1 text-xs font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-2 sm:px-3", selected ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground")}
                    >
                      <Icon className="size-4" aria-hidden="true" />{candidate.label}
                    </button>
                  );
                })}
              </div>

              <div id="evidence-preview-panel" role="tabpanel" aria-labelledby={`evidence-preview-tab-${view}`} className="min-h-72">
                {view === "thread" ? <ThreadView item={selectedCase} selectedStepId={selectedStepId} onSelect={(id) => { setSelectedStepId(id); updatePreviewUrl({ stepId: id }); }} /> : null}
                {view === "trace" ? <TraceView item={selectedCase} selectedStepId={selectedStepId} onSelect={(id) => { setSelectedStepId(id); updatePreviewUrl({ stepId: id }); }} /> : null}
                {view === "scores" ? <ScoresView item={selectedCase} selectedId={selectedScoreId} onSelect={setSelectedScoreId} /> : null}
                {view === "manifest" ? <ManifestView item={selectedCase} selectedId={selectedManifestId} onSelect={setSelectedManifestId} /> : null}
              </div>
            </section>

            <aside aria-label="Selected evidence details" className="min-w-0 bg-muted/10 px-4 py-5">
              <Inspector item={selectedCase} view={view} selectedStepId={selectedStepId} selectedScoreId={selectedScoreId} selectedManifestId={selectedManifestId} />
            </aside>
          </div>

          <footer className="flex flex-col gap-1 border-t px-4 py-3 text-xs leading-5 text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>Preview fixture only · never submitted to evidence APIs</span>
            <span>Case, filter, view, and step are preserved in the URL</span>
          </footer>
        </div>
      ) : null}
    </div>
  );
}
