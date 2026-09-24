/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GovernanceRowActions, policyPrimaryAction, profilePrimaryAction } from "./governance-row-actions";
import type { QualityProfileVersion, ReleaseGatePolicyVersion } from "@/lib/api";

const profile: QualityProfileVersion = {
  profile_id: "task-completion", version: "1.0.0", tenant_id: "tenant-classroom",
  project_id: "project-1", name: "Task Completion", status: "draft",
  metric_ids: ["quality.task_completion"], evidence_requirements: ["final_output"],
  hard_blocker_metric_ids: ["quality.task_completion"], approver_roles: ["eval-hub-approver"],
  test_status: "not_tested",
};
const policy: ReleaseGatePolicyVersion = {
  gate_policy_id: "production-release", version: "1.0.0", tenant_id: "tenant-classroom",
  name: "Production release", status: "draft", required_evidence: ["final_output"],
  required_approver_roles: ["release-approver"], hard_blocker_metric_ids: ["quality.task_completion"],
};

afterEach(async () => {
  // Radix restores focus on a timer; flush it before the next test mounts a menu.
  await act(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("governance primary actions", () => {
  it("selects the single next Profile action", () => {
    expect(profilePrimaryAction(profile)).toBe("mark-tested");
    expect(profilePrimaryAction({ ...profile, test_status: "tested" })).toBe("validate");
    expect(profilePrimaryAction({ ...profile, test_status: "overridden" })).toBe("validate");
    expect(profilePrimaryAction({ ...profile, status: "validated" })).toBe("mark-tested");
    expect(profilePrimaryAction({ ...profile, status: "validated", test_status: "tested" })).toBe("approve");
    expect(profilePrimaryAction({ ...profile, status: "approved" })).toBe("retire");
    // Retirement is reversible now: a retired version offers Reinstate, which
    // returns it to draft rather than restoring release authority directly.
    expect(profilePrimaryAction({ ...profile, status: "retired" })).toBe("reinstate");
  });

  it("selects the analogous Policy action", () => {
    expect(policyPrimaryAction(policy)).toBe("validate");
    expect(policyPrimaryAction({ ...policy, status: "validated" })).toBe("approve");
    expect(policyPrimaryAction({ ...policy, status: "approved" })).toBe("retire");
    expect(policyPrimaryAction({ ...policy, status: "retired" })).toBe("reinstate");
  });
});

describe("GovernanceRowActions", () => {
  it("allows Escape and Tab to propagate to the shared dialog", () => {
    const onKeyDown = vi.fn();
    render(createElement(
      "div",
      { onKeyDown },
      createElement(GovernanceRowActions, {
        record: { kind: "profile", value: profile }, onLifecycleAction: vi.fn(),
        onMarkTested: vi.fn(), onCopyId: vi.fn(), onTechnicalDetails: vi.fn(),
      }),
    ));
    const action = screen.getByRole("button", { name: "Mark tested Task Completion" });
    fireEvent.keyDown(action, { key: "Escape" });
    fireEvent.keyDown(action, { key: "Tab" });
    expect(onKeyDown.mock.calls.map(([event]) => event.key)).toEqual(["Escape", "Tab"]);
  });

  it("renders and routes one visible primary action", () => {
    const onMarkTested = vi.fn();
    render(createElement(GovernanceRowActions, {
      record: { kind: "profile", value: profile }, onLifecycleAction: vi.fn(),
      onMarkTested, onCopyId: vi.fn(), onTechnicalDetails: vi.fn(),
    }));
    fireEvent.click(screen.getByRole("button", { name: "Mark tested Task Completion" }));
    expect(onMarkTested).toHaveBeenCalledWith(profile, "tested");
    expect(screen.queryByRole("button", { name: /Validate Task Completion/ })).toBeNull();
    expect(screen.getByRole("button", { name: "More actions for Task Completion" })).toBeTruthy();
  });

  it("requires testing before a validated Profile can expose Approve", () => {
    const validated = { ...profile, status: "validated" as const };
    render(createElement(GovernanceRowActions, {
      record: { kind: "profile", value: validated }, onLifecycleAction: vi.fn(),
      onMarkTested: vi.fn(), onCopyId: vi.fn(), onTechnicalDetails: vi.fn(),
    }));
    expect(screen.getByRole("button", { name: "Mark tested Task Completion" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve Task Completion" })).toBeNull();
  });

  it("hides authoring actions for read-only users", () => {
    render(createElement(GovernanceRowActions, {
      record: { kind: "policy", value: policy }, canAuthor: false,
      onLifecycleAction: vi.fn(), onMarkTested: vi.fn(), onCopyId: vi.fn(),
      onTechnicalDetails: vi.fn(),
    }));
    expect(screen.queryByRole("button", { name: /Validate Production release/ })).toBeNull();
    expect(screen.getByRole("button", { name: "More actions for Production release" })).toBeTruthy();
  });

  it("keeps override, copy, and technical details in the overflow menu", async () => {
    const onMarkTested = vi.fn();
    const onCopyId = vi.fn();
    const onTechnicalDetails = vi.fn();
    render(createElement(GovernanceRowActions, {
      record: { kind: "profile", value: profile }, onLifecycleAction: vi.fn(),
      onMarkTested, onCopyId, onTechnicalDetails,
    }));

    fireEvent.keyDown(screen.getByRole("button", { name: "More actions for Task Completion" }), {
      key: "ArrowDown",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Override Not tested" }));
    expect(onMarkTested).toHaveBeenCalledWith(profile, "overridden");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "More actions for Task Completion" })));

    fireEvent.keyDown(screen.getByRole("button", { name: "More actions for Task Completion" }), {
      key: "ArrowDown",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy ID" }));
    expect(onCopyId).toHaveBeenCalledWith({ kind: "profile", value: profile });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "More actions for Task Completion" })));

    fireEvent.keyDown(screen.getByRole("button", { name: "More actions for Task Completion" }), {
      key: "ArrowDown",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Technical details" }));
    expect(onTechnicalDetails).toHaveBeenCalledWith({ kind: "profile", value: profile });
  });
});
