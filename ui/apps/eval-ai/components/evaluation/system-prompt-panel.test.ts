import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PromptVersion } from "@/lib/api";
import { SystemPromptPanel } from "@/components/evaluation/system-prompt-panel";

function prompt(overrides: Partial<PromptVersion> = {}): PromptVersion {
  return {
    prompt_id: "support",
    version: 2,
    tenant_id: "tenant-classroom",
    name: "Support",
    content: "Be concise.",
    content_hash: "abc",
    labels: [],
    ...overrides,
  };
}

function render(props: Partial<Parameters<typeof SystemPromptPanel>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(SystemPromptPanel, {
      value: "",
      reference: null,
      savedPrompts: [],
      saving: false,
      canSave: true,
      saveError: null,
      onChange: vi.fn(),
      onStartFrom: vi.fn(),
      onSave: vi.fn(),
      ...props,
    }),
  );
}

describe("SystemPromptPanel", () => {
  it("never offers saving to a caller who lacks the role", () => {
    // The endpoint requires proofgrove-approver; a button that 403s is worse than none.
    expect(render({ value: "Be terse.", canSave: false })).not.toContain("Save to library");
  });

  it("reports a refused save next to the button that failed", () => {
    // The save endpoint refuses a prompt carrying a credential; that message has
    // to land here, not only in the form-wide banner far above this button.
    const markup = render({
      value: "Bearer sk-test",
      saveError: "This prompt appears to contain a bearer token.",
    });
    expect(markup).toContain("This prompt appears to contain a bearer token.");
    expect(markup).toContain('role="alert"');
  });

  it("locks the prompt while a save is in flight", () => {
    // The save returns a reference; text edited meanwhile would be attributed to
    // a version that never contained it.
    const markup = render({ value: "Be terse.", saving: true, savedPrompts: [prompt()] });
    expect(markup).toMatch(/<textarea[^>]*disabled/);
  });

  it("offers saving only for unsaved text", () => {
    expect(render({ value: "Be terse." })).toContain("Save to library");
    // Already saved: nothing to save.
    expect(render({ value: "Be terse.", reference: "support@2" })).not.toContain("Save to library");
    // Nothing typed: nothing to save.
    expect(render()).not.toContain("Save to library");
  });

  it("says which version a run will record, and that editing drops it", () => {
    const markup = render({ value: "Be terse.", reference: "support@2" });
    expect(markup).toContain("support@2");
    expect(markup).toMatch(/Editing the\s+text clears that/);
  });

  it("asks how the prompt is supplied only when there is a library to choose from", () => {
    // With nothing saved there is no choice to make, so the question is not asked.
    expect(render({ savedPrompts: [prompt()] })).toContain("Use a saved prompt");
    expect(render()).not.toContain("Use a saved prompt");
    expect(render()).toContain("System prompt");
  });

  it("shows one prompt input at a time, never a picker and a textarea together", () => {
    // Two inputs for one value cannot say which the run will use, and they can
    // visibly disagree — a picker naming one prompt above a box holding another.
    const writing = render({ savedPrompts: [prompt()] });
    expect(writing).toContain("System prompt");
    // The Field label, not the placeholder — a chosen prompt replaces the placeholder.
    expect(writing).not.toContain("Saved prompt");

    const picking = render({
      savedPrompts: [prompt()],
      reference: "support@2",
      value: "Be concise.",
    });
    expect(picking).toContain("Saved prompt");
    expect(picking).not.toContain("<textarea");
  });

  it("starts in the mode the current selection implies", () => {
    // A run loaded with a saved reference opens on the library, not on a blank box.
    expect(render({ savedPrompts: [prompt()], reference: "support@2" })).toContain(
      'aria-checked="true"',
    );
    expect(render({ savedPrompts: [prompt()] })).toContain("System prompt");
  });

  it("shows the text of the saved prompt it is about to send", () => {
    // Choosing by name alone is choosing blind; the text is what actually goes out.
    const html = render({
      savedPrompts: [prompt({ content: "Answer in one sentence." })],
      reference: "support@2",
    });
    expect(html).toContain("Answer in one sentence.");
    expect(html).toContain("Sent before each row");
  });
});
