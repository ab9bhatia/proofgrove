/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvaluationRunGroups, GroupingSelect, useTracingGrouping } from "@/components/tracing/evaluation-run-groups";
import type { TracingGroupingIdentity } from "@/components/tracing/trace-workspace";

const items = [
  { evaluation_name: "Support quality", run_id: "run-001" },
  { evaluation_name: "Support quality", run_id: "run-002" },
  { evaluation_name: null, run_id: null },
];
function View() {
  const [grouping, setGrouping] = useTracingGrouping();
  return createElement("div", null, createElement("div", { role: "group", "aria-label": "List controls" }, createElement(GroupingSelect, { value: grouping, onChange: setGrouping })), createElement(EvaluationRunGroups, {
    grouping,
    items, itemNoun: "trace",
    renderItems: (rows: TracingGroupingIdentity[]) => createElement("table", null,
      createElement("tbody", null, rows.map((item, i) => createElement("tr", { key: i }, createElement("td", null, item.run_id || "Unlinked trace"))))),
  }));
}
beforeEach(() => {
  const saved = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  } });
});
afterEach(cleanup);

describe("optional tracing grouping", () => {
  it("defaults to one flat table and keeps every row when changing grouping", () => {
    const { container } = render(createElement(View));
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(container.querySelectorAll("details")).toHaveLength(0);
    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: "evaluation" } });
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Support quality" })).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(3);
    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: "run" } });
    expect(screen.getAllByRole("table")).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "Not linked to a run" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: "none" } });
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("restores the grouping choice on returning to tracing", async () => {
    const first = render(createElement(View));
    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: "run" } });
    first.unmount();
    render(createElement(View));
    await waitFor(() => expect(screen.getAllByRole("table")).toHaveLength(3));
  });
});
