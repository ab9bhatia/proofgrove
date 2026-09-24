/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StepContinue } from "./form-primitives";

afterEach(() => {
  cleanup();
});

describe("StepContinue unmet requirements", () => {
  it("renders each unmet requirement when disabled", () => {
    render(
      createElement(StepContinue, {
        disabled: true,
        label: "Continue to dataset",
        onClick: () => undefined,
        requirements: [
          { label: "Name your evaluation", met: false },
          { label: "Select an agent", met: false },
          { label: "Select a published dataset", met: true },
        ],
      }),
    );

    const list = screen.getByRole("list", { name: "Unmet requirements" });
    expect(list.textContent).toContain("Name your evaluation");
    expect(list.textContent).toContain("Select an agent");
    expect(list.textContent).not.toContain("Select a published dataset");

    const button = screen.getByRole("button", { name: /Continue to dataset/i });
    // Focusable and described, so a keyboard or screen-reader user can reach the reason.
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain("To continue:");
    expect(document.getElementById(describedBy!)?.textContent).toContain("Name your evaluation");
  });

  it("does nothing when an aria-disabled continue is activated", () => {
    const onClick = vi.fn();
    render(
      createElement(StepContinue, {
        disabled: true,
        label: "Continue to dataset",
        onClick,
        requirements: [{ label: "Name your evaluation", met: false }],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Continue to dataset/i }));

    expect(onClick).not.toHaveBeenCalled();
  });

  it("includes the silent Name gate on the agent step list", () => {
    render(
      createElement(StepContinue, {
        disabled: true,
        label: "Continue to dataset",
        onClick: () => undefined,
        requirements: [
          { label: "Name your evaluation", met: false },
          { label: "Select an agent", met: true },
        ],
      }),
    );

    expect(screen.getByText("Name your evaluation")).toBeTruthy();
    expect(screen.queryByText("Select an agent")).toBeNull();
  });

  it("renders no unmet list when the button is enabled", () => {
    const onClick = vi.fn();
    render(
      createElement(StepContinue, {
        disabled: false,
        label: "Continue to system",
        onClick,
        requirements: [{ label: "Name your evaluation", met: true }],
      }),
    );

    expect(screen.queryByRole("list", { name: "Unmet requirements" })).toBeNull();
    const button = screen.getByRole("button", { name: /Continue to system/i });
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
