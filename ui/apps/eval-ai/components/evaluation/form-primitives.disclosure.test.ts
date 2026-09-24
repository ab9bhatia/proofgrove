/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { detailsToggleHandler, Disclosure } from "./form-primitives";

afterEach(() => {
  cleanup();
});

function details(): HTMLDetailsElement {
  const element = document.querySelector("details");
  if (!element) throw new Error("no disclosure rendered");
  return element as HTMLDetailsElement;
}

describe("optional-cluster disclosure", () => {
  it("starts closed so the primary path is what the page shows first", () => {
    render(
      createElement(Disclosure, { label: "Add run label" }, createElement("input", { "aria-label": "Run label" })),
    );

    expect(details().open).toBe(false);
    expect(screen.getByText("Add run label")).toBeTruthy();
  });

  it("opens and closes on the trigger", async () => {
    render(
      createElement(Disclosure, { label: "Add run label" }, createElement("input", { "aria-label": "Run label" })),
    );

    fireEvent.click(screen.getByText("Add run label"));
    await waitFor(() => expect(details().open).toBe(true));
    // Pairs with the force-open case below: without this, that test would pass on a
    // disclosure the trigger simply never closes.
    fireEvent.click(screen.getByText("Add run label"));
    await waitFor(() => expect(details().open).toBe(false));
  });

  it("reports a set value on the closed trigger", () => {
    render(
      createElement(
        Disclosure,
        { label: "Add run label", summary: "baseline v2" },
        createElement("input", { "aria-label": "Run label" }),
      ),
    );

    // A collapsed control that is configured must still say so, or the disclosure
    // hides state the user cannot see they set.
    expect(details().open).toBe(false);
    expect(screen.getByText("baseline v2").classList.contains("group-open:hidden")).toBe(true);
  });

  it("omits the summary line entirely when there is nothing set", () => {
    const { container } = render(
      createElement(
        Disclosure,
        { label: "Add run label", summary: null },
        createElement("input", { "aria-label": "Run label" }),
      ),
    );

    expect(container.querySelectorAll("summary span span")).toHaveLength(1);
  });

  it("holds a force-opened disclosure open when the user tries to close it", () => {
    // React's own value is already `true`, so it sees nothing to reconcile and the DOM
    // would stay shut — taking the error the force-open exists to reveal with it.
    // Reopening the node directly is what actually holds it. Used by Advanced settings
    // while the tracing control is reporting an error.
    const element = document.createElement("details");
    element.open = false;
    const onOpenChange = vi.fn();

    detailsToggleHandler(true, onOpenChange)({ currentTarget: element } as never);

    expect(element.open).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("reports the new state normally when nothing is forcing it open", () => {
    const element = document.createElement("details");
    element.open = false;
    const onOpenChange = vi.fn();

    detailsToggleHandler(false, onOpenChange)({ currentTarget: element } as never);

    expect(element.open).toBe(false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
