import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ContractPoliciesPanel } from "./contract-policies-panel";
import { ContractProfilesPanel } from "./contract-profiles-panel";
import { ContractProjectsPanel } from "./contract-projects-panel";
import { ContractTargetsPanel } from "./contract-targets-panel";

const common = {
  selectedProfileKey: "",
  selectedPolicyKey: "",
  selectedProjectId: "",
  selectedTargetVersionId: "",
  onSelect: vi.fn(),
};

describe("Assignment selection panels", () => {
  it("keeps Profile and Policy panels selection-only with management links", () => {
    const profiles = renderToStaticMarkup(createElement(ContractProfilesPanel, {
      profiles: [],
      selectedProfileKey: common.selectedProfileKey,
      onSelect: common.onSelect,
      loadState: "ready",
    }));
    const policies = renderToStaticMarkup(createElement(ContractPoliciesPanel, {
      policies: [],
      mode: "none",
      selectedPolicyKey: common.selectedPolicyKey,
      onModeChange: vi.fn(),
      onSelect: common.onSelect,
      loadState: "ready",
    }));

    expect(profiles).toContain('href="/contracts?tab=profiles"');
    expect(policies).toContain('href="/contracts?tab=policies"');
    for (const action of ["Mark tested", "Override", ">Validate<", ">Approve<", ">Retire<", "Save draft"]) {
      expect(profiles).not.toContain(action);
      expect(policies).not.toContain(action);
    }
  });

  it("shows retry guidance instead of creation guidance for failed catalogues", () => {
    const projects = renderToStaticMarkup(createElement(ContractProjectsPanel, {
      projects: [],
      selectedProjectId: common.selectedProjectId,
      createOpen: false,
      onSelect: common.onSelect,
      onCreateOpenChange: vi.fn(),
      onSubmit: vi.fn(),
      loadState: "error",
    }));
    const targets = renderToStaticMarkup(createElement(ContractTargetsPanel, {
      project: null,
      targets: [],
      catalogAgents: [],
      customOpen: false,
      selectedTargetVersionId: common.selectedTargetVersionId,
      onSelect: common.onSelect,
      onAddAgent: vi.fn(),
      onCustomOpenChange: vi.fn(),
      onSubmit: vi.fn(),
      loadState: "error",
    }));

    expect(projects).toContain("could not be loaded");
    expect(targets).toContain("could not be loaded");
    expect(projects).toContain("Refresh");
    expect(targets).toContain("Refresh");
    expect(projects).not.toContain("No projects yet");
    expect(targets).not.toContain("No registered targets yet");
  });
});
