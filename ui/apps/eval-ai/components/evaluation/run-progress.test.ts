import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EvaluationRunProgress } from "./run-progress";

describe("evaluation run progress", () => {
  it.each([
    ["cancelled", "Stopped", "The run was stopped."],
    ["blocked", "Blocked", "The run was blocked and could not complete."],
    ["failed", "Evaluation stopped", "The run could not be completed."],
  ])("shows %s as terminal without queued progress", (status, title, fallback) => {
    const renderStatus = (errorMessage?: string) => renderToStaticMarkup(
      createElement(EvaluationRunProgress, { status, runId: "terminal-run", errorMessage }),
    );
    const html = renderStatus("The recorded reason for stopping");
    expect(html).toContain(title);
    expect(html).toContain("The recorded reason for stopping");
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("queued");
    expect(renderStatus()).toContain(fallback);
  });

  it("shows an indeterminate queued progress state", () => {
    const html = renderToStaticMarkup(
      createElement(EvaluationRunProgress, {
        status: "pending",
        runId: "run-123",
      }),
    );

    expect(html).toContain("Preparing the evaluation");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuetext="Queued"');
    expect(html).not.toContain("aria-valuenow");
  });

  it("advances the visual phase when scoring begins", () => {
    const html = renderToStaticMarkup(
      createElement(EvaluationRunProgress, {
        status: "running",
        runId: "run-456",
      }),
    );

    expect(html).toContain("Evaluating dataset rows");
    expect(html).toContain('aria-valuetext="Evaluating dataset rows"');
    expect(html).toContain("Queued");
    expect(html).toContain("Evaluating");
    expect(html).toContain("Report");
  });

  it("keeps scoring in progress while waiting for completed traces", () => {
    const html = renderToStaticMarkup(
      createElement(EvaluationRunProgress, {
        status: "awaiting_trace",
        runId: "run-789",
      }),
    );

    expect(html).toContain("Waiting for completed traces");
    expect(html).toContain('aria-valuetext="Waiting for completed traces"');
  });
});
