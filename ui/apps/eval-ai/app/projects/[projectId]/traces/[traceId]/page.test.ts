/** @vitest-environment jsdom */

/**
 * Trace detail page contracts, asserted against the rendered page:
 * - a readable run item deep-links the case with `?item={example_id}`;
 * - a 404 from `getRunItem` renders no dead link when the RUN is unreadable,
 *   but keeps the link when only the case is missing from a readable run;
 * - a transient failure (500/503/network) renders neither a link NOR the
 *   "another workspace" claim — it is not a workspace boundary.
 */

import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api-errors";
import {
  RUN_REPORT_LINEAGE_LABEL,
  RUN_UNREADABLE_EXPLANATION,
  runReportLineageHref,
} from "@/components/tracing/run-lineage-cta";
import type { CapturedTraceDetail, RunItemDetail } from "@/lib/api";

const getProjectTraceSummary = vi.fn();
const getProjectTraceSpans = vi.fn();
const getRunItem = vi.fn();
const getRun = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "project-1", traceId: "trace-1" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    tenant: () => Promise.resolve({ tenant_id: "tenant-classroom" }),
    getProjectTraceSummary: (...args: unknown[]) => getProjectTraceSummary(...args),
    getProjectTraceSpans: (...args: unknown[]) => getProjectTraceSpans(...args),
  },
  evaluationApi: {
    getRunItem: (...args: unknown[]) => getRunItem(...args),
    getRun: (...args: unknown[]) => getRun(...args),
  },
}));

const TraceDetailPage = (await import("@/app/projects/[projectId]/traces/[traceId]/page")).default;

const trace: CapturedTraceDetail = {
  project_id: "project-1",
  trace_id: "trace-1",
  trace_provider: "otel",
  run_id: "run-42",
  example_id: "example-7",
  evaluation_name: "Fraud agent suite",
  captured_at: "2026-08-03T00:00:00Z",
  capture_state: "captured",
  attestation_state: "attested",
  invocation_outcome: "succeeded",
  latency_ms: 420,
  input_tokens: null,
  output_tokens: null,
  total_tokens: null,
  cost: null,
  run_status: "completed",
  verdict_status: "conclusive",
  overall_gate: "pass",
  spans: [],
  tree_available: false,
};

const runItem: RunItemDetail = {
  run_id: "run-42",
  example_id: "example-7",
  sequence_position: 0,
  dataset_version: "ds_demo",
  input: { query: "How do I cancel?" },
  output: { response: "Open settings." },
  expected: null,
  metadata: null,
  retrieval_snippets: null,
  expected_tools: [],
  tool_calls: [],
  tool_result_artifacts: [],
  execution: {
    invocation_id: null,
    kagent_session_id: null,
    latency_ms: 420,
    usage: null,
    invocation_error: null,
    trace_id: "trace-1",
    span_id: null,
  },
  scorer_results: [],
  evidence_ref: "evidence://example-7",
  evidence_policy: {
    redaction_enabled: true,
    max_persisted_string_size: 10000,
    retention_policy: "stored_with_run_lifecycle",
  },
  capture_state: "complete",
};

function renderPage() {
  return render(createElement(TraceDetailPage));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("trace detail run lineage", () => {
  it("opens a captured trace without requesting nonexistent evaluation scores", async () => {
    getProjectTraceSummary.mockResolvedValue({ ...trace, project_id: null, run_id: null, example_id: null, evaluation_name: null, root_span_name: "Agent invocation" });
    getProjectTraceSpans.mockResolvedValue({ spans: [], tree_available: false });
    renderPage();
    await screen.findByRole("heading", { name: "Agent invocation" });
    expect(getRunItem).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
    expect(screen.queryByText(RUN_REPORT_LINEAGE_LABEL)).toBeNull();
    expect(screen.queryByText("Unable to load trace scores")).toBeNull();
  });

  it("still names the destination and deep-links the case", () => {
    expect(RUN_REPORT_LINEAGE_LABEL).toBe("Open run report");
    expect(runReportLineageHref("run-42", "example-7")).toBe("/runs/run-42?item=example-7");
  });

  it("links to the run report case when the run item is readable", async () => {
    getProjectTraceSummary.mockResolvedValue(trace);
    getProjectTraceSpans.mockResolvedValue({ spans: [], tree_available: false });
    getRunItem.mockResolvedValue(runItem);

    const { container } = renderPage();

    await waitFor(() => {
      expect(screen.getByText(RUN_REPORT_LINEAGE_LABEL)).toBeTruthy();
    });
    expect(container.innerHTML).toContain('href="/runs/run-42?item=example-7"');
  });

  it("renders no dead link when the run itself is not readable", async () => {
    getProjectTraceSummary.mockResolvedValue(trace);
    getProjectTraceSpans.mockResolvedValue({ spans: [], tree_available: false });
    getRunItem.mockRejectedValue(
      new ApiError({ status: 404, code: "not_found", message: "Run item not found." }),
    );
    getRun.mockRejectedValue(
      new ApiError({ status: 404, code: "not_found", message: "Run not found." }),
    );

    const { container } = renderPage();

    await waitFor(() => {
      expect(screen.getByText(RUN_UNREADABLE_EXPLANATION)).toBeTruthy();
    });
    expect(container.innerHTML).not.toContain('href="/runs/');
  });

  it("keeps the run link when only the case is missing from a readable run", async () => {
    // The item endpoint answers 404 for a missing case too, so the run
    // endpoint — not the item 404 — decides the workspace claim.
    getProjectTraceSummary.mockResolvedValue(trace);
    getProjectTraceSpans.mockResolvedValue({ spans: [], tree_available: false });
    getRunItem.mockRejectedValue(
      new ApiError({ status: 404, code: "not_found", message: "Example example-7 not found in run run-42." }),
    );
    getRun.mockResolvedValue({ run_id: "run-42", status: "completed" });

    const { container } = renderPage();

    await waitFor(() => {
      expect(screen.getByText(RUN_REPORT_LINEAGE_LABEL)).toBeTruthy();
    });
    expect(container.innerHTML).toContain('href="/runs/run-42?item=example-7"');
    expect(screen.queryByText(RUN_UNREADABLE_EXPLANATION)).toBeNull();
  });

  it("never claims another workspace on a transient run-item failure", async () => {
    getProjectTraceSummary.mockResolvedValue(trace);
    getProjectTraceSpans.mockResolvedValue({ spans: [], tree_available: false });
    getRunItem.mockRejectedValue(
      new ApiError({ status: 503, code: "service_unavailable", message: "Proofgrove is unavailable." }),
    );

    const { container } = renderPage();

    // The page itself still renders; only the lineage CTA stays unresolved.
    await waitFor(() => {
      expect(screen.getByText("Fraud agent suite")).toBeTruthy();
    });
    expect(container.innerHTML).not.toContain('href="/runs/');
    expect(screen.queryByText(RUN_UNREADABLE_EXPLANATION)).toBeNull();
    expect(screen.queryByText(RUN_REPORT_LINEAGE_LABEL)).toBeNull();
  });

});
