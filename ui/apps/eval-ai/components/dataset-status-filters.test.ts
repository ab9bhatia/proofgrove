import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DATASET_STATUS_FILTERS, DatasetStatusFilters } from "./dataset-status-filters";

describe("DatasetStatusFilters", () => {
  it("exposes all seven dataset lifecycle statuses", () => {
    const values = DATASET_STATUS_FILTERS.map((option) => option.value);
    expect(values).toEqual(["", "DRAFT", "VALIDATED", "APPROVED", "PUBLISHED", "DEPRECATED", "RETIRED", "REJECTED"]);
  });

  it("splits Active vs Retired, matching the Evaluations lifecycle control", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetStatusFilters, {
        status: "",
        counts: { DRAFT: 2, PUBLISHED: 13, REJECTED: 1, RETIRED: 101 },
        // Given, not derived: a lineage with versions in two states belongs to
        // one bucket, so Active is not "everything minus retired".
        activeCount: 16,
        retiredCount: 101,
        onStatusChange: () => undefined,
      }),
    );

    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Dataset lifecycle"');
    expect(html).toContain("Active (16)");
    expect(html).toContain("Retired (101)");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Active/);
  });

  it("marks the Retired tab pressed once a retired status is selected", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetStatusFilters, {
        status: "RETIRED",
        counts: { DRAFT: 2, PUBLISHED: 13, RETIRED: 101 },
        activeCount: 1,
        retiredCount: 1,
        onStatusChange: () => undefined,
      }),
    );

    expect(html).toMatch(/aria-pressed="true"[^>]*>Retired/);
  });

  it("only offers non-zero statuses within the active bucket, never Retired", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetStatusFilters, {
        status: "",
        counts: { DRAFT: 2, VALIDATED: 0, PUBLISHED: 13, REJECTED: 1, RETIRED: 101 },
        activeCount: 1,
        retiredCount: 1,
        onStatusChange: () => undefined,
      }),
    );

    expect(html).toContain("Draft (2)");
    expect(html).toContain("Published (13)");
    expect(html).toContain("Rejected (1)");
    expect(html).not.toContain("Validated");
    // Retired lives in its own tab, not the active-bucket dropdown.
    expect(html).not.toContain('value="RETIRED"');
  });

  it("disables the status dropdown once the Retired tab is selected", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetStatusFilters, {
        status: "RETIRED",
        counts: { PUBLISHED: 13, RETIRED: 101 },
        activeCount: 1,
        retiredCount: 1,
        onStatusChange: () => undefined,
      }),
    );

    expect(html).toMatch(/<select[^>]*disabled/);
  });
});
