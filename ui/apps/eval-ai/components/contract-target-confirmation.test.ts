/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContractTargetsPanel } from "./contract-targets-panel";

afterEach(cleanup);

const project = {
  project_id: "project-1",
  tenant_id: "tenant-1",
  name: "Support",
  system_type: "agent",
  owner: "Evaluation",
  status: "active" as const,
};
const agent = {
  target_version_id: "catalog-1",
  target_id: "support-agent",
  project_id: "catalog",
  tenant_id: "tenant-1",
  name: "Support agent",
  version: "1.0.0",
  endpoint: "https://example.test",
  target_type: "agent" as const,
  environment: "dev",
  model_version: "gpt-4.1",
  prompt_version: null,
  tool_versions: {},
  configuration: {},
};

function props(overrides = {}) {
  return {
    project,
    targets: [],
    catalogAgents: [agent],
    customOpen: false,
    selectedTargetVersionId: "",
    onSelect: vi.fn(),
    onAddAgent: vi.fn().mockResolvedValue(undefined),
    onCustomOpenChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
}

describe("permanent target confirmations", () => {
  it("confirms the Project consequence before custom target registration", () => {
    const onSubmit = vi.fn();
    render(createElement(ContractTargetsPanel, props({ customOpen: true, onSubmit })));

    fireEvent.change(screen.getByLabelText("Target name"), { target: { value: "Custom target" } });
    fireEvent.change(screen.getByLabelText("Target ID"), { target: { value: "custom-target" } });
    fireEvent.change(screen.getByLabelText("Gateway or endpoint URL"), { target: { value: "https://custom.test" } });
    const submit = screen.getByRole("button", { name: "Register target version" });
    fireEvent.submit(submit.closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("dialog", { name: "Register target permanently?" });
    expect(within(confirmation).getByText(/remains on Support even if you abandon this Assignment/)).toBeTruthy();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Register target" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("confirms Agent Catalog add and keeps the modal open on API failure", async () => {
    const onAddAgent = vi.fn().mockRejectedValue(new Error("registration unavailable"));
    render(createElement(ContractTargetsPanel, props({ onAddAgent })));

    fireEvent.click(screen.getByRole("button", { name: "Add from Agent Catalog" }));
    fireEvent.click(screen.getByRole("button", { name: "Add target" }));
    const confirmation = screen.getByRole("dialog", { name: "Add agent permanently?" });
    expect(within(confirmation).getByText(/remains on Support even if you abandon this Assignment/)).toBeTruthy();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Add agent" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("registration unavailable"));
    expect(screen.getByRole("dialog", { name: "Add agent permanently?" })).toBeTruthy();
  });

  it("shows Agent Catalog failure guidance instead of a false empty result", () => {
    render(createElement(ContractTargetsPanel, props({
      catalogAgents: [],
      catalogLoadState: "error",
      onRetryCatalog: vi.fn(),
    })));

    fireEvent.click(screen.getByRole("button", { name: "Add from Agent Catalog" }));
    expect(screen.getByRole("alert").textContent).toContain("Agent Catalog could not be loaded");
    expect(screen.getByRole("button", { name: "Retry Agent Catalog" })).toBeTruthy();
    expect(screen.queryByText("0 agents")).toBeNull();
  });

  it("Escape closes only custom registration confirmation and restores parent focus", async () => {
    const onCustomOpenChange = vi.fn();
    render(createElement(ContractTargetsPanel, props({ customOpen: true, onCustomOpenChange })));
    fireEvent.change(screen.getByLabelText("Target name"), { target: { value: "Custom target" } });
    fireEvent.change(screen.getByLabelText("Target ID"), { target: { value: "custom-target" } });
    fireEvent.change(screen.getByLabelText("Gateway or endpoint URL"), { target: { value: "https://custom.test" } });
    const submit = screen.getByRole("button", { name: "Register target version" });
    submit.focus();
    fireEvent.submit(submit.closest("form")!);
    expect(screen.getByRole("dialog", { name: "Register target permanently?" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Register target permanently?" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Register custom endpoint" })).toBeTruthy();
    expect(onCustomOpenChange).not.toHaveBeenCalledWith(false);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Register target version" }))
    );
  });

  it("Escape closes only Agent Catalog confirmation and restores add-button focus", async () => {
    render(createElement(ContractTargetsPanel, props()));
    fireEvent.click(screen.getByRole("button", { name: "Add from Agent Catalog" }));
    const add = screen.getByRole("button", { name: "Add target" });
    add.focus();
    fireEvent.click(add);
    expect(screen.getByRole("dialog", { name: "Add agent permanently?" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add agent permanently?" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Add target from Agent Catalog" })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add target" }))
    );
  });
});
