import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ImgHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearningExperience } from "./learning-experience";
import { DEFINITION, FAILURE_PARAGRAPH, STARTER_TEST } from "./session-content";

vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element -- Native image is the test double for next/image.
  default: ({ unoptimized: _unoptimized, alt, ...props }: ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean }) => <img alt={alt} {...props} />,
}));
vi.mock("./feature-map", () => ({ FeatureMap: () => <p>Additional workspace features</p> }));
vi.mock("./engineering-lab", () => ({ EngineeringLab: () => <div>Engineering building blocks</div> }));

const DRAFT_KEY = "proofgrove-first-test-v1";
const LEGACY_KEY = "proofgrove-eval-plan-v1";
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  // jsdom does not provide the browser's modal behavior. Preserve the native
  // open-state contract so the test can exercise the component's controls.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) { this.open = false; }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  for (const [name, original] of [["showModal", originalShowModal], ["close", originalClose]] as const) {
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

function openTestExercise() {
  fireEvent.click(screen.getByRole("button", { name: "What earns trust?" }));
  fireEvent.click(screen.getByText(/Your turn: write your first test/));
}

describe("the simplified teaching session", () => {
  it("offers five topics while showing only the current teaching screen", () => {
    render(<LearningExperience />);
    const navigation = screen.getByRole("navigation", { name: "Session topics" });
    expect(within(navigation).getAllByRole("button")).toHaveLength(5);
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);

    const topics = [
      ["Why evaluate?", "Did the agent do the right thing?"],
      ["What is evaluation?", "What is an evaluation?"],
      ["Where can it fail?", "Where can an agent fail?"],
      ["How do we test?", "How do you build an evaluation loop?"],
      ["What earns trust?", "What earns trust in production?"],
    ];
    for (const [topic, title] of topics) {
      const button = within(navigation).getByRole("button", { name: topic });
      fireEvent.click(button);
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title);
      expect(screen.getByRole("region", { name: title })).toBeTruthy();
      expect(button.getAttribute("aria-current")).toBe("step");
      expect(screen.queryByText(DEFINITION) !== null).toBe(topic === "What is evaluation?");
      expect(screen.queryByText(FAILURE_PARAGRAPH) !== null).toBe(topic === "Where can it fail?");
    }
  });

  it("retains revealed refund evidence when the presenter goes Next and Back", () => {
    render(<LearningExperience />);
    expect(screen.queryByText("Expected AED 250 · recorded USD 250")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal the refund evidence" }));
    expect(screen.getByRole("status").textContent).toContain("Expected AED 250 · recorded USD 250");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(DEFINITION)).toBeTruthy();
    expect(screen.queryByText("Expected AED 250 · recorded USD 250")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("status").textContent).toContain("Expected AED 250 · recorded USD 250");
    expect(screen.getByRole("button", { name: "Hide the refund evidence" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("opens and closes an enlarged diagram and supplies editable source downloads", () => {
    render(<LearningExperience />);
    fireEvent.click(screen.getByRole("button", { name: "What is evaluation?" }));
    const dialog = screen.getAllByRole("dialog", { hidden: true }).find(element => element.getAttribute("aria-label") === "Behavior, expectation, judgment enlarged") as HTMLDialogElement;
    expect(dialog.open).toBe(false);

    const source = screen.getByRole("link", { name: "Excalidraw source for Behavior, expectation, judgment" });
    expect(source.getAttribute("href")).toBe("/learning/session/diagrams/01-what-is-eval.excalidraw");
    expect(source.hasAttribute("download")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Expand diagram: Behavior, expectation, judgment" }));
    expect(dialog.open).toBe(true);
    expect(screen.getByRole("dialog", { name: "Behavior, expectation, judgment enlarged" })).toBe(dialog);
    const enlargedSource = within(dialog).getByRole("link", { name: "Download editable Excalidraw source" });
    expect(enlargedSource.getAttribute("href")).toBe(source.getAttribute("href"));
    expect(enlargedSource.hasAttribute("download")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close enlarged diagram" }));
    expect(dialog.open).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Expand diagram: Behavior, expectation, judgment" }));
    fireEvent.click(dialog);
    expect(dialog.open).toBe(false);
  });

  it("restores all four current fields and saves edits without replacing them with the starter", async () => {
    const draft = {
      request: "Cancel my Friday booking",
      expectation: "Cancel only my booking",
      evidence: "Permission check and booking status",
      blocker: "A different booking changes",
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ ...STARTER_TEST, input: "An older draft" }));
    render(<LearningExperience />);
    openTestExercise();
    for (const [label, value] of Object.entries(draft)) {
      await waitFor(() => expect((screen.getByRole("textbox", { name: new RegExp(`^${label}`, "i") }) as HTMLTextAreaElement).value).toBe(value));
    }
    fireEvent.change(screen.getByRole("textbox", { name: /^Blocker/ }), { target: { value: "The permission check is missing" } });
    await waitFor(() => expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!)).toEqual({
      ...draft, blocker: "The permission check is missing",
    }));
    expect((screen.getByRole("button", { name: "Download my test" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("migrates the older plan into the four-field exercise while leaving the old storage intact", async () => {
    const legacy = JSON.stringify({
      system: "A booking assistant", input: "Book the available afternoon slot",
      expectation: "The chosen slot is booked once", evidence: "Saved booking and approval",
      blocker: "No approval", nextChange: "Test retries",
    });
    localStorage.setItem(LEGACY_KEY, legacy);
    render(<LearningExperience />);
    openTestExercise();
    await waitFor(() => expect((screen.getByRole("textbox", { name: /^Request/ }) as HTMLTextAreaElement).value)
      .toBe("Book the available afternoon slot"));
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!)).toEqual({
      request: "Book the available afternoon slot", expectation: "The chosen slot is booked once",
      evidence: "Saved booking and approval", blocker: "No approval",
    });
    fireEvent.change(screen.getByRole("textbox", { name: /^Request/ }), { target: { value: "My revised request" } });
    await waitFor(() => expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).request).toBe("My revised request"));
    expect(localStorage.getItem(LEGACY_KEY)).toBe(legacy);
  });

  it.each(["Request", "Expectation", "Evidence", "Blocker"])("prevents downloading an unfinished test when %s is blank", (label) => {
    render(<LearningExperience />);
    openTestExercise();
    const download = screen.getByRole("button", { name: "Download my test" }) as HTMLButtonElement;
    expect(download.disabled).toBe(false);
    const field = screen.getByRole("textbox", { name: new RegExp(`^${label}`) });
    fireEvent.change(field, { target: { value: " \n " } });
    expect(download.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "A concrete decision" } });
    expect(download.disabled).toBe(false);
  });

  it("reports failed persistence without blocking the learner's local editing and download", async () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Storage quota reached"); });
    render(<LearningExperience />);
    openTestExercise();
    await waitFor(() => expect(screen.getByText("Browser storage is unavailable. You can still edit and download.")).toBeTruthy());
    fireEvent.change(screen.getByRole("textbox", { name: /^Request/ }), { target: { value: "My unsaved request" } });
    expect((screen.getByRole("textbox", { name: /^Request/ }) as HTMLTextAreaElement).value).toBe("My unsaved request");
    expect((screen.getByRole("button", { name: "Download my test" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps an older boundaries link useful by opening How and its POC details", () => {
    window.history.replaceState(null, "", "#lite-boundaries");
    render(<LearningExperience />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("How do you build an evaluation loop?");
    const details = screen.getByText("What is real in this local POC?").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(within(details).getByText(/No live agent, retriever or payment service is invoked/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "How do we test?" }).getAttribute("aria-current")).toBe("step");
  });
});
