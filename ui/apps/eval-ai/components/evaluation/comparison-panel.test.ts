/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComparisonPanel } from "@/components/evaluation/comparison-panel";
import { COMPARE_AXES, offerableCompareAxes } from "@/components/evaluation/helpers";
import type { LlmCatalogEntry, PromptVersion } from "@/lib/api";

function prompt(version: number): PromptVersion {
  return {
    prompt_id: "support",
    version,
    tenant_id: "tenant-classroom",
    name: `Support v${version}`,
    content: "Be concise.",
    content_hash: "abc",
    labels: [],
  };
}

function model(id: string): LlmCatalogEntry {
  return { model_id: id, name: id, description: "" } as LlmCatalogEntry;
}

function panel(props: Partial<Parameters<typeof ComparisonPanel>[0]> = {}) {
  return render(
    createElement(ComparisonPanel, {
      axes: offerableCompareAxes(true),
      axis: "none",
      axisDescription: COMPARE_AXES[0]!.description,
      maxTargets: 4,
      savedPrompts: [prompt(1), prompt(2)],
      selectedPromptRefs: [],
      llmCatalog: [model("a"), model("b")],
      selectedLlmId: "a",
      selectedLlmIds: [],
      onAxisChange: vi.fn(),
      onTogglePrompt: vi.fn(),
      onToggleLlm: vi.fn(),
      ...props,
    }),
  );
}

afterEach(() => {
  cleanup();
});

describe("ComparisonPanel", () => {
  it("offers no targets until an axis is chosen", () => {
    // "none" is a real choice, so the panel must show nothing to pick rather
    // than a target list for an axis nobody selected.
    const { container } = panel();
    expect(container.querySelector(".hidden")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "No comparison" }).getAttribute("aria-checked")).toBe("true");
  });

  it("lists saved prompts on the prompt axis", () => {
    panel({ axis: "prompts", axisDescription: "Same model." });
    expect(screen.getByText("Support v1")).toBeTruthy();
    expect(screen.getByText("Support v2")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Select at least two versions");
  });

  it("announces the number of versions that will run", () => {
    panel({ axis: "prompts", selectedPromptRefs: ["support@1", "support@2"] });
    expect(screen.getByRole("status").textContent).toContain("2 versions selected");
  });

  it("never offers the already-chosen model as a comparison target", () => {
    // It is one arm of the comparison, so listing it would let a run be
    // compared against itself.
    panel({ axis: "models", axisDescription: "Same prompt." });
    const targets = screen.getAllByRole("button").map((node) => node.textContent ?? "");
    expect(targets.some((text) => text.includes("b"))).toBe(true);
    expect(targets.some((text) => text.startsWith("a"))).toBe(false);
  });

  it("stops adding models one short of the cap, counting the chosen one", () => {
    panel({
      axis: "models",
      axisDescription: "Same prompt.",
      maxTargets: 2,
      selectedLlmIds: ["beta"],
      llmCatalog: [model("alpha"), model("beta"), model("gamma")],
      selectedLlmId: "alpha",
    });
    // `CheckOption` marks itself aria-disabled rather than disabled, so it stays
    // focusable and the capped-out reason is reachable. Matched by text rather
    // than an accessible-name regex: the shared description text would collide.
    const capped = screen
      .getAllByRole("button")
      .find((node) => node.textContent?.startsWith("gamma"))!;
    expect(capped.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("A comparison is capped at 2 runs.")).toBeTruthy();
  });

  it("offers the same model name at another endpoint as a distinct target", () => {
    const local = { ...model("same"), name: "Local", endpoint: "http://127.0.0.1:11434/v1" };
    const cloud = { ...model("same"), name: "OpenAI", endpoint: "https://api.openai.com/v1" };
    const onToggleLlm = vi.fn();
    panel({ axis: "models", llmCatalog: [local, cloud], selectedLlmId: JSON.stringify([local.endpoint, "same"]), onToggleLlm });
    const target = screen.getAllByRole("button").find(node => node.textContent?.startsWith("OpenAI"))!;
    fireEvent.click(target);
    expect(onToggleLlm).toHaveBeenCalledWith(JSON.stringify([cloud.endpoint, "same"]));
    expect(screen.getAllByRole("button").some(node => node.textContent?.startsWith("Local"))).toBe(false);
  });

  it("reports the chosen target back to the caller", () => {
    const onToggleLlm = vi.fn();
    panel({ axis: "models", axisDescription: "Same prompt.", onToggleLlm });
    const target = screen
      .getAllByRole("button")
      .find((node) => node.textContent?.startsWith("b"))!;
    fireEvent.click(target);
    expect(onToggleLlm).toHaveBeenCalledWith(JSON.stringify(["", "b"]));
  });
});
