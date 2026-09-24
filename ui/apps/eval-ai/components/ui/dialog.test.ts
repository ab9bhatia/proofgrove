import { describe, expect, it } from "vitest";
import {
  DIALOG_FOCUSABLE_SELECTOR,
  dialogKeyAction,
  lockBodyScroll,
  type DialogKeyAction,
} from "./dialog";

describe("dialog keyboard contract", () => {
  it("closes on Escape from anywhere", () => {
    expect(dialogKeyAction("Escape", false, 0, 3)).toEqual({ type: "close" });
    expect(dialogKeyAction("Escape", true, 2, 3)).toEqual({ type: "close" });
    // Even with nothing focusable, Escape must still close the dialog.
    expect(dialogKeyAction("Escape", false, -1, 0)).toEqual({ type: "close" });
  });

  it("wraps Tab from the last element to the first", () => {
    expect(dialogKeyAction("Tab", false, 2, 3)).toEqual({ type: "focus", index: 0 });
  });

  it("wraps Shift+Tab from the first element to the last", () => {
    expect(dialogKeyAction("Tab", true, 0, 3)).toEqual({ type: "focus", index: 2 });
  });

  it("lets the browser handle Tab in the middle of the cycle", () => {
    expect(dialogKeyAction("Tab", false, 0, 3)).toEqual({ type: "none" });
    expect(dialogKeyAction("Tab", false, 1, 3)).toEqual({ type: "none" });
    expect(dialogKeyAction("Tab", true, 2, 3)).toEqual({ type: "none" });
  });

  it("pulls focus back inside when it escaped the panel", () => {
    expect(dialogKeyAction("Tab", false, -1, 3)).toEqual({ type: "focus", index: 0 });
    expect(dialogKeyAction("Tab", true, -1, 3)).toEqual({ type: "focus", index: 2 });
  });

  it("traps Tab when the panel has no focusable elements", () => {
    // Zero focusables must not let browser focus escape to background
    // controls: the action is an explicit trap (preventDefault + panel focus).
    expect(dialogKeyAction("Tab", false, -1, 0)).toEqual({ type: "trap" });
    expect(dialogKeyAction("Tab", true, -1, 0)).toEqual({ type: "trap" });
    expect(dialogKeyAction("a", false, -1, 0)).toEqual({ type: "none" });
  });

  it("ignores keys outside the dialog contract", () => {
    expect(dialogKeyAction("Enter", false, 0, 3)).toEqual({ type: "none" });
    expect(dialogKeyAction("ArrowDown", false, 1, 3)).toEqual({ type: "none" });
    expect(dialogKeyAction(" ", false, 2, 3)).toEqual({ type: "none" });
  });

  it("keeps a full Tab cycle inside the trap and back to the start", () => {
    // Simulate the trap over three focusable elements the way the component
    // applies it: the browser advances focus except where the contract wraps.
    const count = 3;
    const advance = (index: number, shiftKey: boolean): number => {
      const action: DialogKeyAction = dialogKeyAction("Tab", shiftKey, index, count);
      if (action.type === "focus") return action.index;
      return shiftKey ? index - 1 : index + 1; // browser default
    };
    expect([0, 1, 2].reduce((index) => advance(index, false), 0)).toBe(0);
    expect([0, 1, 2].reduce((index) => advance(index, true), 0)).toBe(0);
  });
});

describe("dialog body scroll lock", () => {
  it("hides overflow and restores the previous inline value", () => {
    const style = { overflow: "auto" };
    const unlock = lockBodyScroll(style);
    expect(style.overflow).toBe("hidden");
    unlock();
    expect(style.overflow).toBe("auto");
  });

  it("restores an empty inline overflow instead of pinning it to hidden", () => {
    const style = { overflow: "" };
    const unlock = lockBodyScroll(style);
    expect(style.overflow).toBe("hidden");
    unlock();
    expect(style.overflow).toBe("");
  });
});

describe("dialog focusable selector", () => {
  it("covers interactive elements and excludes disabled or untabbable ones", () => {
    const parts = DIALOG_FOCUSABLE_SELECTOR.split(", ");
    expect(parts).toContain("button:not([disabled])");
    expect(parts).toContain("a[href]");
    expect(parts).toContain("input:not([disabled])");
    expect(parts).toContain("select:not([disabled])");
    expect(parts).toContain("textarea:not([disabled])");
    expect(parts).toContain("summary");
    expect(parts).toContain('[tabindex]:not([tabindex="-1"])');
  });
});
