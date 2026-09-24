/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentFormDialog } from "@/components/catalog/agent-form-dialog";
import { LlmFormDialog } from "@/components/catalog/llm-form-dialog";

afterEach(() => {
  cleanup();
});

describe("catalog form dialogs", () => {
  it("disables the agent submit until the endpoint is present", () => {
    render(
      createElement(AgentFormDialog, {
        endpoint: "   ",
        testing: false,
        error: null,
        onEndpointChange: vi.fn(),
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect((screen.getByRole("button", { name: "Test and add" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables the LLM submit until both required fields are present", () => {
    render(
      createElement(LlmFormDialog, {
        modelId: "custom/support",
        displayName: "",
        endpoint: "   ",
        description: "",
        saving: false,
        error: null,
        onModelIdChange: vi.fn(),
        onDisplayNameChange: vi.fn(),
        onEndpointChange: vi.fn(),
        onDescriptionChange: vi.fn(),
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect((screen.getByRole("button", { name: "Add custom LLM" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
