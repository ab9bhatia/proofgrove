import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunComparison, describeCounts } from "./run-comparison";

describe("Nova evidence comparison", () => {
  it("reports unknown and N/A alongside scored coverage", () => {
    expect(describeCounts({ PASS: 10, FAIL: 0, UNKNOWN: 2, NA: 0, scored: 10, applicable: 12 })).toContain("2 unknown · 0 N/A — 10/12 applicable scored");
  });
  it("reveals independent contract and outcome judgments, and switches cases", () => {
    render(<RunComparison />);
    fireEvent.click(screen.getByText("Compare two versions on the same 12 cases"));
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal the contract checks" }));
    expect(screen.getByRole("status").textContent).toContain("Missing final-state evidence stays unknown");
    const table = screen.getByRole("table", { name: "n-05: answers and checks" });
    const request = within(table).getByRole("row", { name: /Request contract/ });
    expect(within(request).getAllByText("FAIL")).toHaveLength(2);
    const outcome = within(table).getByRole("row", { name: /Required \/ prohibited effects/ });
    expect(within(outcome).getByText("UNKNOWN")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Inspect a case" }), { target: { value: "n-02" } });
    const freshness = within(screen.getByRole("table", { name: "n-02: answers and checks" })).getByRole("row", { name: /Effective source version/ });
    expect(within(freshness).getByText("UNKNOWN")).toBeTruthy();
    expect(within(freshness).getByText("PASS")).toBeTruthy();
  });
});
