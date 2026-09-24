/** @vitest-environment jsdom */

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Tabs, TabsList, TabsPanel, TabsTrigger, type TabsProps } from "./tabs";

function renderTabs(value: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(
        Tabs,
        {
          value,
          onValueChange: () => undefined,
        } as unknown as TabsProps,
        createElement(
          TabsList,
          { "aria-label": "Sections" },
          createElement(TabsTrigger, { value: "a" }, "A"),
          createElement(TabsTrigger, { value: "b" }, "B"),
        ),
        createElement(TabsPanel, { value: "a" }, "Panel A"),
        createElement(TabsPanel, { value: "b" }, "Panel B"),
      ),
    ),
  );
  return { host, root };
}

it("falls the roving tabindex back to the first trigger when no value matches", () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { host, root } = renderTabs("does-not-exist");
  try {
    const triggers = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(triggers[0]?.tabIndex).toBe(0);
    expect(triggers[1]?.tabIndex).toBe(-1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("wires each trigger's aria-controls to its panel's matching id/aria-labelledby", () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { host, root } = renderTabs("a");
  try {
    const triggerA = host.querySelector<HTMLButtonElement>('[data-tabs-value="a"]')!;
    const panelA = host.querySelectorAll<HTMLDivElement>('[role="tabpanel"]')[0]!;
    expect(triggerA.getAttribute("aria-controls")).toBe(panelA.id);
    expect(panelA.getAttribute("aria-labelledby")).toBe(triggerA.id);
    expect(triggerA.id).toBeTruthy();
    expect(panelA.id).toBeTruthy();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});


it("switches panels and skips disabled triggers with keyboard and click", () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Example() {
    const [value, onValueChange] = useState("missing");
    return createElement(
      Tabs,
      { value, onValueChange } as unknown as TabsProps,
      createElement(TabsList, { "aria-label": "Sections" },
        createElement(TabsTrigger, { value: "disabled", disabled: true }, "Disabled"),
        createElement(TabsTrigger, { value: "a" }, "A"),
        createElement(TabsTrigger, { value: "b" }, "B")),
      createElement(TabsPanel, { value: "a" }, "Panel A"),
      createElement(TabsPanel, { value: "b", tabIndex: -1 }, "Panel B"),
    );
  }
  try {
    act(() => root.render(createElement(Example)));
    const [disabled, a, b] = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    const [panelA, panelB] = host.querySelectorAll<HTMLDivElement>('[role="tabpanel"]');
    expect(disabled.tabIndex).toBe(-1);
    expect(a.tabIndex).toBe(0);
    a.focus();
    act(() => a.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(b);
    expect(b.getAttribute("aria-selected")).toBe("true");
    expect(b.tabIndex).toBe(0);
    expect(a.tabIndex).toBe(-1);
    expect(panelA.hidden).toBe(true);
    expect(panelB.hidden).toBe(false);
    expect(panelB.tabIndex).toBe(-1);
    act(() => b.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(a);
    expect(panelA.hidden).toBe(false);
    expect(panelA.tabIndex).toBe(0);
    expect(panelB.hidden).toBe(true);
    act(() => b.click());
    expect(panelA.hidden).toBe(true);
    expect(panelB.hidden).toBe(false);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
