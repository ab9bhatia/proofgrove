import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CapturedTraceSummary } from "@/lib/api";
import { TraceTable } from "@/components/tracing/trace-table";

function trace(overrides: Partial<CapturedTraceSummary> = {}): CapturedTraceSummary {
  return {
    project_id: "proj-1",
    trace_id: "trace-abcdef0123456789",
    trace_provider: "otel",
    run_id: "run-1",
    example_id: "example-1",
    evaluation_name: "Checkout regression",
    input_summary: "How do I return an order?",
    evaluation_status: "evaluated",
    target_revision: "rev-42",
    captured_at: "2026-08-01T10:00:00Z",
    capture_state: "captured",
    attestation_state: "attested",
    invocation_outcome: "succeeded",
    latency_ms: 812,
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    cost: null,
    run_status: "completed",
    verdict_status: null,
    overall_gate: null,
    ...overrides,
  };
}

function render(traces: CapturedTraceSummary[]): string {
  return renderToStaticMarkup(
    createElement(TraceTable, { traces, projectId: "proj-1" }),
  );
}

describe("trace table row navigation", () => {
  it("makes the trailing arrow a real link with an accessible name", () => {
    const html = render([trace()]);
    const href = "/projects/proj-1/traces/trace-abcdef0123456789";

    // The trailing cell holds a focusable anchor, not aria-hidden decoration.
    expect(html).toContain(`aria-label="Open trace trace-abcdef0123456789"`);
    // Both the trace-id link and the trailing arrow link point at the trace.
    const hrefCount = html.split(`href="${href}"`).length - 1;
    expect(hrefCount).toBeGreaterThanOrEqual(2);
  });

  it("keeps the trailing link keyboard-visible with a focus ring", () => {
    const html = render([trace()]);
    const arrowLink = html.slice(html.indexOf('aria-label="Open trace'));
    expect(arrowLink).toContain("focus-visible:ring-2");
    expect(arrowLink).toContain("focus-visible:outline-none");
  });

  it("URL-encodes the project and trace ids in the trailing link", () => {
    const html = render([trace({ trace_id: "trace/with slash" })]);
    expect(html).toContain("/projects/proj-1/traces/trace%2Fwith%20slash");
  });
});

describe("trace table responsive markup", () => {
  it("serves every width from one markup", () => {
    const html = render([trace()]);

    // Pairing related facts vertically got the table under the ~720px content
    // column, which removed the reason for a parallel card layout. Two designs
    // to keep in sync was how the card and table views drifted apart.
    expect(html).not.toContain("lg:hidden");
    expect(html).not.toContain("lg:block");
    expect(html.split("<table").length - 1).toBe(1);
  });

  it("bounds the table inside its own scroll container", () => {
    const html = render([trace()]);
    expect(html).toMatch(/min-w-0 max-w-full overflow-x-auto/);
    expect(html).toContain("min-w-[680px]");
  });
});

describe("whole-row navigation", () => {
  it("marks evaluation rows with the row target and a pointer cursor", () => {
    const html = render([trace()]);
    expect(html).toContain(`data-href="/projects/proj-1/traces/trace-abcdef0123456789"`);
    expect(html).toContain("cursor-pointer");
  });

  it("opens non-evaluation index rows in the trace viewer", () => {
    const html = render([
      trace({
        run_id: null,
        example_id: null,
        evaluation_name: null,
        run_status: null,
        evaluation_status: "not_evaluated",
        lifecycle_state: "archive_confirmed",
        root_span_name: "cron.job",
      }),
    ]);
    expect(html).toContain("data-href");
    expect(html).toContain("cursor-pointer");
    expect(html).toContain("/traces/trace-abcdef0123456789");
    expect(html).toContain("aria-label=\"Open trace");
    // The captured identity remains visible.
    expect(html).toContain("trace-abcdef0123456789");
  });
});

describe("trace visibility actions", () => {
  it("offers hide for visible index rows and unhide for hidden rows", () => {
    const visible = renderToStaticMarkup(createElement(TraceTable, {
      traces: [trace({ lifecycle_state: "archive_confirmed" })],
      projectId: "proj-1",
      onToggleHidden: () => undefined,
    }));
    const hidden = renderToStaticMarkup(createElement(TraceTable, {
      traces: [trace({ lifecycle_state: "archive_confirmed", hidden: true })],
      projectId: "proj-1",
      onToggleHidden: () => undefined,
    }));

    expect(visible).toContain('aria-label="Hide trace trace-abcdef0123456789"');
    expect(hidden).toContain('aria-label="Unhide trace trace-abcdef0123456789"');
    expect(hidden).toContain("Hidden");
  });
});

