/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => navigation.params,
}));

vi.mock("@/components/eval-hub-gate", () => ({
  EvalHubGate: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/lib/api", () => ({
  api: { tenant: vi.fn() },
  evaluationApi: { listMetrics: vi.fn() },
  platformApi: {
    listAssignments: vi.fn(),
    listProfiles: vi.fn(),
    listGatePolicies: vi.fn(),
    capabilities: vi.fn(),
    archiveAssignment: vi.fn(),
    restoreAssignment: vi.fn(),
    markProfileTested: vi.fn(),
    transitionProfile: vi.fn(),
    transitionGatePolicy: vi.fn(),
  },
}));

import { api, evaluationApi, platformApi } from "@/lib/api";
import EvaluationGovernancePage from "./page";

afterEach(async () => {
  // Let delayed menu focus restoration finish before the next test starts.
  await act(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  vi.clearAllMocks();
  navigation.params = new URLSearchParams();
  window.history.replaceState({}, "", "/contracts");
});

function arrange({
  assignmentsFail = false,
  archived = false,
}: {
  assignmentsFail?: boolean;
  archived?: boolean;
} = {}) {
  vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "tenant-classroom" } as never);
  vi.mocked(platformApi.capabilities).mockResolvedValue({
    actions: { author_governance: true },
  } as never);
  vi.mocked(platformApi.listProfiles).mockResolvedValue([
    {
      profile_id: "claims-quality",
      version: "1.0.0",
      tenant_id: "tenant-classroom",
      name: "Claims quality",
      status: "approved",
      metric_ids: ["llm.relevance"],
      evidence_requirements: ["input"],
      hard_blocker_metric_ids: [],
      approver_roles: ["eval-hub-approver"],
    },
  ] as never);
  vi.mocked(platformApi.listGatePolicies).mockResolvedValue([] as never);
  vi.mocked(evaluationApi.listMetrics).mockResolvedValue([] as never);
  vi.mocked(platformApi.listAssignments).mockImplementation(() =>
    assignmentsFail
      ? Promise.reject(new Error("assignments unavailable"))
      : (Promise.resolve([
          {
            assignment_id: "claims-release",
            version: "1.0.0",
            tenant_id: "tenant-classroom",
            name: "Claims release",
            project_id: "p1",
            target_version_id: "t1",
            profile_id: "claims-quality",
            profile_version: "1.0.0",
            run_manifest_id: "m1",
            governance_state: "standardized_evaluation",
            archived_at: archived ? "2026-09-01T00:00:00Z" : null,
          },
        ]) as never),
  );
  vi.mocked(platformApi.archiveAssignment).mockResolvedValue({
    assignment_id: "claims-release",
    version: "1.0.0",
    archived_at: "2026-09-01T00:00:00Z",
  } as never);
  vi.mocked(platformApi.restoreAssignment).mockResolvedValue({
    assignment_id: "claims-release",
    version: "1.0.0",
    archived_at: null,
  } as never);
}

