import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SpanTable } from "@/components/tracing/span-table";
import type { IndexedSpanSummary } from "@/lib/api";

const span: IndexedSpanSummary = {
  project_id: "project 1",
  trace_id: "trace/1",
  run_id: "run/1",
  run_name: "Baseline",
  run_number: 1,
  evaluation_name: "Support quality",
  span_id: "span/1",
  parent_span_id: null,
  name: "agent.run",
  kind: "llm",
  semantic_kind: "llm",
  input_preview: null,
  output_preview: null,
  llm_token_count_prompt: null,
  llm_token_count_completion: null,
  estimated_cost_usd: null,
  started_at: "2026-08-01T10:00:00Z",
  duration_ms: 12.5,
  status: "ok",
};

describe("span table drawer navigation", () => {
  it("gives the row a real same-page trace and span URL", () => {
    const html = renderToStaticMarkup(
      createElement(SpanTable, {
        spans: [span],
        projectId: "project 1",
        currentQuery: "status=error",
      }),
    );
    const href = "/projects/project%201/spans?status=error&amp;trace=trace%2F1&amp;span=span%2F1";

    expect(html).toContain(`data-href="${href}"`);
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain("cursor-pointer");
  });

  it("gives the row the same trailing-arrow affordance as TraceTable", () => {
    const html = renderToStaticMarkup(
      createElement(SpanTable, {
        spans: [span],
        projectId: "project 1",
      }),
    );
    const href = "/projects/project%201/spans?trace=trace%2F1&amp;span=span%2F1";

    // Both the trace-id link and the trailing arrow link point at the span.
    const hrefCount = html.split(`href="${href}"`).length - 1;
    expect(hrefCount).toBeGreaterThanOrEqual(2);
    expect(html).toContain(`aria-label="Open span span/1"`);
    const arrowLink = html.slice(html.indexOf('aria-label="Open span'));
    expect(arrowLink).toContain("focus-visible:ring-2");
  });

  it("shows a friendly name without discarding the stored name", () => {
    const fullName = "openinference.instrumentation.langchain.chain.invoke";
    const html = renderToStaticMarkup(createElement(SpanTable, {
      spans: [{ ...span, name: fullName }],
      projectId: "project 1",
    }));

    expect(html).toContain("openinference.…chain.invoke");
    expect(html).toContain(`title="${fullName}"`);
  });
});

describe("span table shows what each span was given and produced", () => {
  it("renders input and output previews, clamped with the full text available", () => {
    const html = renderToStaticMarkup(
      createElement(SpanTable, {
        spans: [
          {
            ...span,
            input_preview: "what is the capital?",
            output_preview: "Abu Dhabi",
          },
        ],
        projectId: "project 1",
      }),
    );

    expect(html).toContain("what is the capital?");
    expect(html).toContain("Abu Dhabi");
    expect(html).toContain("line-clamp-2");
    // Without max-w-0 the cell grows to its content and the clamp never binds.
    expect(html).toContain("max-w-0");
    expect(html).toContain('title="what is the capital?"');
  });

  it("renders prompt and completion token counts", () => {
    const html = renderToStaticMarkup(
      createElement(SpanTable, {
        spans: [{ ...span, llm_token_count_prompt: 1591, llm_token_count_completion: 179 }],
        projectId: "project 1",
      }),
    );

    expect(html).toContain("1591");
    expect(html).toContain("179");
    // The separator is decorative, so the counts must also be named in text.
    expect(html).toContain("prompt");
    expect(html).toContain("completion");
  });

  it("says nothing was recorded rather than showing a zero", () => {
    const html = renderToStaticMarkup(
      createElement(SpanTable, {
        spans: [{ ...span, llm_token_count_prompt: null, llm_token_count_completion: null }],
        projectId: "project 1",
      }),
    );

    // Asserting on the cell's own title: an em dash appears in the empty
    // preview cells too, so a bare "contains —" passed with the token cell
    // deleted entirely.
    // Asserting on the token cell itself: an em dash appears in the empty
    // preview cells too, so a bare "contains —" passed with the token cell
    // deleted entirely.
    expect(html).toContain('<span title="Not recorded">—</span>');
  });

  it("formats duration with the shared formatter and right-aligns numeric cells", () => {
    const html = renderToStaticMarkup(
      createElement(SpanTable, {
        spans: [{ ...span, duration_ms: 1240 }],
        projectId: "project 1",
      }),
    );

    // Same formatter as every other duration in the app: no bespoke "ms" math.
    expect(html).toContain("1.2s");
    expect(html).toMatch(/class="px-4 py-3 text-right tabular-nums text-foreground">1\.2s/);
  });

  it("renders estimated span cost", () => {
    const html = renderToStaticMarkup(
      createElement(SpanTable, {
        spans: [{ ...span, estimated_cost_usd: 0.75 }],
        projectId: "project 1",
      }),
    );
    expect(html).toContain("$0.75");
  });

  it("labels the row by what the span did, not how it travelled", () => {
    const html = renderToStaticMarkup(
      createElement(SpanTable, {
        spans: [{ ...span, kind: "client", semantic_kind: "llm" }],
        projectId: "project 1",
      }),
    );

    expect(html).toContain("llm");
    expect(html).not.toContain("client");
  });
});