describe("two-tier row", () => {
  it("gives the row exactly seven columns", () => {
    const html = render([trace()]);
    const headers = [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((match) => match[1]);
    expect(headers).toEqual([
      "Trace",
      "Status",
      "AI operations",
      "Latency",
      "Tokens",
      "Cost",
      "Started",
      '<span class="sr-only">Actions</span>',
    ]);
  });

  it("puts the identity line at full contrast and everything else muted", () => {
    const html = render([trace({ input_summary: "How do I return an order?" })]);
    // The contrast bug this replaced: every cell was text-muted-foreground, so
    // no column anchored the row.
    expect(html).toMatch(/class="truncate font-medium text-foreground">How do I return an order\?/);
    expect(html).toContain("font-mono");
  });

  it("pairs the error count under the span count", () => {
    const html = render([
      trace({
        lifecycle_state: "archive_confirmed",
        root_span_name: "agent.run",
        span_count: 12,
        error_count: 2,
      }),
    ]);
    expect(html).toContain(">12</p>");
    expect(html).toContain("2 errors");
    // The root span keeps its place, on the row's second line.
    expect(html).toContain("agent.run");
    // Numeric cells keep tabular numerals. The outcome badge is the only colour
    // in the row: an error count beside a successful invocation is detail, and
    // painting it red made every such row argue with itself.
    expect(html).toContain("tabular-nums");
    expect(html).not.toContain("text-gate-fail");
  });

  it("labels second-line values that do not describe themselves", () => {
    const html = render([trace({ root_span_name: "agent.run", target_revision: "rev-42" })]);
    // These lost their own column header, so they carry the label instead —
    // otherwise a screen reader reads "rev-42" with nothing to attach it to.
    expect(html).toContain("Root span: ");
    expect(html).toContain("Errors: ");
    expect(html).toContain("Target revision: ");
    expect(html).toContain("Evaluation: ");
  });

  it("formats latency and tokens for reading, not for the wire", () => {
    const fast = render([trace({ latency_ms: 812, total_tokens: 150 })]);
    expect(fast).toContain("812ms");
    const slow = render([trace({ latency_ms: 1240, total_tokens: 3410 })]);
    expect(slow).toContain("1.2s");
    // Fixed locale: this renders server-side too, so the separator must not
    // depend on the host's locale.
    expect(slow).toContain("3,410");
  });

  it("shortens the root span display but preserves its full tooltip", () => {
    const fullName = "openinference.instrumentation.langchain.chain.invoke";
    const html = render([trace({ root_span_name: fullName })]);
    expect(html).toContain("openinference.…chain.invoke");
    expect(html).toContain(`title="${fullName}"`);
  });

  it("keeps a succeeded outcome green whether or not spans recorded errors", () => {
    const badgeClass = (html: string) => {
      const span = html.slice(0, html.indexOf(">succeeded")).match(/<span class="([^"]*)"$/);
      if (!span) throw new Error("outcome badge not found");
      return span[1];
    };
    const clean = render([trace({ invocation_outcome: "succeeded", error_count: 0 })]);
    expect(badgeClass(clean)).toContain("gate-pass");

    // The badge states the invocation outcome and nothing else. Downgrading it on
    // any span error turned almost every row amber and called a call that returned
    // successfully questionable; the span errors are reported in their own column.
    const withErrors = render([trace({ invocation_outcome: "succeeded", error_count: 2 })]);
    expect(badgeClass(withErrors)).toContain("gate-pass");
  });

  it("shows honest placeholders when the archive was never read", () => {
    const html = render([trace({ lifecycle_state: "requested", span_count: null, error_count: null, root_span_name: null })]);
    expect(html).toContain("—");
    expect(html).not.toContain(">0</td>"); // no fabricated zero counts
  });
});


describe("root span kind chip", () => {
  it("renders a muted root_span_kind chip when present", () => {
    const html = render([trace({ root_span_name: "POST /", root_span_kind: "SERVER" })]);
    expect(html).toContain("POST /");
    expect(html).toContain("server");
  });
});


describe("trace column sorting", () => {
  it("sorts duration both ways while keeping missing duration last", () => {
    const rows = [trace({trace_id:"slow", input_summary:"Slow trace", latency_ms:900}), trace({trace_id:"missing", input_summary:"Missing trace", latency_ms:null}), trace({trace_id:"fast", input_summary:"Fast trace", latency_ms:100})];
    for (const sort of ["duration", "duration-asc"]) {
      const html = renderToStaticMarkup(createElement(TraceTable, { traces:rows, projectId:"proj-1", sort, onSort:()=>{} }));
      const first = sort === "duration" ? "Slow trace" : "Fast trace";
      const second = sort === "duration" ? "Fast trace" : "Slow trace";
      expect(html.indexOf(first)).toBeLessThan(html.indexOf(second));
      expect(html.indexOf(second)).toBeLessThan(html.indexOf("Missing trace"));
      expect(html).toContain(`aria-sort="${sort === "duration" ? "descending" : "ascending"}"`);
      expect(html).not.toContain("<select");
    }
  });
});
