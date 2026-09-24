import { describe, expect, it } from "vitest";

import {
  assignmentDetailsHref,
  assignmentFromSearchParams,
  assignmentPermalinkPath,
  evaluateHrefFromAssignment,
} from "./assignment-links";

describe("assignment catalogue links", () => {
  it("opens Evaluate with explicit Assignment identity and leaves dataset choosable", () => {
    expect(
      evaluateHrefFromAssignment({
        assignmentId: "claims-release",
        version: "1.0.0",
      }),
    ).toBe("/evaluate?assignment=claims-release&assignmentVersion=1.0.0");
  });

  it("preserves an optional dataset when the caller already chose one", () => {
    expect(
      evaluateHrefFromAssignment({
        assignmentId: "claims-release",
        version: "1.0.0",
        dataset: "fraud-cases",
      }),
    ).toBe(
      "/evaluate?assignment=claims-release&assignmentVersion=1.0.0&dataset=fraud-cases",
    );
  });

  it("deep-links Assignment details through the existing setup route", () => {
    expect(assignmentDetailsHref({ runManifestId: "manifest-1" })).toBe(
      "/contracts/new?setup=manifest-1",
    );
    expect(
      assignmentDetailsHref({
        runManifestId: "manifest-1",
        assignmentId: "claims-release",
        version: "1.0.0",
      }),
    ).toBe(
      "/contracts/new?setup=manifest-1&assignment=claims-release&assignmentVersion=1.0.0",
    );
  });

  it("builds a stable catalogue permalink for Copy link", () => {
    expect(
      assignmentPermalinkPath({
        assignmentId: "claims-release",
        version: "1.0.0",
      }),
    ).toBe("/contracts?assignment=claims-release&assignmentVersion=1.0.0");
  });

  it("restores Assignment identity from Evaluate query params without inference", () => {
    expect(
      assignmentFromSearchParams(
        new URLSearchParams("assignment=claims-release&assignmentVersion=1.0.0"),
      ),
    ).toEqual({ assignmentId: "claims-release", assignmentVersion: "1.0.0" });
    expect(assignmentFromSearchParams(new URLSearchParams("assignment=claims-release"))).toBeNull();
    expect(assignmentFromSearchParams(new URLSearchParams(""))).toBeNull();
    expect(
      assignmentFromSearchParams(new URLSearchParams("assignment=claims-release%401.0.0")),
    ).toEqual({ assignmentId: "claims-release", assignmentVersion: "1.0.0" });
  });
});
