import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { ReportView } from "@/components/report/view";
import {
  ReleaseDecisionPanel,
  shouldOfferReleaseDecision,
} from "@/components/report/governance";
import { UIStateProvider } from "@/components/ui-state";
import type { PlatformCapabilities, RunResult } from "@/lib/api";

function makeRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    run_id: "run-1",
    status: "completed",
    experiment: {
      experiment_id: "experiment-1",
      name: "Fraud Agent Suite",
      dataset_version: "ds_demo",
      target_endpoint: "https://example.test/agent",
      scenario: "agentic",
      market: "global",
      judge_model: "gpt-4o",
      judge_temperature: 0,
      has_ground_truth: true,
    },
    metric_results: [],
    kpi_results: [],
    verdict_status: "conclusive",
    overall_gate: "pass",
    diagnostic_only: false,
    evidence_capture_status: "complete",
    evidence_categories: [],
    root_cause: null,
    review_queue: [],
    active_metrics: [],
    started_at: "2026-08-03T00:00:00Z",
    completed_at: "2026-08-03T00:01:00Z",
    ...overrides,
  };
}

const governedRun = makeRun({
  quality_profile_id: "profile-1",
  quality_profile_version: "1.0.0",
  gate_policy_id: "gate-1",
  gate_policy_version: "1.0.0",
  release_eligibility: { status: "eligible", code: null, message: null },
});

const ungovernedRun = makeRun({
  quality_profile_id: null,
  gate_policy_id: null,
});

const granted: PlatformCapabilities = { actions: { record_release_decision: true } };
const denied: PlatformCapabilities = { actions: { record_release_decision: false } };

describe("shouldOfferReleaseDecision", () => {
  it("offers the affordance only for an eligible governed run with the granted capability", () => {
    expect(shouldOfferReleaseDecision(governedRun, granted)).toBe(true);
  });

  it("never offers it when eligibility is missing", () => {
    expect(
      shouldOfferReleaseDecision(
        makeRun({
          quality_profile_id: "profile-1",
          gate_policy_id: "gate-1",
          release_eligibility: null,
        }),
        granted,
      ),
    ).toBe(false);
  });

  it("never offers it when the capability is denied", () => {
    expect(shouldOfferReleaseDecision(governedRun, denied)).toBe(false);
  });

  it("never offers it while the capability answer is unresolved", () => {
    expect(shouldOfferReleaseDecision(governedRun, null)).toBe(false);
    expect(shouldOfferReleaseDecision(governedRun, { actions: {} })).toBe(false);
  });

  it("never offers it for an ungoverned run, even with the capability", () => {
    expect(shouldOfferReleaseDecision(ungovernedRun, granted)).toBe(false);
  });

  it("never offers it when backend eligibility says ineligible", () => {
    expect(
      shouldOfferReleaseDecision(
        makeRun({
          ...governedRun,
          release_eligibility: {
            status: "ineligible",
            code: "gate_outcome_blocks_release",
            message: "Gate is warn",
          },
        }),
        granted,
      ),
    ).toBe(false);
  });

  it("offers it when backend eligibility says eligible", () => {
    expect(
      shouldOfferReleaseDecision(
        makeRun({
          ...governedRun,
          release_eligibility: { status: "eligible", code: null, message: null },
        }),
        granted,
      ),
    ).toBe(true);
  });
});

describe("ReportView release decision gating", () => {
  it("hides the release UI while the capability has not been granted", () => {
    // Static render never resolves the capability fetch, mirroring a caller
    // whose capability is absent: the panel must not exist in the markup.
    const html = renderToStaticMarkup(createElement(ReportView, { run: governedRun }));
    expect(html).not.toContain("Release decision");
    expect(html).not.toContain("Record decision");
  });

  it("never mounts the release UI for an ungoverned run", () => {
    const html = renderToStaticMarkup(createElement(ReportView, { run: ungovernedRun }));
    expect(html).not.toContain("Release decision");
  });
});

describe("ReleaseDecisionPanel", () => {
  it("renders decision and rationale controls for a governed, capability-granted run", () => {
    const html = renderToStaticMarkup(
      createElement(
        UIStateProvider,
        null,
        createElement(ReleaseDecisionPanel, { run: governedRun }),
      ),
    );
    expect(html).toContain("Release decision");
    expect(html).toContain("Approve for release");
    expect(html).toContain("Approve with exception");
    expect(html).toContain("Reject");
    expect(html).toContain("Rationale");
    expect(html).toContain("Record decision");
  });

  // `fullName` falls back to the literal string "User" when gateway identity
  // does not resolve, and this panel calls its own output an audited history —
  // so an unconfirmed identity must not be able to sign a release decision.
  it("refuses to let an unconfirmed identity sign a release decision", () => {
    const html = renderToStaticMarkup(
      createElement(
        UIStateProvider,
        null,
        createElement(ReleaseDecisionPanel, { run: governedRun }),
      ),
    );
    expect(html).toContain("Your identity could not be confirmed");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Record decision<\/button>/);
  });

  it("renders nothing without an experiment to attach the decision to", () => {
    const html = renderToStaticMarkup(
      createElement(
        UIStateProvider,
        null,
        createElement(ReleaseDecisionPanel, {
          run: makeRun({ experiment: undefined, gate_policy_id: "gate-1" }),
        }),
      ),
    );
    expect(html).toBe("");
  });
});
