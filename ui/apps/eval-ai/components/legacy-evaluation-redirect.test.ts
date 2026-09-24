import { describe, expect, it } from "vitest";

import { mapLegacyEvaluationPath } from "./legacy-evaluation-redirect";

describe("mapLegacyEvaluationPath", () => {
  it("maps a legacy compare route to the canonical evaluations compare route, preserving query params", () => {
    expect(mapLegacyEvaluationPath("/experiments/abc/compare", "tab=samples")).toBe(
      "/evaluations/abc/compare?tab=samples",
    );
  });

  it("accepts a leading question mark on the search string", () => {
    expect(mapLegacyEvaluationPath("/experiments/abc/compare", "?tab=samples")).toBe(
      "/evaluations/abc/compare?tab=samples",
    );
  });

  it("maps a legacy experiment detail route to the canonical evaluation detail route", () => {
    expect(mapLegacyEvaluationPath("/experiments/exp-1")).toBe("/evaluations/exp-1");
  });

  it("maps the legacy experiments library to the comparison view", () => {
    expect(mapLegacyEvaluationPath("/experiments")).toBe("/evaluations?tab=experiments");
  });

  it("maps the legacy compare library to the comparison view and keeps existing params", () => {
    expect(mapLegacyEvaluationPath("/compare", "page=2")).toBe(
      "/evaluations?page=2&tab=experiments",
    );
  });
});
