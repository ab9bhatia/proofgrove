import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScenarioLab } from "./scenario-lab";

function reveal(prediction = "Need evidence") {
  fireEvent.click(screen.getByRole("radio", { name: prediction }));
  fireEvent.click(screen.getByRole("button", { name: "Open the evidence" }));
}

function inspectRemainingStages() {
  fireEvent.click(screen.getByRole("button", { name: "Next clue →" }));
  fireEvent.click(screen.getByRole("button", { name: "Next clue →" }));
}

describe("ScenarioLab evidence decisions", () => {
  it("requires a prediction, then changes a verdict only when the fixture claim is corrected", () => {
    render(<ScenarioLab motionEnabled={false} />);
    expect((screen.getByRole("button", { name: "Open the evidence" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("heading", { name: "Fails this case" })).toBeNull();

    reveal("Pass");
    expect(screen.getByRole("heading", { name: "Fails this case" })).toBeTruthy();
    expect(screen.getByText("Your first call: Pass.")).toBeTruthy();
    // Fieldset disabling prevents revising a prediction after seeing the answer.
    expect(screen.getByRole("radio", { name: "Fail" }).matches(":disabled")).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: /Correct the explanation/ }));
    expect(screen.getByRole("heading", { name: "Passes this case" })).toBeTruthy();
    expect(screen.getByText(/No\. sorted\(values\) returns a new sorted list/)).toBeTruthy();
    expect(screen.getByText("2 of 2 checks satisfied")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Correct the explanation/ }));
    expect(screen.getByRole("heading", { name: "Fails this case" })).toBeTruthy();
    expect(screen.getByText("0 of 2 checks satisfied")).toBeTruthy();
  });

  it("distinguishes citation support from source freshness in the fictional RAG case", () => {
    render(<ScenarioLab />);
    fireEvent.click(screen.getByRole("tab", { name: /RAG/ }));
    reveal("Fail");
    expect(screen.getByRole("heading", { name: "Fails this case" })).toBeTruthy();
    expect(screen.getByText("1 of 3 checks satisfied")).toBeTruthy();
    expect(within(screen.getByText("Citation support").closest("li")!).getByText("Pass")).toBeTruthy();
    expect(within(screen.getByText("Current source").closest("li")!).getByText("Fail")).toBeTruthy();
    expect(screen.getByText("Every course policy shown here is fictional.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next clue →" }));
    expect(screen.getByText(/Current policy v2 says Sunday at 20:00 IST/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Retrieve the current policy/ }));
    expect(screen.getByRole("heading", { name: "Passes this case" })).toBeTruthy();
    expect(screen.getByText("3 of 3 checks satisfied")).toBeTruthy();
    expect(screen.getByText(/Your assignment is due Sunday at 20:00 IST/)).toBeTruthy();
  });

  it("separates the successful tool status from a wrong local time, and invites a review of ambiguity", () => {
    render(<ScenarioLab />);
    fireEvent.click(screen.getByRole("tab", { name: /Agent/ }));
    reveal();
    expect(within(screen.getByText("Tool succeeded").closest("li")!).getByText("Pass")).toBeTruthy();
    expect(within(screen.getByText("Requested local time").closest("li")!).getByText("Fail")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Trace: What happened/ }));
    expect(screen.getByText("Created: Friday 23:30 Asia/Kolkata.")).toBeTruthy();
    expect(screen.getByText("Authored sequence for learning. No upstream trace was collected.")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /Use the requested time zone/ }));
    expect(screen.getByText("Created: Friday 18:00 Asia/Kolkata.")).toBeTruthy();
    expect(screen.getByText("Booked for 18:00 Asia/Kolkata (12:30 UTC).")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Eval: Met the expectation/ }));
    expect(screen.getByRole("heading", { name: "Passes this case" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Review: Where is judgment needed/ }));
    expect(screen.queryByText(/Only if an agreed product policy supplies that context/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show reviewer reasoning" }));
    expect(screen.getByText(/Only if an agreed product policy supplies that context/)).toBeTruthy();
    expect(screen.getByText("No calendar is connected and no event is created.")).toBeTruthy();
  });

  it("keeps predictions and corrections separate when switching scenarios, and supports keyboard tabs", () => {
    render(<ScenarioLab />);
    reveal("Fail");
    fireEvent.click(screen.getByRole("checkbox", { name: /Correct the explanation/ }));
    const studyTab = screen.getByRole("tab", { name: /LLM/ });
    studyTab.focus();
    fireEvent.keyDown(studyTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /RAG/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /RAG/ }));
    expect((screen.getByRole("button", { name: "Open the evidence" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("heading", { name: "Passes this case" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("tab", { name: /RAG/ }), { key: "Home" });
    expect(screen.getByRole("heading", { name: "Passes this case" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Correct the explanation/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Your first call: Fail.")).toBeTruthy();
  });

  it("counts inspected evidence, not green verdicts, and reports completion once", async () => {
    const onComplete = vi.fn();
    render(<ScenarioLab onComplete={onComplete} />);
    reveal();
    fireEvent.click(screen.getByRole("checkbox", { name: /Correct the explanation/ }));
    expect(onComplete).not.toHaveBeenCalled();
    inspectRemainingStages();
    expect(screen.getByLabelText("1 of 3 scenarios explored")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /RAG/ }));
    reveal();
    inspectRemainingStages();
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: /Agent/ }));
    reveal();
    inspectRemainingStages();
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(screen.getByText("You inspected all three cases.")).toBeTruthy();
    // An unchanged failing fixture can still be fully understood.
    expect(screen.getByRole("heading", { name: "Fails this case" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Use the requested time zone/ }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("resets the active exercise without erasing another scenario’s work", () => {
    render(<ScenarioLab />);
    reveal("Fail");
    inspectRemainingStages();
    fireEvent.click(screen.getByRole("tab", { name: /RAG/ }));
    reveal();
    fireEvent.click(screen.getByRole("button", { name: "Try this case again" }));
    expect((screen.getByRole("button", { name: "Open the evidence" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("1 of 3 scenarios explored")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /LLM/ }));
    expect(screen.getByText("Your first call: Fail.")).toBeTruthy();
    expect(screen.getByText("Evidence 3 of 3")).toBeTruthy();
  });
});
