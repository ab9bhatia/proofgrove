import { describe, expect, it } from "vitest";

import { evaluationsHref, readEvaluationsTab, writeEvaluationsTab } from "./evaluations-tab";

describe("evaluations tab URL", () => {
  it("defaults to runs and reads tab=experiments", () => {
    expect(readEvaluationsTab(new URLSearchParams(""))).toBe("runs");
    expect(readEvaluationsTab(new URLSearchParams("tab=experiments"))).toBe("experiments");
  });

  it("still accepts legacy view=experiments bookmarks", () => {
    expect(readEvaluationsTab(new URLSearchParams("view=experiments"))).toBe("experiments");
    expect(readEvaluationsTab(new URLSearchParams("view=archived"))).toBe("runs");
  });

  it("prefers tab over legacy view", () => {
    expect(readEvaluationsTab(new URLSearchParams("tab=experiments&view=archived"))).toBe(
      "experiments",
    );
  });

  it("writes tab without clobbering lifecycle and migrates legacy view=experiments", () => {
    const params = new URLSearchParams("lifecycle=archived&view=experiments&q=nightly");
    writeEvaluationsTab(params, "experiments");
    expect(params.get("tab")).toBe("experiments");
    expect(params.get("lifecycle")).toBe("archived");
    expect(params.get("view")).toBeNull();
    expect(params.get("q")).toBe("nightly");

    writeEvaluationsTab(params, "runs");
    expect(params.get("tab")).toBeNull();
    expect(params.get("lifecycle")).toBe("archived");
  });

  it("builds evaluations hrefs", () => {
    expect(evaluationsHref("runs")).toBe("/evaluations");
    expect(evaluationsHref("experiments")).toBe("/evaluations?tab=experiments");
    expect(evaluationsHref("experiments", "lifecycle=archived")).toBe(
      "/evaluations?lifecycle=archived&tab=experiments",
    );
  });
});
