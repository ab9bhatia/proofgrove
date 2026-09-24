/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PromptVersionRail } from "@/components/catalog/prompt-version-rail";
import type { PromptVersion } from "@/lib/api";

function version(overrides: Partial<PromptVersion> = {}): PromptVersion {
  return {
    prompt_id: "support",
    version: 2,
    tenant_id: "tenant-classroom",
    name: "Support",
    content: "Be concise.",
    content_hash: "abc",
    labels: [],
    ...overrides,
  };
}

function rail(props: Partial<Parameters<typeof PromptVersionRail>[0]> = {}) {
  return render(
    createElement(PromptVersionRail, {
      versions: [version({ version: 2 }), version({ version: 1 })],
      openVersion: 2,
      productionVersion: null,
      onOpen: vi.fn(),
      ...props,
    }),
  );
}

afterEach(() => {
  cleanup();
});

describe("PromptVersionRail", () => {
  it("marks the open version, and only that one", () => {
    rail();
    const rows = screen.getAllByRole("button");
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
    expect(rows[1]?.getAttribute("aria-current")).toBeNull();
  });

  it("opens the version that was clicked", () => {
    const onOpen = vi.fn();
    rail({ onOpen });
    fireEvent.click(screen.getAllByRole("button")[1]!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]?.[0]?.version).toBe(1);
  });

  it("makes the whole row the control, not the version number alone", () => {
    // Same failure the dataset picker shipped: a control nested inside one cell
    // leaves the rest of a clickable-looking row inert.
    rail();
    const row = screen.getAllByRole("button")[0]!;
    expect(row.textContent).toContain("v2");
    expect(row.textContent).toContain("Be concise.");
  });

  it("shows which version production points at", () => {
    rail({ productionVersion: 1 });
    const rows = screen.getAllByRole("button");
    expect(rows[1]?.textContent).toContain("production");
    expect(rows[0]?.textContent).not.toContain("production");
  });

  it("says what changed and when, not just a version number", () => {
    // A history of bare numbers records that something happened, never what.
    rail({
      versions: [
        version({ version: 2, description: "Ask for citations.", created_at: "2026-08-30T10:00:00Z", created_by: "ahmed" }),
      ],
      openVersion: 2,
    });
    const row = screen.getAllByRole("button")[0]!;
    expect(row.textContent).toContain("Ask for citations.");
    expect(row.textContent).toContain("ahmed");
  });

  it("falls back to the prompt text when a version carries no note", () => {
    // The note is optional, so an unannotated version still says something
    // useful rather than showing an empty line.
    rail({ versions: [version({ version: 2, content: "Be concise." })], openVersion: 2 });
    expect(screen.getAllByRole("button")[0]!.textContent).toContain("Be concise.");
  });

  it("counts the versions it lists", () => {
    rail();
    expect(screen.getByText("2 versions")).toBeTruthy();
  });
});
