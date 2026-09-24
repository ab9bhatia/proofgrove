/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  handleRovingRadioKeyDown,
  rovingRadioTabIndex,
  rovingRadioTabStop,
} from "./roving-radiogroup";

afterEach(() => {
  cleanup();
});

function Demo({
  values,
  disabledValues = [],
}: {
  values: string[];
  disabledValues?: string[];
}) {
  const [value, setValue] = useState(values[0]!);
  const disabled = new Set(disabledValues);
  const tabStop = rovingRadioTabStop({
    values,
    current: value,
    disabled: (item) => disabled.has(item),
  });
  return createElement(
    "div",
    { role: "radiogroup", "aria-label": "Demo" },
    values.map((option) =>
      createElement(
        "button",
        {
          key: option,
          type: "button",
          role: "radio",
          "aria-checked": value === option,
          "data-radio-value": option,
          tabIndex: rovingRadioTabIndex(option === tabStop),
          disabled: disabled.has(option),
          onClick: () => setValue(option),
          onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) =>
            handleRovingRadioKeyDown(event, {
              values,
              current: value,
              disabled: (item) => disabled.has(item),
              onSelect: setValue,
            }),
        },
        option,
      ),
    ),
  );
}

/** A tablist reusing the same helper via custom group/item selectors. */
function TabsDemo({ values }: { values: string[] }) {
  const [value, setValue] = useState(values[0]!);
  return createElement(
    "nav",
    { role: "tablist", "aria-label": "Sections" },
    values.map((option) =>
      createElement(
        "button",
        {
          key: option,
          type: "button",
          role: "tab",
          "aria-selected": value === option,
          "data-tab-value": option,
          tabIndex: rovingRadioTabIndex(option === value),
          onClick: () => setValue(option),
          onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) =>
            handleRovingRadioKeyDown(event, {
              values,
              current: value,
              onSelect: setValue,
              groupSelector: '[role="tablist"]',
              itemSelector: (item: string) => `[role="tab"][data-tab-value="${item}"]`,
            }),
        },
        option,
      ),
    ),
  );
}

describe("roving tablist keyboard a11y", () => {
  it("reaches a tabIndex={-1} tab with ArrowRight", () => {
    // Roving tabindex takes the second tab out of the Tab order; without arrow
    // handling it would be unreachable by keyboard entirely.
    render(createElement(TabsDemo, { values: ["input", "output"] }));
    const input = screen.getByRole("tab", { name: "input" });
    expect(screen.getByRole("tab", { name: "output" }).tabIndex).toBe(-1);
    input.focus();

    fireEvent.keyDown(input, { key: "ArrowRight" });

    const output = screen.getByRole("tab", { name: "output" });
    expect(output.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(output);
  });

  it("supports ArrowLeft, Home and End across tabs", () => {
    render(createElement(TabsDemo, { values: ["input", "output", "tools"] }));
    const input = screen.getByRole("tab", { name: "input" });
    input.focus();

    fireEvent.keyDown(input, { key: "End" });
    expect(screen.getByRole("tab", { name: "tools" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "output" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(screen.getByRole("tab", { name: "input" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("roving radiogroup keyboard a11y", () => {
  it("moves selection and focus with ArrowRight/ArrowLeft", () => {
    render(createElement(Demo, { values: ["all", "agent", "rag", "llm"] }));
    const all = screen.getByRole("radio", { name: "all" });
    all.focus();
    expect(document.activeElement).toBe(all);

    fireEvent.keyDown(all, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "agent" }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "agent" }));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "all" }).getAttribute("aria-checked")).toBe("true");
  });

  it("moves selection on the vertical arrows too", () => {
    render(createElement(Demo, { values: ["all", "agent", "rag"] }));
    const all = screen.getByRole("radio", { name: "all" });
    all.focus();

    fireEvent.keyDown(all, { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: "agent" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(screen.getByRole("radio", { name: "all" }).getAttribute("aria-checked")).toBe("true");
  });

  it("supports Home and End", () => {
    render(createElement(Demo, { values: ["a", "b", "c"] }));
    const first = screen.getByRole("radio", { name: "a" });
    first.focus();
    fireEvent.keyDown(first, { key: "End" });
    expect(screen.getByRole("radio", { name: "c" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(screen.getByRole("radio", { name: "a" }).getAttribute("aria-checked")).toBe("true");
  });

  it("tabs into the group once via the selected option", () => {
    render(createElement(Demo, { values: ["x", "y", "z"] }));
    expect(screen.getByRole("radio", { name: "x" }).tabIndex).toBe(0);
    expect(screen.getByRole("radio", { name: "y" }).tabIndex).toBe(-1);
    expect(screen.getByRole("radio", { name: "z" }).tabIndex).toBe(-1);
  });

  it("keeps a tab stop when the selected option is disabled", () => {
    render(createElement(Demo, { values: ["one", "two", "three"], disabledValues: ["one"] }));
    expect(screen.getByRole("radio", { name: "one" }).tabIndex).toBe(-1);
    expect(screen.getByRole("radio", { name: "two" }).tabIndex).toBe(0);
    expect(screen.getByRole("radio", { name: "three" }).tabIndex).toBe(-1);
  });

  it("resolves the tab stop from the selected and enabled options", () => {
    const values = ["final_response", "tool_interactions", "full_execution"];
    expect(rovingRadioTabStop({ values, current: "tool_interactions" })).toBe("tool_interactions");
    expect(
      rovingRadioTabStop({
        values,
        current: "full_execution",
        disabled: (value) => value === "full_execution",
      }),
    ).toBe("final_response");
    expect(rovingRadioTabStop({ values, current: "unknown_scope" })).toBe("final_response");
    expect(rovingRadioTabStop({ values, current: "final_response", disabled: () => true })).toBeNull();
  });

  it("skips disabled options when arrowing", () => {
    render(createElement(Demo, { values: ["one", "two", "three"], disabledValues: ["two"] }));
    const one = screen.getByRole("radio", { name: "one" });
    one.focus();
    fireEvent.keyDown(one, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "three" }).getAttribute("aria-checked")).toBe("true");
  });
});
