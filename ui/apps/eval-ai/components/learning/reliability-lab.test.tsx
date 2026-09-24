import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReliabilityLab } from "./reliability-lab";

describe("reliability graph interaction", () => {
  it("changes workflow length and keeps probabilities tied to required steps", () => {
    render(<ReliabilityLab />);
    fireEvent.click(screen.getByText(/Reliability: workflow steps/));
    expect(screen.getByRole("status").textContent).toContain("59.9%");
    expect(screen.getByRole("status").textContent).toContain("90.4%");
    fireEvent.change(screen.getByRole("slider", { name: /Required steps/ }), { target: { value: "20" } });
    expect(screen.getByRole("status").textContent).toContain("35.8%");
    expect(screen.getByRole("status").textContent).toContain("81.8%");
  });
  it("switches to independent complete attempts with its own probability control", () => {
    render(<ReliabilityLab />);
    fireEvent.click(screen.getByText(/Reliability: workflow steps/));
    fireEvent.click(screen.getByRole("button", { name: "Across repeated attempts" }));
    expect(screen.queryByRole("slider", { name: /Required steps/ })).toBeNull();
    const result = screen.getByRole("status");
    expect(result.textContent).toContain("98.4%");
    expect(result.textContent).toContain("42.2%");
    fireEvent.change(screen.getByRole("slider", { name: /Success chance per attempt/ }), { target: { value: "50" } });
    expect(result.textContent).toContain("87.5%");
    expect(result.textContent).toContain("12.5%");
    fireEvent.click(screen.getByText("Read the chart values"));
    const table = screen.getByRole("table", { name: "Illustrative probabilities under the stated assumptions" });
    expect(within(table).getAllByRole("row")).toHaveLength(11);
    expect(screen.getByRole("button", { name: "Across repeated attempts" }).getAttribute("aria-pressed")).toBe("true");
  });
});