describe("evaluation governance home", () => {
  it("opens an Assignment from its row and keeps Create on the archived shelf", async () => {
    arrange();
    render(createElement(EvaluationGovernancePage));

    const row = await screen.findByRole("link", { name: /^Open Claims release, version/ });
    expect(row.getAttribute("href")).toBe(
      "/contracts/new?setup=m1&assignment=claims-release&assignmentVersion=1.0.0",
    );

    // Creating an Assignment is not a property of the shelf being viewed.
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(screen.getByRole("link", { name: "Create Assignment" })).toBeTruthy();
  });

  it("sorts from the column header instead of a dropdown", async () => {
    navigation.params = new URLSearchParams("tab=profiles");
    arrange();
    render(createElement(EvaluationGovernancePage));

    const header = await screen.findByRole("button", { name: /Sort by quality profile/i });
    // The dropdown still exists for small screens; the header is the desktop path.
    fireEvent.click(header);
    expect(
      screen.getByRole("button", { name: /Sort by quality profile, currently ascending/i }),
    ).toBeTruthy();
  });

  it("pages a catalogue longer than one page", async () => {
    const profiles = Array.from({ length: 23 }, (_, index) => ({
      profile_id: `p-${index}`,
      version: "1.0.0",
      tenant_id: "tenant-classroom",
      name: `Profile ${index}`,
      status: "approved",
      scenario: "agentic",
      metric_ids: ["quality.task_completion"],
      evidence_requirements: [],
      hard_blocker_metric_ids: [],
      approver_roles: [],
    }));
    navigation.params = new URLSearchParams("tab=profiles");
    arrange();
    vi.mocked(platformApi.listProfiles).mockResolvedValue(profiles as never);
    render(createElement(EvaluationGovernancePage));

    expect(await screen.findByText(/Page 1 of 3/)).toBeTruthy();
    expect(screen.getByText("Profile 0")).toBeTruthy();
    expect(screen.queryByText("Profile 22")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Profile 22")).toBeTruthy();
    expect(screen.queryByText("Profile 0")).toBeNull();
  });

  it("names the three governance products and does not open the authoring wizard", async () => {
    arrange();
    render(createElement(EvaluationGovernancePage));

    expect(await screen.findByRole("heading", { name: "Evaluation governance" })).toBeTruthy();
    expect((await screen.findByRole("link", { name: "Quality Profiles (1)" })).getAttribute("href")).toBe(
      "/contracts?tab=profiles",
    );
    expect(screen.getByRole("link", { name: "Gate Policies (0)" }).getAttribute("href")).toBe(
      "/contracts?tab=policies",
    );
    const assignmentsTab = screen.getByRole("link", { name: "Assignments (1)" });
    expect(assignmentsTab.getAttribute("href")).toBe("/contracts?tab=assignments");
    expect(assignmentsTab.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "Assignments" })).toBeTruthy();
    expect(screen.getByText("Claims release")).toBeTruthy();
    // The governance-state filter is a native <select>, so its <option> carries the
    // same text as the row's chip. Assert the chip, not whichever matches first.
    expect(
      screen.getAllByText("Standardized evaluation").some((node) => node.tagName !== "OPTION"),
    ).toBe(true);
    expect(screen.queryByRole("heading", { name: "Quality Profiles" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Gate Policies" })).toBeNull();
    expect(screen.queryByText("Claims quality")).toBeNull();
    expect(screen.queryByRole("heading", { name: "New Assignment" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Contract setup progress" })).toBeNull();
    expect(screen.getByRole("link", { name: "Create Assignment" }).getAttribute("href")).toBe(
      "/contracts/new",
    );
  });

  it("names a failed Assignments load instead of showing an empty shelf", async () => {
    arrange({ assignmentsFail: true });
    render(createElement(EvaluationGovernancePage));

    expect(await screen.findByRole("heading", { name: "Assignments" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Assignments (0)" }).getAttribute("aria-current")).toBe(
      "page",
    );
    await waitFor(() =>
      expect(screen.getByText(/Could not load Assignments/)).toBeTruthy(),
    );
    expect(screen.queryByText("No Assignments")).toBeNull();
  });

  it("offers Run evaluation, View details, and Copy link for each Assignment", async () => {
    arrange();
    render(createElement(EvaluationGovernancePage));

    expect(
      await screen.findByRole("link", { name: "Run evaluation with this Assignment" }),
    ).toBeTruthy();
    const run = screen.getByRole("link", { name: "Run evaluation with this Assignment" });
    expect(run.getAttribute("href")).toBe(
      "/evaluate?assignment=claims-release&assignmentVersion=1.0.0",
    );
    // View details, Copy link and Archive moved behind the row's overflow menu, so
    // Assignments carry one primary action like Profiles and Policies already did.
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions for Claims release" }), {
      key: "ArrowDown",
    });
    expect(
      (await screen.findByRole("menuitem", { name: "View details" })).getAttribute("href"),
    ).toBe("/contracts/new?setup=m1&assignment=claims-release&assignmentVersion=1.0.0");
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Archive Assignment" })).toBeTruthy();
  });

  it("filters archived Assignments client-side without a second list fetch", async () => {
    arrange({ archived: true });
    render(createElement(EvaluationGovernancePage));

    await screen.findByRole("heading", { name: "Assignments" });
    await waitFor(() =>
      expect(platformApi.listAssignments).toHaveBeenCalledWith("tenant-classroom", {
        includeArchived: true,
      }),
    );
    const callsBeforeShelf = vi.mocked(platformApi.listAssignments).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(await screen.findByText("Claims release")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore Assignment" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Run evaluation with this Assignment" })).toBeNull();
    expect(vi.mocked(platformApi.listAssignments).mock.calls.length).toBe(callsBeforeShelf);
  });

  it("opens an archived Assignment deep link with one initial load", async () => {
    navigation.params = new URLSearchParams("assignment=claims-release&assignmentVersion=1.0.0");
    window.history.replaceState({}, "", `/contracts?${navigation.params}`);
    arrange({ archived: true });
    render(createElement(EvaluationGovernancePage));
    expect(await screen.findByText("Claims release")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore Assignment" })).toBeTruthy();
    expect(api.tenant).toHaveBeenCalledTimes(1);
    expect(platformApi.listAssignments).toHaveBeenCalledTimes(1);
  });

  it("filters Assignments by search without refetching the catalogue", async () => {
    arrange();
    render(createElement(EvaluationGovernancePage));
    await screen.findByText("Claims release");
    const callsBeforeSearch = vi.mocked(platformApi.listAssignments).mock.calls.length;
    fireEvent.change(screen.getByLabelText("Search Assignments"), {
      target: { value: "no-such-assignment" },
    });
    await waitFor(() => expect(screen.queryByText("Claims release")).toBeNull());
    expect(vi.mocked(platformApi.listAssignments).mock.calls.length).toBe(callsBeforeSearch);
  });

  it("opens a Profile drawer from a deep link after data loads", async () => {
    navigation.params = new URLSearchParams("profile=claims-quality@1.0.0");
    arrange();
    render(createElement(EvaluationGovernancePage));

    expect(await screen.findByRole("dialog", { name: "Claims quality" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Quality Profiles (1)" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("writes Profile selection to the URL and keeps row actions from opening it", async () => {
    navigation.params = new URLSearchParams("tab=profiles");
    arrange();
    render(createElement(EvaluationGovernancePage));
    const profileButton = await screen.findByRole("button", {
      name: "Open Claims quality, version 1.0.0, approved, All Projects",
    });

    fireEvent.click(screen.getByRole("button", { name: "Retire Claims quality" }));
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(screen.getByText("Retire “Claims quality”?")).toBeTruthy();
    expect(
      screen.getByText(/This version can no longer be selected for new Assignments\. You can reinstate it/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(profileButton);
    expect(navigation.replace).toHaveBeenCalledWith(
      "/contracts?tab=profiles&profile=claims-quality%401.0.0",
    );
  });

  it("confirms retirement before calling the Profile lifecycle API", async () => {
    navigation.params = new URLSearchParams("tab=profiles");
    arrange();
    render(createElement(EvaluationGovernancePage));

    fireEvent.click(await screen.findByRole("button", { name: "Retire Claims quality" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Retire Claims quality" })[1]);

    await waitFor(() =>
      expect(platformApi.transitionProfile).toHaveBeenCalledWith(
        "claims-quality",
        "1.0.0",
        "tenant-classroom",
        "retire",
      ),
    );
  });

  it("keeps retirement open and shows API failure inside its modal", async () => {
    navigation.params = new URLSearchParams("tab=profiles");
    arrange();
    vi.mocked(platformApi.transitionProfile).mockRejectedValue(new Error("retirement unavailable"));
    render(createElement(EvaluationGovernancePage));

    fireEvent.click(await screen.findByRole("button", { name: "Retire Claims quality" }));
    const modal = screen.getByRole("dialog", { name: "Retire “Claims quality”?" });
    fireEvent.click(within(modal).getByRole("button", { name: "Retire Claims quality" }));

    await waitFor(() =>
      expect(within(modal).getByRole("alert").textContent).toContain("retirement unavailable"),
    );
    expect(screen.getByRole("dialog", { name: "Retire “Claims quality”?" })).toBe(modal);
  });

  it("requires and trims a note before saving a test override", async () => {
    navigation.params = new URLSearchParams("tab=profiles");
    arrange();
    vi.mocked(platformApi.listProfiles).mockResolvedValue([
      {
        profile_id: "claims-quality",
        version: "1.0.0",
        tenant_id: "tenant-classroom",
        name: "Claims quality",
        status: "draft",
        metric_ids: ["llm.relevance"],
        evidence_requirements: ["input"],
        hard_blocker_metric_ids: [],
        approver_roles: ["eval-hub-approver"],
        test_status: "not_tested",
      },
    ] as never);
    render(createElement(EvaluationGovernancePage));

    const menuTrigger = await screen.findByRole("button", { name: "More actions for Claims quality" });
    act(() => menuTrigger.focus());
    fireEvent.keyDown(menuTrigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Override Not tested" }));
    const save = screen.getByRole("button", { name: "Save override" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Override note"), {
      target: { value: "  Approved dry-run exception.  " },
    });
    fireEvent.click(save);

    await waitFor(() =>
      expect(platformApi.markProfileTested).toHaveBeenCalledWith(
        "claims-quality",
        "1.0.0",
        "tenant-classroom",
        { mode: "overridden", note: "Approved dry-run exception." },
      ),
    );
  });

  it("keeps override open and shows API failure inside its modal", async () => {
    navigation.params = new URLSearchParams("tab=profiles");
    arrange();
    vi.mocked(platformApi.listProfiles).mockResolvedValue([{
      profile_id: "claims-quality", version: "1.0.0", tenant_id: "tenant-classroom",
      name: "Claims quality", status: "draft", test_status: "not_tested",
      metric_ids: ["llm.relevance"], evidence_requirements: ["input"],
      hard_blocker_metric_ids: [], approver_roles: ["eval-hub-approver"],
    }] as never);
    vi.mocked(platformApi.markProfileTested).mockRejectedValue(new Error("override unavailable"));
    render(createElement(EvaluationGovernancePage));

    const menuTrigger = await screen.findByRole("button", { name: "More actions for Claims quality" });
    act(() => menuTrigger.focus());
    fireEvent.keyDown(menuTrigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Override Not tested" }));
    const modal = screen.getByRole("dialog", {
      name: "Override Not tested for “Claims quality”",
    });
    fireEvent.change(within(modal).getByLabelText("Override note"), {
      target: { value: "Documented exception" },
    });
    fireEvent.click(within(modal).getByRole("button", { name: "Save override" }));

    await waitFor(() =>
      expect(within(modal).getByRole("alert").textContent).toContain("override unavailable"),
    );
    expect(
      screen.getByRole("dialog", { name: "Override Not tested for “Claims quality”" }),
    ).toBe(modal);
  });

  it("closes only the topmost retirement dialog on Escape", async () => {
    navigation.params = new URLSearchParams("profile=claims-quality@1.0.0");
    arrange();
    render(createElement(EvaluationGovernancePage));

    fireEvent.click(await screen.findByRole("button", { name: "Retire Claims quality" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("Retire “Claims quality”?")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByText("Retire “Claims quality”?")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Claims quality" })).toBeTruthy();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("keeps the focused catalogue row mounted during lifecycle refresh", async () => {
    navigation.params = new URLSearchParams("tab=profiles");
    arrange();
    vi.mocked(platformApi.listProfiles).mockResolvedValue([
      {
        profile_id: "claims-quality", version: "1.0.0", tenant_id: "tenant-classroom",
        name: "Claims quality", status: "validated", test_status: "tested",
        metric_ids: ["llm.relevance"], evidence_requirements: ["input"],
        hard_blocker_metric_ids: [], approver_roles: ["eval-hub-approver"],
      },
    ] as never);
    let finishTransition: (() => void) | undefined;
    vi.mocked(platformApi.transitionProfile).mockImplementation(
      () => new Promise((resolve) => { finishTransition = () => resolve({} as never); }),
    );
    render(createElement(EvaluationGovernancePage));
    const approve = await screen.findByRole("button", { name: "Approve Claims quality" });
    approve.focus();
    fireEvent.click(approve);

    expect(screen.queryByText("Loading evaluation governance")).toBeNull();
    expect(screen.getByRole("button", {
      name: "Open Claims quality, version 1.0.0, validated, All Projects",
    })).toBeTruthy();
    expect(document.activeElement).toBe(approve);
    finishTransition?.();
  });

  it("announces successful Profile ID copies", async () => {
    navigation.params = new URLSearchParams("profile=claims-quality@1.0.0");
    arrange();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(createElement(EvaluationGovernancePage));

    const menuTrigger = await screen.findByRole("button", { name: "More actions for Claims quality" });
    act(() => menuTrigger.focus());
    fireEvent.keyDown(menuTrigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy ID" }));
    expect(writeText).toHaveBeenCalledWith("claims-quality@1.0.0");
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog", { name: "Claims quality" })).getByRole("status").textContent,
      ).toBe("Copied claims-quality@1.0.0."),
    );
  });

  it("shows recoverable failure feedback for Policy ID copies", async () => {
    navigation.params = new URLSearchParams("policy=release-gate@1.0.0");
    arrange();
    vi.mocked(platformApi.listGatePolicies).mockResolvedValue([{
      gate_policy_id: "release-gate", version: "1.0.0", tenant_id: "tenant-classroom",
      name: "Release gate", status: "approved", required_evidence: [],
      required_approver_roles: [], hard_blocker_metric_ids: [],
    }] as never);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(createElement(EvaluationGovernancePage));

    fireEvent.keyDown(
      await screen.findByRole("button", { name: "More actions for Release gate" }),
      { key: "ArrowDown" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy ID" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog", { name: "Release gate" })).getByRole("alert").textContent,
      ).toContain(
        "Could not copy release-gate@1.0.0. Copy it manually: release-gate@1.0.0",
      ),
    );
  });

  it("announces lifecycle success and failure inside the active drawer", async () => {
    navigation.params = new URLSearchParams("profile=claims-quality@1.0.0");
    arrange();
    vi.mocked(platformApi.listProfiles).mockResolvedValue([{
      profile_id: "claims-quality", version: "1.0.0", tenant_id: "tenant-classroom",
      name: "Claims quality", status: "validated", test_status: "tested",
      metric_ids: ["llm.relevance"], evidence_requirements: ["input"],
      hard_blocker_metric_ids: [], approver_roles: ["eval-hub-approver"],
    }] as never);
    vi.mocked(platformApi.transitionProfile)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error("approval unavailable"));
    render(createElement(EvaluationGovernancePage));

    fireEvent.click(await screen.findByRole("button", { name: "Approve Claims quality" }));
    const drawer = await screen.findByRole("dialog", { name: "Claims quality" });
    await waitFor(() =>
      expect(within(drawer).getByRole("status").textContent).toBe("Claims quality was approved."),
    );

    fireEvent.click(within(drawer).getByRole("button", { name: "Approve Claims quality" }));
    await waitFor(() =>
      expect(within(drawer).getByRole("alert").textContent).toContain("approval unavailable"),
    );
  });

  it("renders explicit recovery when a deep-linked Profile does not exist", async () => {
    navigation.params = new URLSearchParams("profile=missing@9.9.9");
    arrange();
    render(createElement(EvaluationGovernancePage));

    expect(await screen.findByRole("dialog", { name: "Unable to open Quality Profile" })).toBeTruthy();
    expect(screen.getByText("Quality Profile missing@9.9.9 was not found.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close record details" })).toBeTruthy();
  });

  it("renders retry recovery when the deep-linked Profile catalogue fails", async () => {
    navigation.params = new URLSearchParams("profile=claims-quality@1.0.0");
    arrange();
    vi.mocked(platformApi.listProfiles).mockRejectedValue(new Error("profiles unavailable"));
    render(createElement(EvaluationGovernancePage));

    expect(await screen.findByRole("dialog", { name: "Unable to open Quality Profile" })).toBeTruthy();
    expect(screen.getByText("This Quality Profile could not be loaded.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry record load" })).toBeTruthy();
  });
});

describe("recording a dry run", () => {
  const source = readFileSync("app/contracts/page.tsx", "utf8");

  it("asks which run evidenced the Profile instead of asserting it was tested", () => {
    // "Mark tested" used to POST straight away, so the status rested on the
    // operator's word and a free-text dataset name nothing resolved.
    expect(source).not.toContain('void saveProfileTestStatus(profile, mode);');
    expect(source).toContain("setTestProfile(profile)");
    expect(source).toContain("source_run_id: sourceRunId");
  });

  it("offers only completed runs, because an unfinished one evidences nothing", () => {
    expect(source).toContain('runs.filter((run) => run.status === "completed")');
  });

  it("keeps the override as the route when no dry run is possible", () => {
    expect(source).toContain("record an override with a note");
  });
});
