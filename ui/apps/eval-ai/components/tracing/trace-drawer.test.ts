/** @vitest-environment jsdom */

/**
 * The drawer keeps its header mounted across trace switches, so it must
 * (a) resolve run readability through `readabilityForTrace` — never a raw flag
 * left over from the previous trace — and (b) discard a late-resolving request
 * for an earlier trace instead of rendering it under the current header.
 */

import { createElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapturedTraceDetail } from "@/lib/api";

const getProjectTraceSummary = vi.fn();
const getProjectTraceSpans = vi.fn();
const getRunItem = vi.fn();
const readabilityForTrace = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    tenant: () => Promise.resolve({ tenant_id: "tenant-classroom" }),
    getProjectTraceSummary: (...args: unknown[]) => getProjectTraceSummary(...args),
    getProjectTraceSpans: (...args: unknown[]) => getProjectTraceSpans(...args),
  },
  evaluationApi: {
    getRunItem: (...args: unknown[]) => getRunItem(...args),
  },
}));

vi.mock("@/components/tracing/run-lineage-cta", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/components/tracing/run-lineage-cta")
  >();
  readabilityForTrace.mockImplementation(actual.readabilityForTrace);
  return { ...actual, readabilityForTrace: (...args: Parameters<typeof actual.readabilityForTrace>) => readabilityForTrace(...args) };
});

const { TraceDrawer } = await import("@/components/tracing/trace-drawer");

function trace(traceId: string, name: string): CapturedTraceDetail {
  return {
    project_id: "project-1",
    trace_id: traceId,
    trace_provider: "otel",
    run_id: `run-${traceId}`,
    example_id: "example-7",
    evaluation_name: name,
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
}

function drawer(traceId: string, selectedSpanId: string | null = null) {
  return createElement(TraceDrawer, {
    projectId: "project-1",
    traceId,
    selectedSpanId,
    currentQuery: "",
    onSelectSpan: () => {},
    onClose: () => {},
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TraceDrawer", () => {
  it("resolves the run link through readabilityForTrace", async () => {
    getProjectTraceSummary.mockResolvedValue(trace("trace-1", "Alpha suite"));
    getProjectTraceSpans.mockResolvedValue({ spans: [], tree_available: false });
    getRunItem.mockRejectedValue(new Error("boom"));

    render(drawer("trace-1", "child/span"));
    expect(screen.getByRole("link", { name: /Full page/ }).getAttribute("href")).toBe("/projects/project-1/traces/trace-1?span=child%2Fspan");

    await waitFor(() => {
      expect(screen.getByText("Alpha suite")).toBeTruthy();
    });
    // `expect.anything()` would reject the legitimate unresolved (`null`) state.
    expect(readabilityForTrace).toHaveBeenCalled();
    expect(readabilityForTrace.mock.calls.every(([id]) => id === "trace-1")).toBe(true);
  });

  it("discards a late response for the trace the user switched away from", async () => {
    let resolveAlpha: ((value: CapturedTraceDetail) => void) | null = null;
    getProjectTraceSummary.mockImplementation((_project: string, traceId: string) => {
      if (traceId === "trace-1") {
        return new Promise<CapturedTraceDetail>((resolve) => {
          resolveAlpha = resolve;
        });
      }
      return Promise.resolve(trace("trace-2", "Beta suite"));
    });
    getProjectTraceSpans.mockResolvedValue({ spans: [], tree_available: false });
    getRunItem.mockRejectedValue(new Error("boom"));

    const { rerender } = render(drawer("trace-1"));
    await waitFor(() => expect(getProjectTraceSummary).toHaveBeenCalled());

    rerender(drawer("trace-2"));
    await waitFor(() => {
      expect(screen.getByText("Beta suite")).toBeTruthy();
    });

    // Trace 1's summary lands after the user already moved on. Drain the whole
    // continuation (not one microtask) before asserting, so the check cannot
    // pass simply by running early.
    await act(async () => {
      resolveAlpha?.(trace("trace-1", "Alpha suite"));
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });

    expect(screen.queryByText("Alpha suite")).toBeNull();
    expect(screen.getByText("Beta suite")).toBeTruthy();
  });
});
