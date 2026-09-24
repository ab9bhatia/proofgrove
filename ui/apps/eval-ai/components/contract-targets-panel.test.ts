/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentTargetDialog, ContractTargetsPanel } from "./contract-targets-panel";

const project = { project_id: "project-1", tenant_id: "tenant-classroom", name: "Support evaluation", system_type: "Agent", owner: "Evaluation team", status: "active" as const };
const target = {
  target_version_id: "target-version-1",
  target_id: "support-agent",
  project_id: "project-1",
  tenant_id: "tenant-classroom",
  name: "Support agent",
  version: "1.0.0",
  endpoint: "https://agent.example.com",
  target_type: "agent" as const,
  environment: "dev",
  model_version: "gpt-4.1",
  prompt_version: "support-v3",
  tool_versions: {},
  configuration: {},
};

const common = {
  project,
  catalogAgents: [target],
  customOpen: false,
  selectedTargetVersionId: "target-version-1",
  onSelect: vi.fn(),
  onAddAgent: vi.fn(),
  onCustomOpenChange: vi.fn(),
  onSubmit: vi.fn(),
};

afterEach(cleanup);

describe("ContractTargetsPanel", () => {
  it("uses friendly target identity and preserves registration actions", () => {
    const html = renderToStaticMarkup(createElement(ContractTargetsPanel, { ...common, targets: [target] }));
    expect(html).toContain("Support evaluation");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Support agent, agent, dev, gpt-4.1"');
    expect(html).not.toContain('aria-label="Support agent, agent, dev, gpt-4.1, https://agent.example.com"');
    expect(html).toContain("gpt-4.1 · support-v3");
    expect(html).toContain("Technical details");
    expect(html).toContain("https://agent.example.com");
    expect(html).toContain("Copy endpoint");
    expect(html).toContain("Register custom endpoint");
    expect(html).toContain("Add from Agent Catalog");
  });

  it("selects from status metadata while technical controls remain independent", () => {
    const onSelect = vi.fn();
    render(createElement(ContractTargetsPanel, { ...common, targets: [target], selectedTargetVersionId: "", onSelect }));

    fireEvent.click(screen.getByText("dev"));
    expect(onSelect).toHaveBeenCalledWith("target-version-1");
    onSelect.mockClear();

    fireEvent.click(screen.getByText("Technical details"));
    expect(onSelect).not.toHaveBeenCalled();

    const radio = screen.getByRole("radio", { name: "Support agent, agent, dev, gpt-4.1" });
    expect(radio.className).toContain("size-full");
    expect(radio.className).not.toContain("sr-only");
    expect(radio.nextElementSibling?.className).toContain("peer-focus-visible:ring-2");
  });

  it("uses compact responsive card structure without page-level width pressure", () => {
    const html = renderToStaticMarkup(createElement(ContractTargetsPanel, { ...common, targets: [target] }));
    expect(html).toContain("min-w-0");
    expect(html).toContain("max-w-full");
    expect(html).toContain("grid-cols-1");
    expect(html).toContain("md:grid-cols-");
    expect(html).not.toContain("overflow-x-auto");
  });

  it("preserves target registration fields", () => {
    // Rendered, not statically stringified: the dialog portals into document.body,
    // and the server renderer refuses portals even though jsdom has a document.
    render(createElement(ContractTargetsPanel, { ...common, targets: [target], customOpen: true }));
    const html = document.body.innerHTML;
    for (const field of ["target-name", "target-id", "target-version", "target-type", "target-endpoint", "target-environment", "target-model-version", "target-prompt-version"]) {
      expect(html).toContain(`for="${field}"`);
    }
    expect(html).toContain("h-[60px]");
  });

  it("paginates Agent Catalog and registered targets", () => {
    const agents = Array.from({ length: 7 }, (_, index) => ({ ...target, target_version_id: `catalog-${index}`, target_id: `agent-${index}`, name: `Agent ${index + 1}` }));
    render(createElement(AgentTargetDialog, { agents, targets: [], pendingAgentId: null, actionsDisabled: false, onAddAgent: vi.fn(), onClose: vi.fn() }));
    const catalog = document.body.innerHTML;
    cleanup();
    const targets = renderToStaticMarkup(createElement(ContractTargetsPanel, { ...common, targets: Array.from({ length: 8 }, (_, index) => ({ ...target, target_version_id: `target-${index}`, name: `Target ${index + 1}` })) }));
    expect(catalog).toContain("1–5 of 7");
    expect(catalog).not.toContain("Agent 6");
    expect(targets).toContain("1–6 of 8 targets");
    expect(targets).not.toContain("Target 7");
  });

  it("distinguishes a failed target load from an empty Project", () => {
    const html = renderToStaticMarkup(createElement(ContractTargetsPanel, { ...common, targets: [], loadState: "error" }));
    expect(html).toContain("Targets could not be loaded");
    expect(html).toContain("Refresh to retry");
    expect(html).not.toContain("No registered targets yet");
    expect(html).not.toContain("Register custom endpoint");
  });
});
