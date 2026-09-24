import { describe, expect, it } from "vitest";

import { governanceTabHref, readGovernanceTab } from "@/lib/governance-tabs";

describe("governance catalogue tabs", () => {
  it("opens Assignments by default", () => {
    expect(readGovernanceTab(new URLSearchParams())).toBe("assignments");
  });

  it("restores a supported catalogue from the URL", () => {
    expect(readGovernanceTab(new URLSearchParams("tab=profiles"))).toBe("profiles");
    expect(readGovernanceTab(new URLSearchParams("tab=policies"))).toBe("policies");
    expect(readGovernanceTab(new URLSearchParams("tab=assignments"))).toBe("assignments");
  });

  it("falls back to Assignments for unknown values", () => {
    expect(readGovernanceTab(new URLSearchParams("tab=unknown"))).toBe("assignments");
  });

  it("creates stable catalogue links", () => {
    expect(governanceTabHref("profiles")).toBe("/contracts?tab=profiles");
    expect(governanceTabHref("policies")).toBe("/contracts?tab=policies");
    expect(governanceTabHref("assignments")).toBe("/contracts?tab=assignments");
  });
});
