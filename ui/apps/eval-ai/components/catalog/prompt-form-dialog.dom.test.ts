/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PromptFormDialog } from "@/components/catalog/prompt-form-dialog";

function dialog(props: Partial<Parameters<typeof PromptFormDialog>[0]> = {}) {
  return render(
    createElement(PromptFormDialog, {
      promptId: "support-tone",
      note: "",
      onNoteChange: vi.fn(),
      name: "",
      content: "Be concise.",
      saving: false,
      error: null,
      onPromptIdChange: vi.fn(),
      onNameChange: vi.fn(),
      onContentChange: vi.fn(),
      onSubmit: vi.fn(),
      onClose: vi.fn(),
      ...props,
    }),
  );
}

afterEach(() => {
  cleanup();
});

describe("PromptFormDialog", () => {
  it("lets the id be typed when adding a brand new prompt", () => {
    dialog();
    expect((screen.getByLabelText("Prompt id") as HTMLInputElement).readOnly).toBe(false);
  });

  it("refuses edits to the id when opened from a prompt's own page", () => {
    // Editing it there would write a different prompt than the one on screen —
    // silently, and with a success message naming the id the user typed.
    dialog({ promptIdLocked: true });
    const field = screen.getByLabelText("Prompt id") as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe("support-tone");
  });

  it("holds the submit until there is something to save", () => {
    dialog({ content: "   " });
    expect((screen.getByRole("button", { name: "Save version" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports a rejected save beside the fields, not as a page error", () => {
    dialog({ error: "That id already exists." });
    expect(screen.getByRole("alert").textContent).toBe("That id already exists.");
  });

  it("closes without saving when cancelled", () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    dialog({ onClose, onSubmit });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
