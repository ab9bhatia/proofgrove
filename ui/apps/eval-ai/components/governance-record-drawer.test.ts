/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GovernanceRecordDrawer } from "./governance-record-drawer";
import type { QualityProfileVersion, ReleaseGatePolicyVersion } from "@/lib/api";

const profile: QualityProfileVersion = {
  profile_id: "task-completion", version: "1.0.0", tenant_id: "tenant-classroom",
  project_id: "project-1", name: "Task Completion",
  description: "Checks whether the requested task was completed.", status: "approved",
  scenario: "agentic", metric_ids: ["quality.task_completion", "agent.tool_correctness"],
  evidence_requirements: ["final_output"], hard_blocker_metric_ids: ["quality.task_completion"],
  approver_roles: ["eval-hub-approver"], test_status: "tested",
  tested_at: "2026-09-03T10:00:00Z", tested_by: "quality@example.com", test_note: "Dry-run passed.",
};
const policy: ReleaseGatePolicyVersion = {
  gate_policy_id: "production-release", version: "1.0.0", tenant_id: "tenant-classroom",
  name: "Production release", description: "Blocks release when critical quality checks fail.",
  status: "validated", required_evidence: ["final_output", "tool_calls"],
  required_approver_roles: ["release-approver"], hard_blocker_metric_ids: ["quality.task_completion"],
};

function drawer(
  record: { profile: QualityProfileVersion; policy: null } | { profile: null; policy: ReleaseGatePolicyVersion },
  onClose: () => void = vi.fn(),
  props: Partial<Parameters<typeof GovernanceRecordDrawer>[0]> = {},
) {
  const selection = record.profile
    ? { kind: "profile" as const, id: record.profile.profile_id, version: record.profile.version }
    : { kind: "policy" as const, id: record.policy.gate_policy_id, version: record.policy.version };
  return createElement(GovernanceRecordDrawer, {
    selection, ...record, canAuthor: true, onClose,
    onLifecycleAction: vi.fn(), onMarkTested: vi.fn(), onCopyId: vi.fn(),
    ...props,
  });
}

afterEach(cleanup);

describe("GovernanceRecordDrawer", () => {
  it("shows complete Profile details and technical IDs", () => {
    render(drawer({ profile, policy: null }));
    expect(screen.getByRole("dialog", { name: "Task Completion" })).toBeTruthy();
    expect(screen.getByText("Project project-1")).toBeTruthy();
    expect(screen.getByText("Required evidence")).toBeTruthy();
    expect(screen.getAllByText("quality.task_completion")).toHaveLength(2);
    expect(screen.getByText("Dry-run passed.")).toBeTruthy();
    expect(screen.getByText("quality@example.com")).toBeTruthy();
    expect(screen.getByText("Technical details")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retire Task Completion" })).toBeTruthy();
  });

  it("shows Policy rules, blockers, evidence, approvers, and scope", () => {
    render(drawer({ profile: null, policy }));
    expect(screen.getByRole("dialog", { name: "Production release" })).toBeTruthy();
    expect(screen.getByText("All Projects")).toBeTruthy();
    expect(screen.getByText("Blocker metrics")).toBeTruthy();
    expect(screen.getByText("tool_calls")).toBeTruthy();
    expect(screen.getByText("release-approver")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve Production release" })).toBeTruthy();
  });

  it("closes on Escape and restores focus", async () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(drawer({ profile, policy: null }, onClose));
    await waitFor(() => expect(document.activeElement?.textContent).toContain("Task Completion"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("focuses a stable fallback when the originating row no longer exists", async () => {
    const opener = document.createElement("button");
    const fallback = document.createElement("a");
    fallback.href = "#profiles";
    document.body.append(opener, fallback);
    opener.focus();
    let view: ReturnType<typeof render>;
    view = render(drawer(
      { profile, policy: null },
      () => view.unmount(),
      { fallbackFocusRef: { current: fallback } },
    ));
    await waitFor(() => expect(document.activeElement?.textContent).toContain("Task Completion"));
    opener.remove();
    fireEvent.click(screen.getAllByRole("button", { name: "Close Task Completion" })[1]);
    await waitFor(() => expect(document.activeElement).toBe(fallback));
    fallback.remove();
  });

  it("announces action success and failure inside the drawer", () => {
    const view = render(drawer(
      { profile, policy: null },
      vi.fn(),
      { successMessage: "Task Completion was approved." },
    ));
    expect(screen.getByRole("status").textContent).toBe("Task Completion was approved.");

    view.rerender(drawer(
      { profile, policy: null },
      vi.fn(),
      { errorMessage: "Approval failed." },
    ));
    expect(screen.getByRole("alert").textContent).toBe("Approval failed.");
  });

  it("opens and focuses actual technical details from the overflow", async () => {
    render(drawer({ profile, policy: null }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Task Completion" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Technical details" }));

    const summary = screen.getByText("Technical details");
    expect((summary.parentElement as HTMLDetailsElement).open).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(summary));
  });
});
