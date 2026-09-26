/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/proofgrove-gate", () => ({
  ProofgroveGate: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/lib/api", () => ({
  api: { tenant: vi.fn() },
  agentsApi: { catalog: vi.fn() },
  evaluationApi: { listMetrics: vi.fn(), listRuns: vi.fn() },
  platformApi: {
    listProjects: vi.fn(),
    listGatePolicies: vi.fn(),
    listQualityContractTemplates: vi.fn(),
    listProfiles: vi.fn(),
    listTargetVersions: vi.fn(),
    getManifest: vi.fn(),
    createAssignment: vi.fn(),
    createTargetVersion: vi.fn(),
    listAssignments: vi.fn(),
    getAssignment: vi.fn(),
  },
}));

import { api, agentsApi, evaluationApi, platformApi } from "@/lib/api";
import QualityContractsPage, {
  compatiblePolicies,
  compatibleProfiles,
  contractSectionReadiness,
  WORKSPACE_FLOW,
} from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const project = {
  project_id: "p1",
  tenant_id: "tenant-classroom",
  name: "Claims",
  description: null,
  system_type: "agent",
  owner: "Evaluation",
  status: "active",
  tags: {},
};

const approvedProfile = {
  profile_id: "quality-1",
  version: "1.0.0",
  tenant_id: "tenant-classroom",
  project_id: null,
  name: "Support quality",
  status: "approved",
  scenario: "agentic",
  metric_ids: ["quality.task_completion"],
  evidence_requirements: ["final_output"],
  hard_blocker_metric_ids: [],
  approver_roles: [],
};

const target = {
  target_version_id: "target-1",
  target_id: "support",
  project_id: "p1",
  tenant_id: "tenant-classroom",
  name: "Support agent",
  version: "2.0.0",
  endpoint: "https://example.test",
  target_type: "agent",
  environment: "prod",
  model_version: "gpt-4.1",
  prompt_version: null,
  tool_versions: {},
  configuration: {},
};

