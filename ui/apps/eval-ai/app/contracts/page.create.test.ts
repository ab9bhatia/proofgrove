/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams("tab=profiles"),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => navigation.params,
}));
vi.mock("@/components/proofgrove-gate", () => ({
  ProofgroveGate: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/api", () => ({
  api: { tenant: vi.fn() },
  evaluationApi: { listMetrics: vi.fn() },
  platformApi: {
    listAssignments: vi.fn(),
    listProfiles: vi.fn(),
    listGatePolicies: vi.fn(),
    capabilities: vi.fn(),
    createProfile: vi.fn(),
    createGatePolicy: vi.fn(),
  },
}));

import { api, evaluationApi, platformApi } from "@/lib/api";
import EvaluationGovernancePage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  navigation.params = new URLSearchParams("tab=profiles");
});

function arrange() {
  vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "tenant-1" } as never);
  vi.mocked(platformApi.capabilities).mockResolvedValue({ actions: { author_governance: true } } as never);
  vi.mocked(platformApi.listAssignments).mockResolvedValue([] as never);
  vi.mocked(platformApi.listProfiles).mockResolvedValue([] as never);
  vi.mocked(platformApi.listGatePolicies).mockResolvedValue([] as never);
  vi.mocked(evaluationApi.listMetrics).mockResolvedValue([
    { metric_id: "quality.task_completion", name: "Task Completion", scenario: "agentic" },
  ] as never);
  vi.mocked(platformApi.createProfile).mockResolvedValue({} as never);
  vi.mocked(platformApi.createGatePolicy).mockResolvedValue({} as never);
}

describe("governance management creation", () => {
  it("uses URL-addressable Profile creation and submits on the management surface", async () => {
    navigation.params = new URLSearchParams("tab=profiles&create=profile");
    arrange();
    render(createElement(EvaluationGovernancePage));

    const dialog = await screen.findByRole("dialog", { name: "Create Quality Profile" });
    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Agent quality" } });
    // No ID or Version field any more — both are generated from the name.
    fireEvent.click(screen.getByRole("checkbox", { name: "Task Completion" }));
    fireEvent.click(screen.getByRole("button", { name: "Create draft Quality Profile" }));

    await waitFor(() => expect(platformApi.createProfile).toHaveBeenCalled());
    expect(dialog).toBeTruthy();
  });

  it("links and submits Gate Policy creation on its catalogue tab", async () => {
    navigation.params = new URLSearchParams("tab=policies&create=policy");
    arrange();
    render(createElement(EvaluationGovernancePage));

    expect(await screen.findByRole("dialog", { name: "Create Gate Policy" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Policy name"), { target: { value: "Production release" } });
    // A Gate Policy with no checks gates nothing, so submission needs at least one.
    fireEvent.click(screen.getByRole("checkbox", { name: "Task Completion" }));
    fireEvent.click(screen.getByRole("button", { name: "Create draft Gate Policy" }));

    await waitFor(() => expect(platformApi.createGatePolicy).toHaveBeenCalled());
  });

  it("exposes dedicated create URLs rather than the Assignment wizard", async () => {
    arrange();
    render(createElement(EvaluationGovernancePage));
    expect((await screen.findByRole("link", { name: "Create Quality Profile" })).getAttribute("href"))
      .toBe("/contracts?tab=profiles&create=profile");
  });
});
