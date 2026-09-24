/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ArchivedTraceSpan } from "@/lib/api";
import { SpanDetailPane } from "./span-detail-pane";
afterEach(cleanup);

it("keeps all attributes searchable and offers JSON without hiding captured input", () => {
  const span = { trace_id: "trace", span_id: "span", name: "agent", attributes: { "openinference.span.kind": "AGENT", "input.value": "Paris?", custom: "needle" }, resource_attributes: {}, events: [{ name: "completed", timeUnixNano: "1789037288406010845" }], parent_span_id: null } as unknown as ArchivedTraceSpan;
  render(createElement(SpanDetailPane, { span, loading: false, error: null, onRetry: vi.fn(), emptyMessage: "Empty", scrollClassName: "" }));
  fireEvent.click(screen.getByRole("tab", { name: "Events 1" }));
  expect(screen.getByRole("tabpanel", { name: "Events 1" }).textContent).toContain("2026");
  fireEvent.click(screen.getByRole("tab", { name: "Attributes" }));
  expect(screen.getByRole("table", { name: "Span attributes" }).textContent).toContain("input.value");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search attributes" }), { target: { value: "needle" } });
  expect(screen.getByRole("table", { name: "Span attributes" }).textContent).not.toContain("input.value");
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  expect(screen.getByRole("region", { name: "Matching attributes" }).textContent).toContain('"custom": "needle"');
  fireEvent.change(screen.getByRole("searchbox", { name: "Search attributes" }), { target: { value: "missing" } });
  expect(screen.getByText("No matching attributes.")).toBeTruthy();
});