function arrange() {
  vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "tenant-classroom" } as never);
  vi.mocked(platformApi.listProjects).mockResolvedValue([project] as never);
  vi.mocked(platformApi.listGatePolicies).mockResolvedValue([] as never);
  vi.mocked(platformApi.listQualityContractTemplates).mockResolvedValue([] as never);
  vi.mocked(platformApi.listProfiles).mockResolvedValue([approvedProfile] as never);
  vi.mocked(platformApi.listTargetVersions).mockResolvedValue([target] as never);
  vi.mocked(platformApi.listAssignments).mockResolvedValue([] as never);
  vi.mocked(platformApi.createTargetVersion).mockResolvedValue({} as never);
  vi.mocked(agentsApi.catalog).mockResolvedValue([] as never);
  vi.mocked(evaluationApi.listMetrics).mockResolvedValue([] as never);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("contract setup progress", () => {
  it("retains a saved assignment when its manifest read fails and retries only the read", async () => {
    arrange();
    vi.mocked(platformApi.createAssignment).mockResolvedValue({
      assignment_id: "assignment-1", version: "1.0.0", run_manifest_id: "manifest-1",
      tenant_id: "tenant-classroom", name: "Saved assignment",
    } as never);
    vi.mocked(platformApi.getManifest)
      .mockRejectedValueOnce(new Error("Manifest unavailable"))
      .mockResolvedValue({ manifest_id: "manifest-1", evidence_requirements: [] } as never);
    render(createElement(QualityContractsPage));
    fireEvent.click(await screen.findByRole("radio", { name: "Claims, agent, active, owned by Evaluation" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Support agent/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue to Quality Profile/i }));
    fireEvent.click(screen.getByRole("radio", { name: /Support quality/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue to Gate Policy/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue to Review & save/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save Assignment" }));
    const retry = await screen.findByRole("button", { name: "Retry loading details" });
    expect(screen.getByRole("heading", { name: "Assignment saved" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save Assignment" })).toBeNull();
    expect(platformApi.createAssignment).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await screen.findByRole("link", { name: "Run evaluation with this Assignment" });
    expect(platformApi.createAssignment).toHaveBeenCalledTimes(1);
    expect(platformApi.getManifest).toHaveBeenCalledTimes(2);
    expect(platformApi.getManifest).toHaveBeenLastCalledWith("manifest-1", "tenant-classroom");
  });

  it("shows the approved four-stage flow", async () => {
    arrange();
    render(createElement(QualityContractsPage));

    expect(WORKSPACE_FLOW.map((step) => step.label)).toEqual([
      "Project & target",
      "Quality Profile",
      "Gate Policy",
      "Review & save",
    ]);
    for (const title of ["Project & target", "Quality Profile", "Gate Policy", "Review & save"]) {
      expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
    }
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Assignment setup progress" })
      .querySelectorAll("ol li")).toHaveLength(4);
  });

  it("requires project and target before Profile and saves only from review", async () => {
    arrange();
    render(createElement(QualityContractsPage));

    expect(await screen.findByRole("heading", { name: "Project & target" })).toBeTruthy();
    expect(screen.queryByText("Support quality")).toBeNull();
    fireEvent.click(await screen.findByRole("radio", { name: "Claims, agent, active, owned by Evaluation" }));
    expect(screen.getByRole("button", { name: /Continue to Quality Profile/i }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(await screen.findByRole("radio", { name: /Support agent/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue to Quality Profile/i }));
    fireEvent.click(screen.getByRole("radio", { name: /Support quality/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue to Gate Policy/i }));

    expect(screen.queryByRole("button", { name: "Save Assignment" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Continue to Review & save/i }));

    expect(screen.getAllByText("Standardized evaluation").length).toBeGreaterThan(0);
    expect(screen.getByText("Technical details")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save Assignment" })).toBeTruthy();
  });

  it("ignores a stale target response after a rapid Project switch", async () => {
    arrange();
    const first = deferred<(typeof target)[]>();
    const second = deferred<(typeof target)[]>();
    vi.mocked(platformApi.listProjects).mockResolvedValue([
      project,
      { ...project, project_id: "p2", name: "Payments" },
    ] as never);
    vi.mocked(platformApi.listTargetVersions).mockImplementation((projectId) =>
      (projectId === "p1" ? first.promise : second.promise) as never
    );
    render(createElement(QualityContractsPage));

    fireEvent.click(await screen.findByRole("radio", { name: "Claims, agent, active, owned by Evaluation" }));
    fireEvent.click(screen.getByRole("radio", { name: "Payments, agent, active, owned by Evaluation" }));
    second.resolve([{ ...target, project_id: "p2", target_version_id: "p2-target", name: "Payments agent" }]);
    expect(await screen.findByRole("radio", { name: /Payments agent/i })).toBeTruthy();
    first.resolve([{ ...target, project_id: "p1", name: "Stale claims agent" }]);

    await waitFor(() => expect(screen.queryByText("Stale claims agent")).toBeNull());
    expect(screen.getByText("Payments agent")).toBeTruthy();
  });

  it("rejects a target that does not belong to the selected Project", async () => {
    arrange();
    vi.mocked(platformApi.listTargetVersions).mockResolvedValue([
      { ...target, project_id: "different-project", name: "Foreign target" },
    ] as never);
    render(createElement(QualityContractsPage));

    fireEvent.click(await screen.findByRole("radio", { name: "Claims, agent, active, owned by Evaluation" }));
    await waitFor(() => expect(screen.queryByText("Foreign target")).toBeNull());
    expect(screen.getByRole("button", { name: /Continue to Quality Profile/i }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps custom target registration open when the API fails", async () => {
    arrange();
    vi.mocked(platformApi.createTargetVersion).mockRejectedValue(new Error("registration unavailable"));
    render(createElement(QualityContractsPage));

    fireEvent.click(await screen.findByRole("radio", { name: "Claims, agent, active, owned by Evaluation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Register custom endpoint" }));
    fireEvent.change(screen.getByLabelText("Target name"), { target: { value: "Custom target" } });
    fireEvent.change(screen.getByLabelText("Target ID"), { target: { value: "custom-target" } });
    fireEvent.change(screen.getByLabelText("Gateway or endpoint URL"), { target: { value: "https://custom.test" } });
    const submit = screen.getByRole("button", { name: "Register target version" });
    fireEvent.submit(submit.closest("form")!);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Register target permanently?" }))
      .getByRole("button", { name: "Register target" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("registration unavailable"));
    expect(screen.getByRole("dialog", { name: "Register custom endpoint" })).toBeTruthy();
  });
});

describe("assignment compatibility", () => {
  it("keeps only approved reusable or selected-active-project profiles", () => {
    const profiles = [
      approvedProfile,
      { ...approvedProfile, profile_id: "selected", project_id: "p1" },
      { ...approvedProfile, profile_id: "different", project_id: "p2" },
      { ...approvedProfile, profile_id: "archived", project_id: "p3" },
      { ...approvedProfile, profile_id: "draft", status: "draft" },
    ];

    expect(compatibleProfiles(profiles as never, "p1", new Set(["p1", "p2"])).map((item) => item.profile_id))
      .toEqual(["quality-1", "selected"]);
  });

  it("keeps approved policies and honours a profile-pinned policy", () => {
    const policies = [
      { gate_policy_id: "release", version: "1.0.0", status: "approved" },
      { gate_policy_id: "other", version: "1.0.0", status: "approved" },
      { gate_policy_id: "draft", version: "1.0.0", status: "draft" },
    ];
    const pinnedProfile = {
      ...approvedProfile,
      gate_policy_id: "release",
      gate_policy_version: "1.0.0",
    };

    expect(compatiblePolicies(policies as never, pinnedProfile as never).map((item) => item.gate_policy_id))
      .toEqual(["release"]);
    expect(compatiblePolicies(policies as never, approvedProfile as never).map((item) => item.gate_policy_id))
      .toEqual(["release", "other"]);
  });

  it("drops a policy that gates on an ops metric the Profile did not elevate", () => {
    // The resolver leaves ops.* optional unless a profile states otherwise, so a
    // policy blocking on one cannot bind however the client guesses.
    const policies = [
      { gate_policy_id: "ops", version: "1.0.0", status: "approved", hard_blocker_metric_ids: ["ops.latency"] },
    ];
    const profile = { ...approvedProfile, metric_ids: ["ops.latency"], metric_requirements: {} };

    expect(compatiblePolicies(policies as never, profile as never)).toEqual([]);

    const elevated = { ...profile, metric_requirements: { "ops.latency": "required" } };
    expect(compatiblePolicies(policies as never, elevated as never).map((p) => p.gate_policy_id))
      .toEqual(["ops"]);
  });

  it("drops a policy that gates on a check the Profile does not score", () => {
    // The backend refuses this binding ("hard-blocker metrics must be selected
    // and required"), and it used to do so only after all four steps.
    const policies = [
      { gate_policy_id: "scored", version: "1.0.0", status: "approved", hard_blocker_metric_ids: ["quality.task_completion"] },
      { gate_policy_id: "unscored", version: "1.0.0", status: "approved", hard_blocker_metric_ids: ["llm.correctness"] },
    ];
    const profile = { ...approvedProfile, metric_ids: ["quality.task_completion"] };

    expect(compatiblePolicies(policies as never, profile as never).map((item) => item.gate_policy_id))
      .toEqual(["scored"]);
  });
});

describe("contract section readiness", () => {
  it("requires the four visible stages", () => {
    expect(contractSectionReadiness({
      projectAndTarget: true,
      profile: true,
      policyChoice: true,
      review: true,
    })).toEqual({
      projectAndTarget: true,
      profiles: true,
      policies: true,
      review: true,
    });
  });
});
