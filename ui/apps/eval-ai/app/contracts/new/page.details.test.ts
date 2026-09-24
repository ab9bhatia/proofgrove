/** @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.params,
}));

vi.mock("@/components/eval-hub-gate", () => ({
  EvalHubGate: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/lib/api", () => ({
  api: { tenant: vi.fn() },
  agentsApi: { catalog: vi.fn() },
  evaluationApi: { listMetrics: vi.fn(), listRuns: vi.fn(), listRunsForManifest: vi.fn() },
  platformApi: {
    listProjects: vi.fn(),
    listGatePolicies: vi.fn(),
    listProfiles: vi.fn(),
    listTargetVersions: vi.fn(),
    getManifest: vi.fn(),
    getAssignment: vi.fn(),
    createAssignment: vi.fn(),
    createTargetVersion: vi.fn(),
    listAssignments: vi.fn(),
  },
}));

import { api, evaluationApi, platformApi } from "@/lib/api";
import QualityContractsPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  navigation.params = new URLSearchParams();
});

const manifest = {
  manifest_id: "manifest-1",
  manifest_hash: "hash-1",
  tenant_id: "tenant-classroom",
  project_id: "p1",
  target_version_id: "target-1",
  target_id: "support",
  target_version: "2.0.0",
  target_endpoint: "https://example.test",
  target_type: "agent",
  environment: "prod",
  quality_profile_id: "quality-1",
  quality_profile_version: "1.0.0",
  gate_policy_id: null,
  gate_policy_version: null,
  scenario: "agentic",
  metric_ids: [],
  evaluator_refs: {},
  metric_pack_refs: [],
  metric_definitions: [],
  kpi_threshold_overrides: {},
  hard_blocker_metric_ids: [],
  evidence_requirements: [],
  review_trigger_gates: [],
  approver_roles: [],
  judge_config: {},
  model_version: null,
  prompt_version: null,
  tool_versions: {},
  resolved_at: "2026-08-15T00:00:00Z",
  resolved_by: "eval-hub-ui",
};

const assignment = {
  assignment_id: "support-assignment",
  version: "1.0.0",
  tenant_id: "tenant-classroom",
  name: "Support assignment",
  project_id: "p1",
  target_version_id: "target-1",
  profile_id: "quality-1",
  profile_version: "1.0.0",
  gate_policy_id: null,
  run_manifest_id: "manifest-1",
  governance_state: "standardized_evaluation",
  resolved_run_manifest: manifest,
};

const project = { project_id: "p1", tenant_id: "tenant-classroom", name: "Claims", system_type: "agent", owner: "Evaluation", status: "active", tags: {} };
const target = { target_version_id: "target-1", target_id: "support", project_id: "p1", tenant_id: "tenant-classroom", name: "Support agent", version: "2.0.0", endpoint: "https://example.test", target_type: "agent", environment: "prod", tool_versions: {}, configuration: {} };
const profile = { profile_id: "quality-1", version: "1.0.0", tenant_id: "tenant-classroom", project_id: null, name: "Support quality", status: "approved", scenario: "agentic", metric_ids: [], evidence_requirements: [], hard_blocker_metric_ids: [], approver_roles: [] };

function withSetupParams() {
  navigation.params = new URLSearchParams({
    setup: "manifest-1",
    assignment: "support-assignment",
    assignmentVersion: "1.0.0",
  });
}

describe("Assignment details deep link (?setup=)", () => {
  it("renders the saved Assignment read-only, not the authoring wizard", async () => {
    withSetupParams();
    vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "tenant-classroom" } as never);
    vi.mocked(evaluationApi.listRunsForManifest).mockResolvedValue({ items: [], total: 0 } as never);
    vi.mocked(platformApi.getAssignment).mockResolvedValue(assignment as never);
    vi.mocked(platformApi.listProjects).mockResolvedValue([project] as never);
    vi.mocked(platformApi.listTargetVersions).mockResolvedValue([target] as never);
    vi.mocked(platformApi.listProfiles).mockResolvedValue([profile] as never);
    vi.mocked(platformApi.listGatePolicies).mockResolvedValue([] as never);

    render(createElement(QualityContractsPage));

    // The name is the page heading now; the version reads in the description.
    expect(await screen.findByRole("heading", { name: "Support assignment" })).toBeTruthy();
    expect(screen.getByText(/Version 1\.0\.0/)).toBeTruthy();
    // The governance state is the headline, stated in words.
    expect(screen.getByRole("heading", { name: /Standardized evaluation|Release-governed|Archived/ })).toBeTruthy();
    expect(screen.getByText("Provenance")).toBeTruthy();
    expect(screen.getByText(/No evaluation has been run under this Assignment yet/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Project & target" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Continue to/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Assignment" })).toBeNull();
    expect(screen.queryByRole("link", { name: "View details" })).toBeNull();
    expect(screen.getByText("Claims")).toBeTruthy();
    expect(screen.getByText(/Support agent · agent · prod/)).toBeTruthy();
    expect(platformApi.getAssignment).toHaveBeenCalledWith("support-assignment", "1.0.0", "tenant-classroom", true);
  });

  it("shows an error state with a way back when the Assignment cannot be loaded", async () => {
    withSetupParams();
    vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "tenant-classroom" } as never);
    vi.mocked(platformApi.getAssignment).mockRejectedValue(new Error("Assignment not found"));

    render(createElement(QualityContractsPage));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Assignment not found"));
    expect(screen.getByRole("link", { name: "Back to Evaluation governance" })).toBeTruthy();
  });

  it("shows an error state when the link carries no Assignment identity", async () => {
    navigation.params = new URLSearchParams({ setup: "manifest-1" });

    render(createElement(QualityContractsPage));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Evaluation governance" })).toBeTruthy();
    expect(platformApi.getAssignment).not.toHaveBeenCalled();
  });
});
