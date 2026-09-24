/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SegmentedChoice } from "@/components/segmented-choice";

const OPTIONS = [
  { value: "none", label: "No comparison" },
  { value: "models", label: "Models" },
  { value: "prompts", label: "Prompts" },
] as const;

function choice(props: Partial<Parameters<typeof SegmentedChoice>[0]> = {}) {
  return render(
    createElement(SegmentedChoice, {
      options: OPTIONS,
      value: "none",
      onChange: vi.fn(),
      label: "What the comparison varies",
      ...props,
    }),
  );
}

afterEach(() => {
  cleanup();
});

describe("SegmentedChoice", () => {
  it("marks exactly one option chosen", () => {
    choice({ value: "models" });
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });

  it("keeps one tab stop, on the chosen option", () => {
    // Every option being tabbable is the default for a row of buttons, and it is
    // wrong for a radiogroup: tabbing should enter the group once.
    choice({ value: "models" });
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("tabindex"))).toEqual([
      "-1",
      "0",
      "-1",
    ]);
  });

  it("moves the selection with the arrow keys", () => {
    const onChange = vi.fn();
    choice({ value: "none", onChange });
    fireEvent.keyDown(screen.getAllByRole("radio")[0]!, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("models");
  });

  it("wraps at the ends and answers Home/End", () => {
    const onChange = vi.fn();
    choice({ value: "none", onChange });
    fireEvent.keyDown(screen.getAllByRole("radio")[0]!, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("prompts");
    fireEvent.keyDown(screen.getAllByRole("radio")[0]!, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("prompts");
    fireEvent.keyDown(screen.getAllByRole("radio")[0]!, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("none");
  });

  it("names the group and describes options without showing the description", () => {
    choice({
      options: [{ value: "a", label: "A", hint: "The long explanation." }],
      value: "a",
      label: "Pick one",
      idPrefix: "pick",
    });
    expect(screen.getByRole("radiogroup", { name: "Pick one" })).toBeTruthy();
    expect(screen.getByRole("radio").getAttribute("aria-describedby")).toBe("pick-a-description");
  });
});
