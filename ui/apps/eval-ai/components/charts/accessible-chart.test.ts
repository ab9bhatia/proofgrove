import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccessibleChartFrame } from "@/components/charts/accessible-chart";

const props = {
  title: "Overall score trend",
  summary: "Two comparable runs: run A 82%, run B 65%.",
  columns: ["Run", "Score", "Gate"],
  rows: [
    { key: "run-a", values: ["Run A", "82%", "Pass"] },
    { key: "run-b", values: ["Run B", "65%", "Warn"] },
  ],
};

describe("AccessibleChartFrame", () => {
  it("renders a semantic table-equivalent of the same data", () => {
    const html = renderToStaticMarkup(createElement(AccessibleChartFrame, props));
    expect(html).toMatch(/<table/);
    expect(html).toMatch(/<caption[^>]*>Overall score trend/);
    expect(html).toMatch(/<th[^>]*scope="col"[^>]*>Run<\/th>/);
    expect(html).toContain("Run A");
    expect(html).toContain("82%");
    expect(html).toContain("Warn");
  });

  it("exposes each data point as a table row without adding redundant tab stops", () => {
    const html = renderToStaticMarkup(createElement(AccessibleChartFrame, props));
    // Native table semantics carry the data; rows must not be focusable.
    expect(html).not.toContain('tabindex="0"');
    const bodyRows = html.match(/<tr[^>]*>\s*<td/g) ?? [];
    expect(bodyRows.length).toBe(props.rows.length);
  });

  it("provides a text summary wired to the figure for assistive tech", () => {
    const html = renderToStaticMarkup(createElement(AccessibleChartFrame, props));
    expect(html).toContain("Two comparable runs");
    expect(html).toMatch(/role="group"/);
    expect(html).toMatch(/aria-describedby=/);
  });

  it("renders the same accessible scaffolding even with no data points", () => {
    const html = renderToStaticMarkup(
      createElement(AccessibleChartFrame, { ...props, rows: [], summary: "No comparable runs yet." }),
    );
    expect(html).toMatch(/<table/);
    expect(html).toContain("No comparable runs yet.");
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(0);
  });
});
