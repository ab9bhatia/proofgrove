import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { EvaluationKindChooser } from "./kind-chooser";
vi.mock("./prepared-evaluation-starter", () => ({ PreparedEvaluationStarter: () => null }));

describe("evaluation kind entry", () => {
  it("prioritizes systems to invoke while preserving the supplied-response path", () => {
    render(<EvaluationKindChooser searchParams={new URLSearchParams("dataset=my-cases&assignment=policy&assignmentVersion=2")} />);
    const primary = within(screen.getByRole("navigation", { name: "What are you evaluating?" })).getAllByRole("link");
    expect(primary).toHaveLength(2);
    expect(primary[0]!.textContent).toContain("LLM");
    expect(primary[1]!.textContent).toContain("Agent");
    const secondary = screen.getByText("Evaluate responses you already have");
    expect(secondary.closest("details")?.open).toBe(false);
    expect(screen.getByRole("link", { name: "Existing responses" }).closest("details")?.open).toBe(false);
    fireEvent.click(secondary);
    expect(screen.getByRole("link", { name: "Existing responses" }).getAttribute("href")).toBe("/evaluate?dataset=my-cases&assignment=policy&assignmentVersion=2&type=provided");
  });
});
