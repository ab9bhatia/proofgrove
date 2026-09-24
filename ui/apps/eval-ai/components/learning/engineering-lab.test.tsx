import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EngineeringLab } from "./engineering-lab";

vi.mock("./run-comparison", () => ({ RunComparison: () => <div>Run comparison panel</div> }));

function renderLab() {
  return render(<EngineeringLab renderDiagram={({ name, title, description }) => <figure data-testid={name}><figcaption>{title}</figcaption><p>{description}</p></figure>} />);
}

function expectSelected(name: string) {
  const tab = screen.getByRole("tab", { name });
  expect(tab.getAttribute("aria-selected")).toBe("true");
  expect(tab.tabIndex).toBe(0);
  const panel = screen.getByRole("tabpanel", { name });
  expect(panel.id).toBe(tab.getAttribute("aria-controls"));
  expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
  expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  for (const other of screen.getAllByRole("tab").filter(item => item !== tab)) {
    expect(other.getAttribute("aria-selected")).toBe("false");
    expect(other.tabIndex).toBe(-1);
  }
  return tab;
}

describe("engineering lesson tabs", () => {
  it("starts with only the building-block panel and collapsed explanations", () => {
    renderLab();
    expect(within(screen.getByRole("tablist", { name: "Evaluation engineering" })).getAllByRole("tab")).toHaveLength(3);
    const tab = expectSelected("Building blocks");
    expect(tab).toBeTruthy();
    expect(screen.getByTestId("06-engineering-blocks")).toBeTruthy();
    expect(screen.queryByTestId("07-otel-evidence")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    const example = screen.getByText("Walk through one engineering test").closest("details") as HTMLDetailsElement;
    expect(example.open).toBe(false);
    expect(screen.queryByRole("button", { name: /run|execute/i })).toBeNull();
  });

  it("switches panels by click and keeps the local-integration boundary visible", () => {
    renderLab();
    fireEvent.click(screen.getByRole("tab", { name: "Traces & OTel" }));
    expectSelected("Traces & OTel");
    expect(screen.queryByTestId("06-engineering-blocks")).toBeNull();
    expect(screen.getByTestId("07-otel-evidence")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Engineering features in this local lab" }).textContent).toContain("runtime action enforcement are not installed");
    fireEvent.click(screen.getByRole("tab", { name: "Choose a test" }));
    expectSelected("Choose a test");
    expect(screen.queryByTestId("07-otel-evidence")).toBeNull();
    expect(screen.getByRole("table", { name: "Two axes for choosing a test" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Building blocks" }));
    expectSelected("Building blocks");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("moves focus and selection with arrows, wraps, and supports Home and End", () => {
    renderLab();
    const building = screen.getByRole("tab", { name: "Building blocks" });
    building.focus();
    fireEvent.keyDown(building, { key: "ArrowRight" });
    expect(document.activeElement).toBe(expectSelected("Traces & OTel"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(expectSelected("Choose a test"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(expectSelected("Building blocks"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(expectSelected("Choose a test"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(expectSelected("Building blocks"));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expectSelected("Building blocks");
  });

  it("keeps the numbered harness in its own disclosure and lets it open and close", () => {
    renderLab();
    fireEvent.click(screen.getByRole("tab", { name: "Choose a test" }));
    const summary = screen.getByText("See the complete evaluation platform");
    const disclosure = summary.closest("details") as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    expect(screen.getByTestId("08-evaluation-harness").closest("details")).toBe(disclosure);
    fireEvent.click(summary);
    expect(disclosure.open).toBe(true);
    expect(screen.getByRole("figure")).toBe(screen.getByTestId("08-evaluation-harness"));
    fireEvent.click(summary);
    expect(disclosure.open).toBe(false);
  });
});
