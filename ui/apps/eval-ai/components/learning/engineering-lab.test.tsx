import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EngineeringLab } from "./engineering-lab";

function renderLab() {
  return render(<EngineeringLab renderDiagram={({ name, title, description }) => <figure data-testid={name}><figcaption>{title}</figcaption><p>{description}</p></figure>} />);
}

describe("the Evaluation Lego Blocks reference", () => {
  it("puts the visible component diagram before the introductory text and explanations", () => {
    const { container } = renderLab();
    const diagram = screen.getByTestId("12-evaluation-questions");
    expect(container.firstElementChild?.firstElementChild).toBe(diagram);
    expect(diagram.closest("details")).toBeNull();
    expect(within(diagram).getByText("Evaluation Lego Blocks")).toBeTruthy();
    const cards = screen.getByRole("list", { name: "Eight evaluation building blocks" });
    expect(within(cards).getAllByRole("listitem")).toHaveLength(8);
    const first = screen.getByText("What do we test?").closest("details") as HTMLDetailsElement;
    expect(first.open).toBe(false);
    fireEvent.click(screen.getByText("What do we test?"));
    expect(first.open).toBe(true);
    expect(within(first).getByText("Agent / LLM / RAG endpoint")).toBeTruthy();
    expect(first.textContent).toContain("saved prompt");
  });

  it("keeps evaluation types on their separate teaching page", () => {
    renderLab();
    expect(screen.queryByText("When do we evaluate, and what can we inspect?")).toBeNull();
    expect(screen.queryByTestId("13-test-combinations")).toBeNull();
  });

  it("omits the removed advanced panels and capability block", () => {
    renderLab();
    for (const label of ["Compare two versions on the same cases", "Walk through one engineering test", "What runs here?", "See the complete evaluation platform", "Compare versions: experiments, A/B tests and shadow traffic"]) expect(screen.queryByText(label)).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getAllByRole("figure")).toHaveLength(1);
  });
});
