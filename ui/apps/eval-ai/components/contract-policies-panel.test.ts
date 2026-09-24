/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContractPoliciesPanel } from "./contract-policies-panel";

const approvedPolicy = {
  gate_policy_id: "approved-release-gate",
  version: "1.0.0",
  tenant_id: "tenant-classroom",
  name: "Approved release gate",
  status: "approved" as const,
  required_evidence: ["row_evidence", "run_summary"],
  required_approver_roles: ["evaluation-owner"],
  hard_blocker_metric_ids: ["safety.toxicity"],
};

afterEach(cleanup);

describe("ContractPoliciesPanel", () => {
  it("defaults to a clear standardized evaluation choice", () => {
    const html = renderToStaticMarkup(createElement(ContractPoliciesPanel, {
      policies: [approvedPolicy],
      mode: "none",
      selectedPolicyKey: "",
      onModeChange: vi.fn(),
      onSelect: vi.fn(),
    }));

    expect(html).toContain(">None<");
    expect(html).toContain("Standardized evaluation");
    expect(html).toContain('checked=""');
    expect(html).not.toContain("Approved release gate");
  });

  it("is an approved Policy selection surface with a management link", () => {
    const html = renderToStaticMarkup(createElement(ContractPoliciesPanel, {
      policies: [approvedPolicy],
      mode: "configured",
      selectedPolicyKey: "approved-release-gate@1.0.0",
      onModeChange: vi.fn(),
      onSelect: vi.fn(),
    }));

    expect(html).toContain('aria-label="Selected Gate Policy"');
    expect(html).toContain("Approved release gate");
    expect(html).toContain('href="/contracts?tab=policies"');
    expect(html).not.toContain(">Validate<");
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Retire<");
    expect(html).not.toContain("Create draft");
  });

  it("shows a Policy load failure even while None is selected", () => {
    const html = renderToStaticMarkup(createElement(ContractPoliciesPanel, {
      policies: [],
      mode: "none",
      selectedPolicyKey: "",
      onModeChange: vi.fn(),
      onSelect: vi.fn(),
      loadState: "error",
    }));

    expect(html).toContain("Gate Policies could not be loaded");
    expect(html).toContain("Refresh to retry");
    expect(html).toContain("disabled");
    expect(html).not.toContain("No approved Gate Policies");
  });

  it("uses full-row native radios for mode and Policy selection", () => {
    const onModeChange = vi.fn();
    const onSelect = vi.fn();
    render(createElement(ContractPoliciesPanel, {
      policies: [approvedPolicy],
      mode: "configured",
      selectedPolicyKey: "",
      onModeChange,
      onSelect,
    }));

    fireEvent.click(screen.getByText("Standardized evaluation: comparable scoring without release governance."));
    expect(onModeChange).toHaveBeenCalledWith("none");

    fireEvent.click(screen.getByText("2 evidence · 1 approvers · 1 blockers"));
    expect(onSelect).toHaveBeenCalledWith("approved-release-gate@1.0.0");

    for (const radio of screen.getAllByRole("radio")) {
      expect(radio.className).toContain("size-full");
      expect(radio.className).not.toContain("sr-only");
      expect(radio.nextElementSibling?.className).toContain("peer-focus-visible:ring-2");
    }
  });
});
