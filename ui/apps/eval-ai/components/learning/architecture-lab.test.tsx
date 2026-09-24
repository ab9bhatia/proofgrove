import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArchitectureLab } from "./architecture-lab";

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function advanceStep() { act(() => { vi.advanceTimersByTime(4800); }); }

function stepButton(name: string) { return screen.getByRole("button", { name }); }

describe("ArchitectureLab", () => {
  it("lets the learner step, inspect a component with a keyboard, and reset", () => {
    render(<ArchitectureLab />);
    expect(screen.getByRole("heading", { name: "Start with a testable expectation" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous architecture step" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next architecture step" }));
    expect(screen.getByRole("heading", { name: "Freeze what this run will measure" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Inspect Measure the result" }), { key: "Enter" });
    expect(screen.getByText(/An answer can preserve most words while changing the meaning/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset architecture walkthrough" }));
    expect(screen.getByRole("heading", { name: "Start with a testable expectation" })).toBeTruthy();
  });

  it("starts only on request, pauses, and stops after the final step", () => {
    vi.useFakeTimers();
    const { container } = render(<ArchitectureLab />);
    act(() => { vi.advanceTimersByTime(30000); });
    expect(screen.getByRole("heading", { name: "Start with a testable expectation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Play architecture walkthrough" }));
    advanceStep();
    expect(screen.getByRole("heading", { name: "Freeze what this run will measure" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause architecture walkthrough" }));
    act(() => { vi.advanceTimersByTime(30000); });
    expect(screen.getByRole("heading", { name: "Freeze what this run will measure" })).toBeTruthy();
    expect(container.querySelector("section")?.dataset.playing).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Play architecture walkthrough" }));
    for (let index = 0; index < 7; index += 1) advanceStep();
    expect(screen.getByRole("heading", { name: "Turn the lesson into a regression test" })).toBeTruthy();
    expect(container.querySelector("section")?.dataset.playing).toBe("false");
    expect((screen.getByRole("button", { name: "Play architecture walkthrough" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("stops its timer and visual motion when the parent disables motion", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<ArchitectureLab motionEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Play architecture walkthrough" }));
    rerender(<ArchitectureLab motionEnabled={false} />);
    act(() => { vi.advanceTimersByTime(30000); });
    expect(screen.getByRole("heading", { name: "Start with a testable expectation" })).toBeTruthy();
    expect(container.querySelector("section")?.dataset.motion).toBe("paused");
    expect(container.querySelector("section")?.dataset.playing).toBe("false");
    expect((screen.getByRole("button", { name: "Play architecture walkthrough" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next architecture step" }));
    expect(screen.getByRole("heading", { name: "Freeze what this run will measure" })).toBeTruthy();
  });

  it("honors the operating system reduced-motion preference", () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: true, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    render(<ArchitectureLab />);
    expect((screen.getByRole("button", { name: "Play architecture walkthrough" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Motion paused · use Back and Next")).toBeTruthy();
  });

  it("separates optional production services and cancels a playing local tour", () => {
    vi.useFakeTimers();
    render(<ArchitectureLab />);
    fireEvent.click(screen.getByRole("button", { name: "Play architecture walkthrough" }));
    fireEvent.click(stepButton("Production expansion"));
    act(() => { vi.advanceTimersByTime(30000); });
    expect(screen.getByText("Separate setup · no services started")).toBeTruthy();
    fireEvent.click(stepButton("Technical components"));
    expect(screen.getByRole("button", { name: "Inspect PostgreSQL" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inspect Temporal + worker" })).toBeTruthy();
    fireEvent.click(stepButton("Local POC"));
    expect(screen.getByRole("heading", { name: "Start with a testable expectation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play architecture walkthrough" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inspect Next.js / BFF :3010" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inspect FastAPI :8010" })).toBeTruthy();
  });

  it("requires correct checkpoints before completion and reports it once", () => {
    const onComplete = vi.fn();
    render(<ArchitectureLab onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: /The candidate automatically passes/ }));
    expect(onComplete).not.toHaveBeenCalled();
    const choices = [
      /Reference-text metrics cannot be computed/,
      /The rows no longer share the same scoring contract/,
      /Read existing responses from the dataset/,
      /We confuse shared words with faithful meaning/,
      /It invents a measurement that was never captured/,
      /A serious individual failure can disappear inside it/,
      /The historical result loses its fixed reference/,
    ];
    choices.forEach((choice, index) => {
      if (index > 0) fireEvent.click(screen.getByRole("button", { name: "Next architecture step" }));
      fireEvent.click(screen.getByRole("button", { name: choice }));
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.getByText("You can now explain the whole loop.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: choices[6] }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
