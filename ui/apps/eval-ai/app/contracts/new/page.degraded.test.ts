/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/eval-hub-gate", () => ({
  EvalHubGate: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/lib/api", () => ({
  api: { tenant: vi.fn() },
  agentsApi: { catalog: vi.fn() },
  platformApi: {
    listProjects: vi.fn(),
    listGatePolicies: vi.fn(),
    listProfiles: vi.fn(),
    listTargetVersions: vi.fn(),
  },
}));

import { agentsApi, api, platformApi } from "@/lib/api";
import QualityContractsPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function arrange({ failing = [] as string[], projects = [] as Array<Record<string, unknown>> } = {}) {
  const answer = <T,>(name: string, value: T) =>
    failing.includes(name) ? Promise.reject(new Error(`${name} unavailable`)) : Promise.resolve(value) as never;
  vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "tenant-classroom" } as never);
  vi.mocked(platformApi.listProjects).mockImplementation(() => answer("projects", projects));
  vi.mocked(platformApi.listGatePolicies).mockImplementation(() => answer("policies", []));
  vi.mocked(platformApi.listProfiles).mockImplementation(() => answer("profiles", []));
  vi.mocked(agentsApi.catalog).mockImplementation(() => answer("agents", []));
  vi.mocked(platformApi.listTargetVersions).mockResolvedValue([] as never);
}

describe("contracts workspace under a catalogue outage", () => {
  it("shows Project retry guidance and never invites duplicate creation", async () => {
    arrange({ failing: ["projects"] });
    render(createElement(QualityContractsPage));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Projects could not be loaded"));
    expect(screen.queryByText("No projects yet. Create one to continue.")).toBeNull();
    expect(screen.queryByRole("button", { name: "New project" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Project & target" })).toBeTruthy();
  });

  it("renders a true empty state only after a successful load", async () => {
    arrange();
    render(createElement(QualityContractsPage));

    expect(await screen.findByText("No projects yet. Create one to continue.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "New project" })).toBeTruthy();
  });

  it("tracks Agent Catalog failure independently from registered targets", async () => {
    arrange({
      failing: ["agents"],
      projects: [{
        project_id: "p1",
        tenant_id: "tenant-classroom",
        name: "Claims",
        system_type: "agent",
        owner: "Evaluation",
        status: "active",
        tags: {},
      }],
    });
    render(createElement(QualityContractsPage));

    fireEvent.click(await screen.findByRole("radio", { name: "Claims, agent, active, owned by Evaluation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add from Agent Catalog" }));
    expect(screen.getByRole("alert").textContent).toContain("Agent Catalog could not be loaded");
    expect(screen.queryByText("0 agents")).toBeNull();
  });
});
