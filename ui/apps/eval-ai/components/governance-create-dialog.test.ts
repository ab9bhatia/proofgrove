/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GovernanceCreateDialog } from "./governance-create-dialog";

const common = {
  metrics: [],
  pending: false,
  error: null,
  onClose: vi.fn(),
  onCreateProfile: vi.fn(),
  onCreatePolicy: vi.fn(),
};

afterEach(cleanup);

describe("GovernanceCreateDialog", () => {
  it("warns when a name is already taken, without blocking the save", () => {
    render(createElement(GovernanceCreateDialog, {
      ...common,
      kind: "profile" as const,
      existingNames: ["Tool Use Correctness"],
    }));

    const name = screen.getByLabelText("Profile name");
    expect(screen.queryByText(/already uses this name/)).toBeNull();

    // Case and surrounding whitespace should not be what decides whether two
    // records are tellable apart in the catalogue.
    fireEvent.change(name, { target: { value: "  tool use correctness " } });
    expect(screen.getByText(/already uses this name/)).toBeTruthy();
    expect(name.getAttribute("aria-describedby")).toBe("governance-name-duplicate");
    expect((name as HTMLInputElement).validity.valid).toBe(true);

    fireEvent.change(name, { target: { value: "Something else" } });
    expect(screen.queryByText(/already uses this name/)).toBeNull();
  });

  it("generates the id and version instead of asking for them", () => {
    render(createElement(GovernanceCreateDialog, { ...common, kind: "profile" as const }));
    expect(screen.queryByLabelText("Profile ID")).toBeNull();
    expect(screen.queryByLabelText("Version")).toBeNull();
    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Agent quality" } });
    expect(screen.getByText(/Saved as version 1\.0\.0/)).toBeTruthy();
    expect(screen.getByText(/agent-quality/)).toBeTruthy();
  });

  it("sends the approver roles the author picked, and none by default", () => {
    const onCreateProfile = vi.fn().mockResolvedValue(undefined);
    render(createElement(GovernanceCreateDialog, {
      ...common,
      kind: "profile" as const,
      metrics: [{ metric_id: "quality.groundedness", name: "Groundedness", description: "" }] as never,
      onCreateProfile,
    }));

    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Grounded" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Groundedness" }));
    // Only the two roles the backend recognises are offered; anything else
    // fails closed on save with no way for the author to see why.
    fireEvent.click(screen.getByRole("checkbox", { name: /Approver/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create draft Quality Profile" }));

    expect(onCreateProfile.mock.calls[0]![0].approver_roles).toEqual(["proofgrove-approver"]);
  });

  it("leaves approver roles empty so the platform default still applies", () => {
    const onCreatePolicy = vi.fn().mockResolvedValue(undefined);
    render(createElement(GovernanceCreateDialog, {
      ...common,
      kind: "policy" as const,
      metrics: [{ metric_id: "quality.groundedness", name: "Groundedness", description: "" }] as never,
      onCreatePolicy,
    }));

    fireEvent.change(screen.getByLabelText("Policy name"), { target: { value: "Release" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Groundedness" }));
    fireEvent.click(screen.getByRole("button", { name: "Create draft Gate Policy" }));

    expect(onCreatePolicy.mock.calls[0]![0].required_approver_roles).toEqual([]);
  });

  it("marks checks optional so the profile can be bound to a Gate Policy", async () => {
    const onCreateProfile = vi.fn().mockResolvedValue(undefined);
    render(createElement(GovernanceCreateDialog, {
      ...common,
      kind: "profile" as const,
      metrics: [{ metric_id: "quality.groundedness", name: "Groundedness", description: "" }] as never,
      onCreateProfile,
    }));

    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Grounded" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Groundedness" }));
    fireEvent.click(screen.getByRole("button", { name: "Create draft Quality Profile" }));

    // An unstated requirement resolves to required, and a required check with no
    // KPI composition makes the whole profile unbindable to a Gate Policy.
    expect(onCreateProfile.mock.calls[0]![0].metric_requirements).toEqual({
      "quality.groundedness": "optional",
    });
  });

  it("does not warn on a fresh name in an empty catalogue", () => {
    render(createElement(GovernanceCreateDialog, { ...common, kind: "policy" as const }));
    fireEvent.change(screen.getByLabelText("Policy name"), { target: { value: "Release gate" } });
    expect(screen.queryByText(/already uses this name/)).toBeNull();
  });
});
