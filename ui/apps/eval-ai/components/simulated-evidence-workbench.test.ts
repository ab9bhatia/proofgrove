import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  SIMULATED_EVIDENCE_CASES,
  SimulatedEvidenceWorkbench,
  evidencePreviewSearch,
} from "@/components/simulated-evidence-workbench";

describe("SimulatedEvidenceWorkbench", () => {
  it("keeps the prototype boundary explicit and starts with the reviewer workflow", () => {
    const html = renderToStaticMarkup(
      createElement(SimulatedEvidenceWorkbench, { config: { enabled: true } }),
    );

    expect(html).toContain("Demo trace");
    expect(html).toContain("This data was not captured from a running application");
    expect(html).toContain("does not calculate a real verdict or release gate");
    expect(html).toContain("Customer verification");
    expect(html).toContain("Missing evidence");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain("Execution thread");
    expect(html).toContain("Tool called; result not captured");
    expect(html).toContain("Step details");
    expect(html).toContain("never submitted to evidence APIs");
    expect(html).not.toContain('role="dialog"');
  });

  it("shows an honest unavailable-trace state without inferring trace identity", () => {
    const html = renderToStaticMarkup(
      createElement(SimulatedEvidenceWorkbench, {
        config: { enabled: true, caseId: "case-008", view: "trace" },
      }),
    );

    expect(html).toContain("Trace not required for this case");
    expect(html).toContain("No trace identity was recorded");
    expect(html).toContain("none is inferred");
  });

  it.each([
    ["loading", "Loading prototype evidence…"],
    ["error", "Prototype evidence could not be loaded"],
    ["permission", "Evidence hidden"],
  ])("renders the %s state", (state, message) => {
    const html = renderToStaticMarkup(
      createElement(SimulatedEvidenceWorkbench, {
        config: { enabled: true, state },
      }),
    );

    expect(html).toContain(message);
  });

  it("renders an explicit empty fixture state", () => {
    const html = renderToStaticMarkup(
      createElement(SimulatedEvidenceWorkbench, {
        config: { enabled: true },
        cases: [],
      }),
    );

    expect(html).toContain("No prototype cases");
    expect(html).toContain("Add simulated evidence cases");
  });

  it("preserves unrelated query parameters while deep-linking workbench state", () => {
    const query = evidencePreviewSearch(
      new URLSearchParams("foo=bar&evidencePreview=1"),
      {
        caseId: "case-008",
        filter: "passed",
        view: "scores",
        stepId: "step-evaluation",
      },
    );
    const params = new URLSearchParams(query);

    expect(params.get("foo")).toBe("bar");
    expect(params.get("evidencePreview")).toBe("1");
    expect(params.get("case")).toBe("case-008");
    expect(params.get("filter")).toBe("passed");
    expect(params.get("view")).toBe("scores");
    expect(params.get("step")).toBe("step-evaluation");
  });

  it("covers missing, failed, passed, zero-event, and optional-trace fixtures", () => {
    expect(SIMULATED_EVIDENCE_CASES.map((item) => item.status)).toEqual([
      "missing",
      "attention",
      "passed",
    ]);
    expect(
      SIMULATED_EVIDENCE_CASES.some((item) =>
        item.manifest.some((row) => row.records === "0 · none observed"),
      ),
    ).toBe(true);
    expect(SIMULATED_EVIDENCE_CASES.some((item) => !item.traceAvailable)).toBe(true);
  });

  it("shows a complete failed execution with a linked failure annotation", () => {
    const failed = SIMULATED_EVIDENCE_CASES.find((item) => item.id === "case-021");
    expect(failed?.traceAvailable).toBe(true);
    expect(failed?.steps.map((step) => step.label)).toEqual([
      "Agent invocation",
      "Prompt preparation",
      "Retrieval",
      "Tool call",
      "LLM generation",
      "Final response",
    ]);
    expect(failed?.steps.find((step) => step.id === "failed-generation")?.annotation).toContain(
      "Failure begins here",
    );
    expect(failed?.scores[0].stepId).toBe("failed-generation");
  });
});
