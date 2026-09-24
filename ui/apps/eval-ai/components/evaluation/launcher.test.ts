import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => "/evaluate",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => searchParams,
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
    onClick?: () => void;
  }) => createElement("a", { href, ...props }, children),
}));

vi.mock("@/lib/api", () => ({
  api: {
    listDatasets: vi.fn(() => Promise.resolve([])),
    tenant: vi.fn(() => Promise.resolve({ tenant_id: "tenant-classroom" })),
  },
  evaluationApi: { getRunConfiguration: vi.fn() },
  fullName: (dataset: { name: string; version_number?: number }) =>
    dataset.version_number ? `${dataset.name}:v${dataset.version_number}` : dataset.name,
}));

vi.mock("@/components/evaluation/workbench", () => ({
  // Surfaces the seed the launcher hands over, which is the whole point of these cases.
  EvaluationWorkbench: ({ kind }: { kind: string | null }) =>
    createElement("div", { "data-testid": "workbench", "data-kind": String(kind) }, "workbench"),
}));

import {
  EvaluationLauncher,
  evaluationKindForLaunch,
  evaluationKindForResponseSource,
} from "./launcher";

describe("evaluation launcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParams = new URLSearchParams();
  });

  it("restores the evaluation kind from the persisted response source", () => {
    expect(evaluationKindForResponseSource("agent")).toBe("agent");
    expect(evaluationKindForResponseSource("llm")).toBe("llm");
    expect(evaluationKindForResponseSource("provided")).toBe("provided");
    expect(evaluationKindForResponseSource("baseline")).toBe("baseline");
    expect(evaluationKindForLaunch("llm", evaluationKindForResponseSource("agent"))).toBe(
      "agent",
    );
    expect(evaluationKindForLaunch("llm", evaluationKindForResponseSource("baseline"))).toBe(
      "baseline",
    );
  });

  it("hands an explicit ?type= straight to the workbench, seeding nothing from the dataset", () => {
    // Precedence, not preference: whatever the rows of `agent-traces` are eligible for, a URL
    // that names the kind is the user having already answered step 1.
    searchParams = new URLSearchParams("dataset=agent-traces%3Av1&type=llm");
    const html = renderToStaticMarkup(createElement(EvaluationLauncher));

    expect(html).toContain('data-testid="workbench"');
    expect(html).toContain('data-kind="llm"');
  });

  it("refuses a baseline rerun before configuration restoration can fail", () => {
    searchParams = new URLSearchParams("type=baseline&rerun=1&fromRun=baseline-run");

    const html = renderToStaticMarkup(createElement(EvaluationLauncher));

    expect(html).toContain("Baseline runs are internal pipeline checks");
    expect(html).not.toContain("What are you evaluating?");
    expect(html).not.toContain('data-testid="workbench"');
  });

  it("keeps the legacy /evaluate/agent redirect winning too", () => {
    // `LegacyEvaluationRedirect` lands here as `?type=agent`; it must survive the same way.
    searchParams = new URLSearchParams("dataset=prompt-only%3Av3&type=agent");

    expect(renderToStaticMarkup(createElement(EvaluationLauncher))).toContain('data-kind="agent"');
  });

  it("does not render a fake multi-stage progress strip on the entry screen", () => {
    const html = renderToStaticMarkup(createElement(EvaluationLauncher));
    // Setup has not started, so showing its progress would claim progress that does
    // not exist.
    expect(html).not.toContain('aria-label="Evaluation setup progress"');
    expect(html).toContain("What are you evaluating?");
  });

  it("offers each kind as a real link, so a choice can be deep-linked", () => {
    const html = renderToStaticMarkup(createElement(EvaluationLauncher));
    expect(html).toContain('href="/evaluate?type=llm"');
    expect(html).toContain('href="/evaluate?type=agent"');
    expect(html).toContain('href="/evaluate?type=provided"');
    expect(html).toContain("Existing responses");
  });
});
