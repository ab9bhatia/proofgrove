/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addRunLabel, MAX_RUN_LABELS, RunLabelInput } from "./label-input";

afterEach(() => {
  cleanup();
});

describe("run label rules", () => {
  it("trims and collapses whitespace", () => {
    expect(addRunLabel([], "  baseline   v2 ").labels).toEqual(["baseline v2"]);
  });

  it("ignores an empty entry without complaining", () => {
    const result = addRunLabel(["a"], "   ");
    expect(result.labels).toEqual(["a"]);
    expect(result.error).toBeNull();
  });

  it("refuses a duplicate and says so, rather than silently doing nothing", () => {
    // A control that swallows input reads as broken.
    const result = addRunLabel(["baseline"], "BASELINE");
    expect(result.labels).toEqual(["baseline"]);
    expect(result.error).toContain("already added");
  });

  it("bounds the list and the label length", () => {
    const full = Array.from({ length: MAX_RUN_LABELS }, (_, index) => `label-${index}`);
    expect(addRunLabel(full, "one-more").error).toContain(`at most ${MAX_RUN_LABELS}`);
    expect(addRunLabel([], "x".repeat(65)).error).toContain("at most 64 characters");
  });
});

describe("run label input", () => {
  it("keeps chips and the text input inside one token field", () => {
    const html = renderToStaticMarkup(
      createElement(RunLabelInput, { labels: ["baseline"], onChange: vi.fn() }),
    );
    const root = document.createElement("div");
    root.innerHTML = html;

    const chipList = root.querySelector("ul");
    const input = root.querySelector("input");

    expect(chipList).not.toBeNull();
    expect(input).not.toBeNull();
    expect(input!.parentElement).toBe(chipList!.parentElement);
    expect(input!.parentElement).not.toBe(root.firstElementChild);
  });

  it("adds a label on Enter without submitting the form", () => {
    const onChange = vi.fn();
    render(createElement(RunLabelInput, { labels: [], onChange }));
    const field = screen.getByLabelText("Add a run label");

    fireEvent.change(field, { target: { value: "baseline v2" } });
    const event = fireEvent.keyDown(field, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(["baseline v2"]);
    // Returning false from fireEvent means preventDefault was called: Enter must not
    // reach the surrounding setup form and start a run.
    expect(event).toBe(false);
  });

  it("keeps a typed label when focus leaves instead of discarding it", () => {
    const onChange = vi.fn();
    render(createElement(RunLabelInput, { labels: [], onChange }));
    const field = screen.getByLabelText("Add a run label");

    fireEvent.change(field, { target: { value: "prompt tweak" } });
    fireEvent.blur(field);

    expect(onChange).toHaveBeenCalledWith(["prompt tweak"]);
  });

  it("removes a label from its chip", () => {
    const onChange = vi.fn();
    render(createElement(RunLabelInput, { labels: ["baseline", "candidate"], onChange }));

    fireEvent.click(screen.getByRole("button", { name: "Remove label baseline" }));

    expect(onChange).toHaveBeenCalledWith(["candidate"]);
  });

  it("removes the last chip on Backspace in an empty field", () => {
    const onChange = vi.fn();
    render(createElement(RunLabelInput, { labels: ["a", "b"], onChange }));

    fireEvent.keyDown(screen.getByLabelText("Add a run label"), { key: "Backspace" });

    expect(onChange).toHaveBeenCalledWith(["a"]);
  });

  it("focuses the text input when the token field is clicked", () => {
    render(createElement(RunLabelInput, { labels: ["baseline"], onChange: vi.fn() }));
    const field = screen.getByLabelText("Add a run label");
    const tokenField = field.parentElement;

    expect(tokenField).not.toBeNull();
    fireEvent.click(tokenField!);

    expect(document.activeElement).toBe(field);
  });
});
