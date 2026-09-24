/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ArchivedTraceSpan, RunItemDetail } from "@/lib/api";
vi.mock("@/components/tracing/span-scoring", () => ({
  SpanScoring: ({ selections }: { selections: { span_id: string }[] }) => createElement("p", null, `Scores for ${selections[0].span_id}`),
}));
import { CaseAnnotationSummary, SelectedAnnotationSummary } from "./case-annotation";
afterEach(cleanup);

it("switches between the exact case target and child annotations, without inheriting scores", () => {
  const item = { execution: { trace_id: "trace", span_id: "root" }, scorer_results: [{ metric_id: "llm.correctness", normalised_score: 1 }] } as RunItemDetail;
  const props = { item, projectId: "project", error: null, onRetry: vi.fn() };
  const span = { trace_id: "trace", span_id: "root", parent_span_id: null } as ArchivedTraceSpan;
  const { rerender } = render(createElement(SelectedAnnotationSummary, { ...props, span }));
  expect(screen.getByText("Whole case")).toBeTruthy();
  expect(screen.getByText("100%")).toBeTruthy();
  rerender(createElement(SelectedAnnotationSummary, { ...props, span: { ...span, span_id: "child", parent_span_id: "root" } }));
  expect(screen.queryByText("100%")).toBeNull();
  expect(screen.getByText("Scores for child")).toBeTruthy();
  rerender(createElement(SelectedAnnotationSummary, { ...props, span: { ...span, trace_id: "other" } }));
  expect(screen.queryByText("Whole case")).toBeNull();
  rerender(createElement(SelectedAnnotationSummary, { ...props, span }));
  expect(screen.getByText("Whole case")).toBeTruthy();
});

it("does not guess a case target when its link is missing, and supports traces without a case", () => {
  const span = { trace_id: "trace", span_id: "root", parent_span_id: null } as ArchivedTraceSpan;
  const props = { span, projectId: "project", error: null, onRetry: vi.fn() };
  const { rerender } = render(createElement(SelectedAnnotationSummary, { ...props, item: null }));
  expect(screen.getByText("Scores for root")).toBeTruthy();
  rerender(createElement(SelectedAnnotationSummary, { ...props, item: { execution: { trace_id: "trace", span_id: null }, scorer_results: [] } as unknown as RunItemDetail }));
  expect(screen.getByText("Scores for root")).toBeTruthy();
});


it("hides unscored metrics but retains zero scores and measured operational values", () => {
  const item = { scorer_results: [
    { metric_id: "llm.correctness", metric_status: "scored", score: 0, normalised_score: 0 },
    { metric_id: "ops.total_token_count", metric_status: "scored", score: 10, normalised_score: null },
    { metric_id: "llm.relevance", metric_status: "unscored", score: null, normalised_score: null },
  ] } as RunItemDetail;
  render(createElement(CaseAnnotationSummary, { item, error: null, onRetry: vi.fn() }));
  expect(screen.getByText("0%")).toBeTruthy();
  expect(screen.getByText("10 tokens")).toBeTruthy();
  const quality = screen.getByRole("button", { name: "correctness: 0%" });
  const measurement = screen.getByRole("button", { name: "total token count: 10 tokens" });
  expect(quality.getAttribute("title")).toBe("LLM quality");
  expect(measurement.getAttribute("title")).toBe("Operational measurements");
  expect(quality.getAttribute("style")).not.toBe(measurement.getAttribute("style"));
  expect(screen.queryByRole("button", { name: /relevance/i })).toBeNull();
});
