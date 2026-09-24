/** @vitest-environment jsdom */

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AddRunsDialog, attachableCandidates } from "./add-runs-dialog";
import type { RunResult } from "@/lib/api";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));

vi.mock("@evalai/shared/ui/button", () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));

afterEach(cleanup);

function run(id: string, overrides: Partial<RunResult> = {}): RunResult {
  return {
    run_id: id,
    status: "completed",
    started_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:01:00Z",
    experiment: {
      experiment_id: "exp-1",
      name: "Exp",
      dataset_version: "ds.v1",
      target_endpoint: "https://example.com",
      scenario: "llm_core",
      market: "global",
      judge_model: "gpt-4o",
      judge_temperature: 0,
      has_ground_truth: true,
      tags: {},
    },
    lineage: {
      comparison_basis_hash: "basis-a",
    },
    ...overrides,
  } as RunResult;
}

describe("AddRunsDialog", () => {
  it("renders per-run attach failure reasons", () => {
    const html = renderToStaticMarkup(
      createElement(AddRunsDialog, {
        workspaceRuns: [run("run-base")],
        searchRuns: async () => ({ items: [run("run-base")], hasMore: false }),
        attaching: false,
        error: {
          message: "One or more runs cannot join this experiment.",
          details: [
            {
              code: "comparison_basis_mismatch",
              field: "run-bad",
              message: "Run run-bad does not share the selected dataset",
            },
          ],
        },
        onClose: () => undefined,
        onAttach: async () => undefined,
      }),
    );

    expect(html).toContain("One or more runs cannot join this experiment.");
    expect(html).toContain("run-bad");
    expect(html).toContain("does not share the selected dataset");
    expect(html).toContain('role="alert"');
  });
});

describe("attachableCandidates", () => {
  const workspace = [run("run-base")];

  it("keeps every eligible run on the page instead of slicing it", () => {
    const page = Array.from({ length: 60 }, (_, index) => run(`run-${index}`));
    expect(attachableCandidates(page, workspace)).toHaveLength(60);
  });

  it("drops already-linked, incomplete and off-basis runs", () => {
    const page = [
      run("run-base"),
      run("run-active", { status: "running" }),
      run("run-other-basis", {
        lineage: { comparison_basis_hash: "basis-b" } as RunResult["lineage"],
      }),
      run("run-ok"),
    ];
    expect(attachableCandidates(page, workspace).map((item) => item.run_id)).toEqual(["run-ok"]);
  });
});


it("keeps an empty workspace's selected basis across searches without hiding alternatives", async () => {
  const a = run("a");
  const b = run("b", { lineage: { comparison_basis_hash: "basis-b" } });
  const onAttach = vi.fn(async () => undefined);
  const searchRuns = vi.fn(async (query: string) => ({ items: query ? [b] : [a, b], hasMore: false }));
  render(createElement(AddRunsDialog, { workspaceRuns: [], searchRuns, onAttach, onClose: vi.fn(), attaching: false, error: null }));
  await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(2));
  fireEvent.click(screen.getAllByRole("checkbox")[0]);
  expect((screen.getAllByRole("checkbox")[1] as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/Different comparison basis/)).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search runs to attach" }), { target: { value: "b" } });
  await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(1));
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Attach 1" }));
  expect(onAttach).toHaveBeenCalledWith(["b"]);
});
