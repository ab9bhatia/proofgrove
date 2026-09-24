import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  canRunDatasetValidation,
  DatasetValidationEmptyState,
} from "./dataset-validation-empty-state";

describe("DatasetValidationEmptyState", () => {
  it("offers validation only for an actual draft version", () => {
    expect(canRunDatasetValidation("DRAFT", "DRAFT")).toBe(true);
    expect(canRunDatasetValidation("RETIRED", "RETIRED")).toBe(false);

    const html = renderToStaticMarkup(
      createElement(DatasetValidationEmptyState, {
        apiStatus: "DRAFT",
        displayStatus: "DRAFT",
        actionLoading: null,
        onValidate: () => undefined,
      }),
    );

    expect(html).toContain("Run validation");
  });

  it("explains the retired terminal state without rendering an invalid action", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetValidationEmptyState, {
        apiStatus: "RETIRED",
        displayStatus: "RETIRED",
        actionLoading: null,
        onValidate: () => undefined,
      }),
    );

    expect(html).toContain("Validation unavailable");
    expect(html).toContain("Retired versions cannot be validated");
    expect(html).toContain("Restore this dataset as an editable draft");
    expect(html).not.toContain("Run validation");
    expect(html).not.toContain("<button");
  });
});
