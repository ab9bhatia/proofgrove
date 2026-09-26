import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ImgHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearningExperience } from "./learning-experience";
import { DEFINITION } from "./session-content";

vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element -- Native image is the test double for next/image.
  default: ({ unoptimized: _unoptimized, alt, ...props }: ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean }) => <img alt={alt} {...props} />,
}));
vi.mock("./engineering-lab", () => ({ EngineeringLab: () => <div>Engineering building blocks</div> }));

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

beforeEach(() => {
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

describe("the simplified teaching session", () => {
  it("offers five topics while showing only the current teaching screen", () => {
    render(<LearningExperience />);
    const navigation = screen.getByRole("navigation", { name: "Session topics" });
    expect(within(navigation).getAllByRole("button")).toHaveLength(5);
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);

    const topics = [
      ["Overview", "Today’s session: evaluation with Proofgrove"],
      ["Why evaluate?", "Did the agent do the right thing?"],
      ["What is evaluation?", "What is an evaluation?"],
      ["Evaluation Lego Blocks", "Evaluation Lego Blocks"],
      ["Types of evaluation", "Types of evaluation"],
    ];
    for (const [topic, title] of topics) {
      const button = within(navigation).getByRole("button", { name: topic });
      fireEvent.click(button);
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title);
      expect(screen.getByRole("region", { name: title })).toBeTruthy();
      expect(button.getAttribute("aria-current")).toBe("step");
      expect(screen.queryByText(DEFINITION) !== null).toBe(topic === "What is evaluation?");
    }
  });

  it("starts with the four outcomes and scope before the example", () => {
    render(<LearningExperience />);
    expect(screen.getByRole("button", { name: "Overview" }).getAttribute("aria-current")).toBe("step");
    const outcomes = screen.getByRole("region", { name: "By the end of this session" });
    expect(within(outcomes).getAllByRole("listitem")).toHaveLength(4);
    expect(within(outcomes).getByRole("heading", { name: "Evaluate an agent end to end" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "What we won’t cover" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reveal the refund evidence" })).toBeNull();
    expect(screen.queryByRole("button", { name: "What earns trust?" })).toBeNull();
  });

  it.each(["trust", "takeaways", "average-trap"])("redirects retired #%s to Overview", (hash) => {
    window.history.replaceState(null, "", `#${hash}`);
    render(<LearningExperience />);
    expect(window.location.hash).toBe("#overview");
    expect(screen.getByRole("button", { name: "Overview" }).getAttribute("aria-current")).toBe("step");
    expect(screen.queryByRole("button", { name: "What earns trust?" })).toBeNull();
  });

  it("moves from Lego Blocks to Types, then the golden dataset, within fifteen minutes", () => {
    render(<LearningExperience />);
    fireEvent.click(screen.getByRole("button", { name: "Evaluation Lego Blocks" }));
    expect(screen.getByText("Minutes 8–12 · the building blocks")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open Golden dataset" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(window.location.hash).toBe("#types");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Types of evaluation");
    expect(screen.getByText("Minutes 12–15 · two independent choices")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Golden dataset" }).getAttribute("href")).toBe("/datasets");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(window.location.hash).toBe("#how");
  });

  it.each(["/", "/learn"])("opens the new types bookmark under %s", (path) => {
    window.history.replaceState(null, "", `${path}#types`);
    render(<LearningExperience />);
    expect(screen.getByRole("button", { name: "Types of evaluation" }).getAttribute("aria-current")).toBe("step");
    expect(screen.getByRole("heading", { name: "Where do the cases come from?" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What evidence can we check?" })).toBeTruthy();
    expect(screen.queryByText("Engineering building blocks")).toBeNull();
  });

  it("opens Evaluation Lego Blocks for an older workflow-failure bookmark", () => {
    window.history.replaceState(null, "", "#where");
    render(<LearningExperience />);
    expect(screen.getByRole("button", { name: "Evaluation Lego Blocks" }).getAttribute("aria-current")).toBe("step");
    expect(screen.queryByRole("button", { name: "Where can it fail?" })).toBeNull();
  });

  it("retains revealed refund evidence when the presenter goes Next and Back", () => {
    render(<LearningExperience />);
    fireEvent.click(screen.getByRole("button", { name: "Why evaluate?" }));
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
    const dialog = screen.getAllByRole("dialog", { hidden: true }).find(element => element.getAttribute("aria-label") === "One response. Two expectations. enlarged") as HTMLDialogElement;
    expect(dialog.open).toBe(false);

    const source = screen.getByRole("link", { name: "Excalidraw source for One response. Two expectations." });
    expect(source.getAttribute("href")).toBe("/learning/session/diagrams/11-evaluation-basics.excalidraw");
    expect(source.hasAttribute("download")).toBe(true);
    expect(screen.getAllByAltText(/A notice says applications close on 30 September/)[0].getAttribute("alt")).toContain("correct date, fail; one sentence, pass");
    expect(screen.getByRole("link", { name: "Anthropic’s explanation of tasks, responses and grading" }).getAttribute("href")).toBe("https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents");

    fireEvent.click(screen.getByRole("button", { name: "Expand diagram: One response. Two expectations." }));
    expect(dialog.open).toBe(true);
    expect(screen.getByRole("dialog", { name: "One response. Two expectations. enlarged" })).toBe(dialog);
    const enlargedSource = within(dialog).getByRole("link", { name: "Download editable Excalidraw source" });
    expect(enlargedSource.getAttribute("href")).toBe(source.getAttribute("href"));
    expect(enlargedSource.hasAttribute("download")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close enlarged diagram" }));
    expect(dialog.open).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Expand diagram: One response. Two expectations." }));
    fireEvent.click(dialog);
    expect(dialog.open).toBe(false);
  });

  it("keeps older links useful without restoring removed POC sections", () => {
    window.history.replaceState(null, "", "#lite-boundaries");
    render(<LearningExperience />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Evaluation Lego Blocks");
    for (const label of ["What is real in this local POC?", "How do the dataset formats differ?", "Where can a workflow go wrong?", "Revisit the basic evaluation flow", "Test five real-world edge cases", "See all 12 Nova cases in the lab", "How is the local lab built?", "Explore the evaluation features"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Evaluation Lego Blocks" }).getAttribute("aria-current")).toBe("step");
  });
});
