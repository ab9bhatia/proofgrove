import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExpectationLab } from "./expectation-lab";

describe("expectations and rubric exercise", () => {
  it("keeps both teaching disclosures closed until opened", () => {
    render(<ExpectationLab />);
    const summary = screen.getByText("Five expectations, five checks");
    const main = summary.closest("details") as HTMLDetailsElement;
    const judgeSummary = screen.getByText("Check the judge");
    const judge = judgeSummary.closest("details") as HTMLDetailsElement;
    expect(main.open).toBe(false);
    expect(judge.open).toBe(false);
    fireEvent.click(summary);
    expect(main.open).toBe(true);
    expect(judge.open).toBe(false);
    fireEvent.click(judgeSummary);
    expect(judge.open).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(judgeSummary);
    expect(judge.open).toBe(false);
  });

  it("reveals an explained rubric preference and lets learners change their choice", () => {
    render(<ExpectationLab />);
    fireEvent.click(screen.getByText("Five expectations, five checks"));
    fireEvent.click(screen.getByText("Check the judge"));
    const answers = screen.getByRole("group", { name: "Choose an answer for the rubric exercise" });
    const answerA = within(answers).getByRole("button", { name: /^Answer A/ });
    const answerB = within(answers).getByRole("button", { name: /^Answer B/ });
    expect(answerA.getAttribute("aria-pressed")).toBe("false");
    expect(answerB.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(answerB);
    expect(answerB.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("You chose B. The authored rubric prefers A.");
    expect(screen.getByRole("status").textContent).toContain("not a live LLM judgment or a measured performance score");
    fireEvent.click(answerA);
    expect(answerA.getAttribute("aria-pressed")).toBe("true");
    expect(answerB.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain("You chose A. The authored rubric prefers A.");
  });

  it("reveals the source-freshness twist after a choice and preserves that choice across disclosure toggles", () => {
    render(<ExpectationLab />);
    fireEvent.click(screen.getByText("Five expectations, five checks"));
    const judgeSummary = screen.getByText("Check the judge");
    fireEvent.click(judgeSummary);
    expect(screen.queryByText("Freshness twist: a grounded answer can still be wrong")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Answer B/ }));
    const twist = screen.getByText("Freshness twist: a grounded answer can still be wrong");
    const disclosure = twist.closest("details") as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    fireEvent.click(twist);
    expect(disclosure.open).toBe(true);
    expect(disclosure.textContent).toContain("authored illustration, not a model run");
    expect(disclosure.textContent).toContain("The source-freshness check fails");
    fireEvent.click(judgeSummary);
    fireEvent.click(judgeSummary);
    expect(screen.getByRole("button", { name: /^Answer B/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^Answer A/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("status").textContent).toContain("You chose B");
  });
});
