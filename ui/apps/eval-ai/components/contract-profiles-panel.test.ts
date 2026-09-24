/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContractProfilesPanel } from "./contract-profiles-panel";

const approvedProfile = {
  profile_id: "approved-agent-quality",
  version: "1.0.0",
  tenant_id: "tenant-classroom",
  project_id: "project-1",
  name: "Approved agent quality",
  status: "approved" as const,
  scenario: "agentic" as const,
  metric_ids: ["quality.task_completion", "agent.tool_correctness"],
  evidence_requirements: ["input", "final_output"],
  hard_blocker_metric_ids: [],
  approver_roles: [],
};

afterEach(cleanup);

describe("ContractProfilesPanel", () => {
  it("is an approved Profile selection surface with a management link", () => {
    const html = renderToStaticMarkup(createElement(ContractProfilesPanel, {
      profiles: [approvedProfile],
      selectedProfileKey: "approved-agent-quality@1.0.0",
      onSelect: vi.fn(),
    }));

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('checked=""');
    expect(html).toContain("Approved agent quality");
    expect(html).toContain("2 metrics · 2 evidence");
    expect(html).toContain('href="/contracts?tab=profiles"');
    expect(html).not.toContain(">Validate<");
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Retire<");
    expect(html).not.toContain("Mark tested");
    expect(html).not.toContain("Save draft");
  });

  it("distinguishes a failed load from an empty compatible catalogue", () => {
    const failed = renderToStaticMarkup(createElement(ContractProfilesPanel, {
      profiles: [],
      selectedProfileKey: "",
      onSelect: vi.fn(),
      loadState: "error",
    }));
    const empty = renderToStaticMarkup(createElement(ContractProfilesPanel, {
      profiles: [],
      selectedProfileKey: "",
      onSelect: vi.fn(),
      loadState: "ready",
    }));

    expect(failed).toContain("could not be loaded");
    expect(failed).toContain("Refresh to retry");
    expect(failed).not.toContain("No approved Quality Profiles");
    expect(empty).toContain("No approved Quality Profiles");
  });

  it("selects from coverage and gives each scope a distinguishable accessible name", () => {
    const onSelect = vi.fn();
    render(createElement(ContractProfilesPanel, {
      profiles: [
        approvedProfile,
        { ...approvedProfile, profile_id: "reusable-agent-quality", project_id: null },
      ],
      selectedProfileKey: "",
      onSelect,
    }));

    fireEvent.click(screen.getAllByText("2 metrics · 2 evidence")[0]!);
    expect(onSelect).toHaveBeenCalledWith("approved-agent-quality@1.0.0");

    expect(screen.getByRole("radio", {
      name: "Approved agent quality, version 1.0.0, approved, scoped to Project project-1",
    })).toBeTruthy();
    expect(screen.getByRole("radio", {
      name: "Approved agent quality, version 1.0.0, approved, reusable across Projects",
    })).toBeTruthy();
  });

  it("says why a Profile is missing rather than silently omitting it", () => {
    render(createElement(ContractProfilesPanel, {
      profiles: [approvedProfile],
      selectedProfileKey: "",
      onSelect: vi.fn(),
      hiddenNote: "2 not yet approved and 1 scoped to a different Project are not shown here.",
    }));
    expect(screen.getByText(/2 not yet approved and 1 scoped to a different Project/)).toBeTruthy();
  });

  it("uses a row-sized focus target and describes why disabled choices are unavailable", () => {
    render(createElement(ContractProfilesPanel, {
      profiles: [approvedProfile],
      selectedProfileKey: "",
      onSelect: vi.fn(),
      actionsDisabled: true,
      disabledReason: "Select an active Project before choosing a Quality Profile.",
    }));

    const radio = screen.getByRole("radio");
    expect(radio.className).toContain("size-full");
    expect(radio.className).not.toContain("sr-only");
    expect(radio.nextElementSibling?.className).toContain("peer-focus-visible:ring-2");
    expect(radio.nextElementSibling?.className).toContain("peer-focus-visible:ring-ring");
    expect(radio.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Select an active Project before choosing a Quality Profile.")).toBeTruthy();
  });
});
