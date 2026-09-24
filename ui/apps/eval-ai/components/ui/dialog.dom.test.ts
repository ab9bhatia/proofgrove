/** @vitest-environment jsdom */

import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Dialog, type DialogProps } from "./dialog";
import { OverlayConfirmDialog } from "./confirm-dialog";

it("skips a hidden button when wrapping Tab focus", () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  try {
    act(() =>
      root.render(
        createElement(
          Dialog,
          {
            labelledBy: "t",
            scrimLabel: "close",
            onClose,
          } as unknown as DialogProps,
          createElement("button", { key: "first", id: "first" }, "First"),
          createElement(
            "div",
            { key: "wrap", hidden: true },
            createElement("button", { id: "hidden-btn" }, "Hidden"),
          ),
          createElement("button", { key: "last", id: "last" }, "Last"),
          createElement("div", { key: "css-hidden", style: { display: "none" } },
            createElement("button", null, "Hidden trailing button")),
        ),
      ),
    );
    const first = document.getElementById("first")!;
    const last = document.getElementById("last")!;
    last.focus();
    act(() =>
      last.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      ),
    );
    // Wrapping from the last visible trigger must land back on the first
    // visible one — the hidden button in between is never a valid target.
    expect(document.activeElement).toBe(first);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("lets only the top dialog handle keys and restores the drawer after closing it", () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const closeDrawer = vi.fn();
  const closeConfirmation = vi.fn();
  const dialog = (id: string, onClose: () => void) => createElement(
    Dialog,
    { key: id, labelledBy: id, scrimLabel: id, onClose } as unknown as DialogProps,
    createElement("button", { key: "first", id: `${id}-first` }, "First"),
    createElement("button", { key: "last", id: `${id}-last` }, "Last"),
  );
  const drawer = dialog("drawer", closeDrawer);
  try {
    act(() => root.render(drawer));
    const trigger = document.getElementById("drawer-first")!;
    trigger.focus();
    act(() => root.render(createElement(Fragment, null, drawer, dialog("confirmation", closeConfirmation))));
    const first = document.getElementById("confirmation-first")!;
    first.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => first.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(false);
    const last = document.getElementById("confirmation-last")!;
    last.focus();
    act(() => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(first);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(closeConfirmation).toHaveBeenCalledOnce();
    expect(closeDrawer).not.toHaveBeenCalled();
    act(() => root.render(createElement(Fragment, null, drawer)));
    expect(document.activeElement).toBe(trigger);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(closeDrawer).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
  expect(document.body.style.overflow).toBe("");
});


it("blocks Escape and scrim cancellation only while confirmation is pending", () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onCancel = vi.fn();
  try {
    for (const pending of [false, true, false]) {
      onCancel.mockClear();
      act(() => root.render(createElement(OverlayConfirmDialog, {
        title: "Delete?", description: "This cannot be undone", confirmLabel: "Delete",
        pending, onCancel, onConfirm: () => undefined,
      })));
      act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close confirmation"]')!.click());
      expect(onCancel).toHaveBeenCalledTimes(pending ? 0 : 2);
    }
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
