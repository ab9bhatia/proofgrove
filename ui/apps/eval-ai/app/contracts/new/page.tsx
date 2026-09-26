"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, LoaderCircle, Pencil, RefreshCw } from "lucide-react";

import { Button, buttonVariants } from "@evalai/shared/ui/button";
import { Input } from "@/components/ui/input";
import { ContractPoliciesPanel } from "@/components/contract-policies-panel";
import { ContractProfilesPanel, type CatalogueLoadState } from "@/components/contract-profiles-panel";
import { ContractProjectsPanel } from "@/components/contract-projects-panel";
import { ContractSectionFeedback, type ContractSectionFeedbackMessage } from "@/components/contract-section-feedback";
import { ContractTargetsPanel } from "@/components/contract-targets-panel";
import { ProofgroveGate } from "@/components/proofgrove-gate";
import { ErrorState, LoadingState } from "@/components/page-state";
import { Chip } from "@/components/status-badge";
import { PageHeader } from "@/components/page-header";
import { SetupProgress } from "@/components/setup-progress";
import { SetupStepSection, type SetupStepState } from "@/components/setup-step-section";
import {
  agentsApi,
  api,
  evaluationApi,
  platformApi,
  type EvaluationAssignmentVersion,
  type EvaluationProject,
  type QualityProfileVersion,
  type ReleaseGatePolicyVersion,
  type ResolvedRunManifest,
  type RunResult,
  type TargetVersion,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format-time";
import {
  assignmentDetailsHref,
  assignmentFromSearchParams,
  assignmentPermalinkPath,
  evaluateHrefFromAssignment,
} from "@/lib/assignment-links";
import { cn } from "@evalai/shared/utils";
import { PAGE_FRAME } from "@/lib/page-frame";

export type ContractWorkspaceSection = "projectAndTarget" | "profiles" | "policies" | "review";

export const WORKSPACE_FLOW: ReadonlyArray<{ value: ContractWorkspaceSection; label: string }> = [
  { value: "projectAndTarget", label: "Project & target" },
  { value: "profiles", label: "Quality Profile" },
  { value: "policies", label: "Gate Policy" },
  { value: "review", label: "Review & save" },
];

type LoadStates = {
  projects: CatalogueLoadState;
  targets: CatalogueLoadState;
  profiles: CatalogueLoadState;
  policies: CatalogueLoadState;
  agents: CatalogueLoadState;
};

const INITIAL_LOAD_STATES: LoadStates = {
  projects: "loading",
  targets: "ready",
  profiles: "loading",
  policies: "loading",
  agents: "loading",
};

function profileKey(profile: QualityProfileVersion): string {
  return `${profile.profile_id}@${profile.version}`;
}

function policyKey(policy: ReleaseGatePolicyVersion): string {
  return `${policy.gate_policy_id}@${policy.version}`;
}

export function compatibleProfiles(
  profiles: QualityProfileVersion[],
  projectId: string,
  activeProjectIds: Set<string>,
): QualityProfileVersion[] {
  if (!projectId || !activeProjectIds.has(projectId)) return [];
  return profiles.filter(
    (profile) =>
      profile.status === "approved" &&
      (!profile.project_id ||
        (profile.project_id === projectId && activeProjectIds.has(profile.project_id))),
  );
}

export function compatiblePolicies(
  policies: ReleaseGatePolicyVersion[],
  selectedProfile: QualityProfileVersion | null,
): ReleaseGatePolicyVersion[] {
  if (!selectedProfile) return [];
  // Blockers must be REQUIRED in the Profile, not merely present: the resolver
  // rejects "hard-blocker metrics must be selected and required". A Profile
  // authored in this app marks its checks optional (a required check also needs a
  // KPI gate composition, which nothing in the UI can supply), so such a Profile
  // is compatible only with policies that carry no hard blockers.
  const requirementOf = selectedProfile.metric_requirements ?? {};
  const blockable = new Set(
    selectedProfile.metric_ids.filter((metricId) => {
      const stated = requirementOf[metricId];
      if (stated) return stated === "required";
      // Unstated resolves to required on the server — except `ops.*`, which the
      // resolver treats as diagnostics and leaves optional unless a profile
      // elevates them explicitly. Assuming required here offered policies the
      // backend then refused at save.
      return !metricId.startsWith("ops.");
    }),
  );
  return policies.filter((policy) => {
    if (policy.status !== "approved") return false;
    // A policy cannot gate on a check the Profile does not score. The backend
    // refuses the binding with "hard-blocker metrics must be selected and
    // required", and it used to do so only at Save — after four steps — which is
    // the same late-failure the Project/Profile filter already removed.
    const blockers = policy.hard_blocker_metric_ids ?? [];
    if (!blockers.every((metricId) => blockable.has(metricId))) return false;
    if (!selectedProfile.gate_policy_id) return true;
    return (
      policy.gate_policy_id === selectedProfile.gate_policy_id &&
      (!selectedProfile.gate_policy_version ||
        policy.version === selectedProfile.gate_policy_version)
    );
  });
}

export function contractSectionReadiness(state: {
  projectAndTarget: boolean;
  profile: boolean;
  policyChoice: boolean;
  review: boolean;
}): Record<ContractWorkspaceSection, boolean> {
  return {
    projectAndTarget: state.projectAndTarget,
    profiles: state.profile,
    policies: state.policyChoice,
    review: state.review,
  };
}

export default function QualityContractsPage() {
  return (
    <ProofgroveGate>
      <QualityContractsRouter />
    </ProofgroveGate>
  );
}

/**
 * `?setup=<runManifestId>&assignment=<id>&assignmentVersion=<v>` (built by
 * assignmentDetailsHref) means "show me this saved Assignment", not "start a new
 * one" — a details view, not an empty authoring session. `setup` alone (no
 * assignment identity) is a malformed link; there is nothing to look up.
 */
function QualityContractsRouter() {
  const searchParams = useSearchParams();
  const viewingSetup = Boolean(searchParams.get("setup")?.trim());
  const focus = assignmentFromSearchParams(searchParams);

  if (viewingSetup && focus) {
    return (
      <AssignmentDetailsWorkspace
        key={`${focus.assignmentId}@${focus.assignmentVersion}`}
        assignmentId={focus.assignmentId}
        version={focus.assignmentVersion}
      />
    );
  }

  if (viewingSetup) {
    return (
      <div className={PAGE_FRAME}>
        <PageHeader section="Configure" title="Assignment details" description="This Assignment link is missing its identity." />
        <ErrorState message="Reopen this Assignment from Evaluation governance." />
        <Link href="/contracts" className={`mt-4 inline-flex ${buttonVariants({ variant: "outline" })}`}>
          Back to Evaluation governance
        </Link>
      </div>
    );
  }

  return <QualityContractsWorkspace />;
}

/** Read-only: fetches one saved Assignment (+ its resolved manifest) by id/version and
 * renders it with SetupCompletionSummary in "viewing" mode. No wizard state, no Continue
 * buttons — this is what "View details" on an existing Assignment should land on. */
function AssignmentDetailsWorkspace({ assignmentId, version }: { assignmentId: string; version: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [assignment, setAssignment] = useState<EvaluationAssignmentVersion | null>(null);
  const [manifest, setManifest] = useState<ResolvedRunManifest | null>(null);
  const [project, setProject] = useState<EvaluationProject | null>(null);
  const [target, setTarget] = useState<TargetVersion | null>(null);
  const [profile, setProfile] = useState<QualityProfileVersion | null>(null);
  const [policy, setPolicy] = useState<ReleaseGatePolicyVersion | null>(null);
  const [runs, setRuns] = useState<RunResult[]>([]);
  const [runTotal, setRunTotal] = useState<number | null>(null);

  // The router key={assignmentId@version} remounts this component on identity
  // change, so "loading" is always the fresh initial state — no need to set it here.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { tenant_id } = await api.tenant();
        const loaded = await platformApi.getAssignment(assignmentId, version, tenant_id, true);
        const resolvedManifest = loaded.resolved_run_manifest ?? (await platformApi.getManifest(loaded.run_manifest_id, tenant_id));
        const [projects, targets, profiles, policies, allRuns] = await Promise.all([
          platformApi.listProjects(tenant_id),
          platformApi.listTargetVersions(loaded.project_id, tenant_id),
          platformApi.listProfiles(tenant_id),
          platformApi.listGatePolicies(tenant_id),
          // Filtered and counted in SQL. Loading a page of runs and filtering it
          // here reported "no runs" for anything outside that page, and a failed
          // fetch looked identical to none existing — on an evidence record both
          // read as a fact rather than a gap.
          evaluationApi.listRunsForManifest(tenant_id, loaded.run_manifest_id),
        ]);
        if (cancelled) return;
        setAssignment(loaded);
        setManifest(resolvedManifest);
        setProject(projects.find((item) => item.project_id === loaded.project_id) ?? null);
        setTarget(targets.find((item) => item.target_version_id === loaded.target_version_id) ?? null);
        setProfile(
          profiles.find((item) => item.profile_id === loaded.profile_id && item.version === loaded.profile_version) ?? null,
        );
        setPolicy(
          loaded.gate_policy_id
            ? policies.find(
                (item) => item.gate_policy_id === loaded.gate_policy_id && item.version === loaded.gate_policy_version,
              ) ?? null
            : null,
        );
        setRuns(allRuns.items);
        setRunTotal(allRuns.total);
        setState("ready");
      } catch (cause) {
        if (cancelled) return;
        setErrorMessage((cause as Error).message);
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assignmentId, version]);

  if (state === "loading") {
    return (
      <div className={PAGE_FRAME}>
        <PageHeader section="Configure" title="Assignment details" description="Loading the saved Assignment…" />
        <LoadingState label="Loading Assignment…" />
      </div>
    );
  }

  if (state === "error" || !manifest) {
    return (
      <div className={PAGE_FRAME}>
        <PageHeader section="Configure" title="Assignment details" description="This Assignment could not be opened." />
        <ErrorState message={errorMessage || "This Assignment could not be found."} />
        <Link href="/contracts" className={`mt-4 inline-flex ${buttonVariants({ variant: "outline" })}`}>
          Back to Evaluation governance
        </Link>
      </div>
    );
  }

  return (
    <div className={PAGE_FRAME}>
      <PageHeader
        section="Configure"
        title={assignment?.name || "Assignment"}
        description={`Version ${assignment?.version ?? ""} · what a run made under this Assignment was governed by.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {assignment ? (
              <Link
                href={evaluateHrefFromAssignment({
                  assignmentId: assignment.assignment_id,
                  version: assignment.version,
                })}
                className={buttonVariants({ size: "sm" })}
              >
                Run evaluation
              </Link>
            ) : null}
            <Link href="/contracts" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Evaluation governance
            </Link>
          </div>
        }
      />
      <AssignmentEvidence
        assignment={assignment}
        project={project}
        target={target}
        profile={profile}
        policy={policy}
        manifest={manifest}
        runs={runs}
        runTotal={runTotal}
      />
    </div>
  );
}

/**
 * What a run made under this Assignment was governed by.
 *
 * This replaced a reuse of the "Assignment saved" confirmation, which greeted
 * anyone opening a saved record with a success tick for something they had not
 * just done, and showed four fields the catalogue row already carried.
 */
function AssignmentEvidence({
  assignment,
  project,
  target,
  profile,
  policy,
  manifest,
  runs,
  runTotal,
}: {
  assignment: EvaluationAssignmentVersion | null;
  project: EvaluationProject | null;
  target: TargetVersion | null;
  profile: QualityProfileVersion | null;
  policy: ReleaseGatePolicyVersion | null;
  manifest: ResolvedRunManifest;
  runs: RunResult[];
  runTotal: number | null;
}) {
  const archived = Boolean(assignment?.archived_at);
  const released = !archived && assignment?.governance_state === "release_governed";
  // Colour carries status and nothing else, as on the run report. Release-governed
  // is the state that changes what a run can be used for, so it is the only one
  // that earns the positive treatment; standardized is a valid choice, not a warning.
  const state = archived
    ? { label: "Archived", meaning: "Kept for the record. New runs cannot be started from it." }
    : released
      ? {
          label: "Release-governed",
          meaning: "A run made under this Assignment can support a release decision, once it passes.",
        }
      : {
          label: "Standardized evaluation",
          meaning: "Runs are comparable and scored the same way, but are never release evidence.",
        };

  return (
    <div className="grid gap-4">
      {/* The hero: what this Assignment means, stated in words. */}
      <section
        className={cn(
          "overflow-hidden rounded-xl border bg-card shadow-sm",
          released && "border-state-positive/40",
        )}
      >
        <div className={cn("px-5 py-5 sm:px-6", released && "bg-state-positive-soft")}>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            <span
              className={cn(
                "size-2 rounded-full",
                released ? "bg-state-positive" : archived ? "bg-muted-foreground/40" : "bg-evalai-purple",
              )}
              aria-hidden="true"
            />
            Governance state
          </p>
          <h2
            className={cn(
              "mt-2 font-display text-2xl font-semibold tracking-tight",
              released && "text-state-positive",
            )}
          >
            {state.label}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{state.meaning}</p>
        </div>
        <dl className="grid gap-px border-t bg-border sm:grid-cols-3">
          {[
            ["Quality Profile", profile ? profile.name : assignment?.profile_id ?? "—", profile ? `version ${profile.version}` : ""],
            [
              "Gate Policy",
              policy ? policy.name : assignment?.gate_policy_id ?? "None",
              policy ? `version ${policy.version}` : "No release rules",
            ],
            ["Runs", runTotal === null ? "—" : String(runTotal), runTotal === 1 ? "run recorded" : "runs recorded"],
          ].map(([label, value, hint]) => (
            <div key={label} className="bg-card px-5 py-4">
              <dt className="text-xs uppercase tracking-[0.08em] text-muted-foreground">{label}</dt>
              <dd className="mt-1 truncate text-lg font-semibold" title={value}>{value}</dd>
              {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
            </div>
          ))}
        </dl>
      </section>

      {/* Quiet rows below, opened when wanted — the run report's shape. */}
      <EvidenceSection
        title="What it is bound to"
        description="The Project and exact target version these controls apply to."
        summary={target ? target.name : manifest.target_name ?? "Target unavailable"}
      >
        <dl className="grid gap-px bg-border sm:grid-cols-2">
          {[
            ["Project", project?.name ?? assignment?.project_id ?? "—"],
            [
              "Target",
              // The manifest snapshots the target's name at resolve time for
              // exactly this case. Falling straight through to a raw id made a
              // removed target unreadable, when the name was recorded and sat
              // one field away.
              target
                ? `${target.name} · ${target.target_type.replace("_", " ")} · ${target.environment}`
                : manifest.target_name
                  ? `${manifest.target_name} · no longer in the catalogue`
                  : assignment?.target_version_id ?? "—",
            ],
            ["Evidence required", manifest.evidence_requirements?.length ? manifest.evidence_requirements.join(", ") : "None recorded"],
            ["Version", assignment?.version ?? "—"],
          ].map(([label, value]) => (
            <div key={label} className="bg-card px-5 py-3">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 text-sm font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      </EvidenceSection>

      <EvidenceSection
        title="Provenance"
        description="Who bound these controls to this target, and when."
        summary={assignment?.created_by || "Not recorded"}
      >
        <dl className="grid gap-px bg-border sm:grid-cols-2">
          {[
            ["Created by", assignment?.created_by || "Not recorded"],
            ["Created", assignment?.created_at ? formatDateTime(assignment.created_at) : "Not recorded"],
            ["Owner", assignment?.owner || "Not recorded"],
            ["Purpose", assignment?.purpose || "Not recorded"],
            ["Previous version", assignment?.parent_assignment_version_id || "None — first version"],
            ["Change note", assignment?.change_note || "None"],
          ].map(([label, value]) => (
            <div key={label} className="bg-card px-5 py-3">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 text-sm">{value}</dd>
            </div>
          ))}
        </dl>
      </EvidenceSection>

      <EvidenceSection
        title="Runs under this Assignment"
        description="Evaluations that recorded this exact binding."
        summary={runTotal === null ? "Unavailable" : runTotal ? `${runTotal} ${runTotal === 1 ? "run" : "runs"}` : "None yet"}
      >
        {runs.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            No evaluation has been run under this Assignment yet. A run started from here records this
            binding and will appear in this list.
          </p>
        ) : (
          <ul role="list" className="divide-y">
            {runs.map((run) => (
              <li key={run.run_id}>
                <Link
                  href={`/runs/${encodeURIComponent(run.run_id)}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-muted/25"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{run.label || run.run_id}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {run.started_at ? formatDateTime(run.started_at) : "Not started"}
                    </span>
                  </span>
                  <Chip>{run.status || "unknown"}</Chip>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </EvidenceSection>

      <EvidenceSection title="Technical details" description="Identifiers for support and audit." summary="IDs">
        <dl className="grid gap-px bg-border font-mono text-xs sm:grid-cols-2">
          {[
            ["Assignment ID", assignment?.assignment_id ?? "—"],
            ["Run manifest", manifest.manifest_id],
            ["Project ID", assignment?.project_id ?? "—"],
            ["Target version ID", assignment?.target_version_id ?? "—"],
          ].map(([label, value]) => (
            <div key={label} className="bg-card px-5 py-3">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="mt-1 truncate" title={value}>{value}</dd>
            </div>
          ))}
        </dl>
      </EvidenceSection>
    </div>
  );
}

/** A collapsed row that opens — the shape the run report uses for its sections. */
function EvidenceSection({
  title,
  description,
  summary,
  children,
}: {
  title: string;
  description: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group overflow-hidden rounded-xl border bg-card shadow-sm">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 px-5 py-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="min-w-0">
          <span className="block text-base font-semibold tracking-tight">{title}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {summary}
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
        </span>
      </summary>
      <div className="border-t">{children}</div>
    </details>
  );
}

function QualityContractsWorkspace() {
  const [tenantId, setTenantId] = useState("");
  const [projects, setProjects] = useState<EvaluationProject[]>([]);
  const [targets, setTargets] = useState<TargetVersion[]>([]);
  const [catalogAgents, setCatalogAgents] = useState<TargetVersion[]>([]);
  const [profiles, setProfiles] = useState<QualityProfileVersion[]>([]);
  const [policies, setPolicies] = useState<ReleaseGatePolicyVersion[]>([]);
  const [loadStates, setLoadStates] = useState<LoadStates>(INITIAL_LOAD_STATES);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedTargetVersionId, setSelectedTargetVersionId] = useState("");
  const [selectedProfileKey, setSelectedProfileKey] = useState("");
  const [releasePolicyMode, setReleasePolicyMode] = useState<"none" | "configured">("none");
  const [selectedPolicyKey, setSelectedPolicyKey] = useState("");
  const [activeSection, setActiveSection] = useState<ContractWorkspaceSection>("projectAndTarget");
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [targetModalOpen, setTargetModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<"project" | "target" | "agent" | "save" | null>(null);
  const [assignmentName, setAssignmentName] = useState("");
  // The record persists a purpose, an owner and a change note, and the form
  // never asked for any of them, so every saved Assignment read "Not recorded"
  // on its own detail page.
  const [assignmentPurpose, setAssignmentPurpose] = useState("");
  const [assignmentOwner, setAssignmentOwner] = useState("");
  const [assignmentChangeNote, setAssignmentChangeNote] = useState("");
  const [feedback, setFeedback] = useState<(ContractSectionFeedbackMessage & { section: ContractWorkspaceSection }) | null>(null);
  const [error, setError] = useState("");
  const [resolvedManifest, setResolvedManifest] = useState<ResolvedRunManifest | null>(null);
  const [savedAssignment, setSavedAssignment] = useState<EvaluationAssignmentVersion | null>(null);
  const targetLoadGeneration = useRef(0);
  const agentLoadGeneration = useRef(0);

  const loadCatalogues = useCallback(async () => {
    if (!tenantId) return;
    setBusy(true);
    const agentGeneration = ++agentLoadGeneration.current;
    setLoadStates((current) => ({ ...current, projects: "loading", profiles: "loading", policies: "loading", agents: "loading" }));
    const [projectResult, profileResult, policyResult, agentResult] = await Promise.allSettled([
      platformApi.listProjects(tenantId),
      platformApi.listProfiles(tenantId),
      platformApi.listGatePolicies(tenantId),
      agentsApi.catalog(),
    ]);
    if (projectResult.status === "fulfilled") {
      setProjects(projectResult.value.filter((project) => project.status === "active"));
    }
    if (profileResult.status === "fulfilled") setProfiles(profileResult.value);
    if (policyResult.status === "fulfilled") setPolicies(policyResult.value);
    if (agentGeneration === agentLoadGeneration.current && agentResult.status === "fulfilled") {
      setCatalogAgents(agentResult.value);
    }
    setLoadStates((current) => ({
      ...current,
      projects: projectResult.status === "fulfilled" ? "ready" : "error",
      profiles: profileResult.status === "fulfilled" ? "ready" : "error",
      policies: policyResult.status === "fulfilled" ? "ready" : "error",
      agents:
        agentGeneration === agentLoadGeneration.current
          ? agentResult.status === "fulfilled" ? "ready" : "error"
          : current.agents,
    }));
    setBusy(false);
  }, [tenantId]);

  const loadAgentCatalog = useCallback(async () => {
    const generation = ++agentLoadGeneration.current;
    setLoadStates((current) => ({ ...current, agents: "loading" }));
    try {
      const nextAgents = await agentsApi.catalog();
      if (generation !== agentLoadGeneration.current) return;
      setCatalogAgents(nextAgents);
      setLoadStates((current) => ({ ...current, agents: "ready" }));
    } catch {
      if (generation !== agentLoadGeneration.current) return;
      setCatalogAgents([]);
      setLoadStates((current) => ({ ...current, agents: "error" }));
    }
  }, []);

  const loadTargets = useCallback(async (projectId: string) => {
    const generation = ++targetLoadGeneration.current;
    if (!tenantId || !projectId) {
      setTargets([]);
      setLoadStates((current) => ({ ...current, targets: "ready" }));
      return;
    }
    setLoadStates((current) => ({ ...current, targets: "loading" }));
    try {
      const listedTargets = await platformApi.listTargetVersions(projectId, tenantId);
      if (generation !== targetLoadGeneration.current) return;
      const nextTargets = listedTargets.filter((target) => target.project_id === projectId);
      setTargets(nextTargets);
      setSelectedTargetVersionId((current) =>
        nextTargets.some((target) => target.target_version_id === current) ? current : "",
      );
      setLoadStates((current) => ({ ...current, targets: "ready" }));
    } catch {
      if (generation !== targetLoadGeneration.current) return;
      setTargets([]);
      setSelectedTargetVersionId("");
      setLoadStates((current) => ({ ...current, targets: "error" }));
    }
  }, [tenantId]);

  useEffect(() => {
    let cancelled = false;
    api.tenant()
      .then(({ tenant_id }) => {
        if (!cancelled) setTenantId(tenant_id);
      })
      .catch((cause) => {
        if (!cancelled) setError((cause as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    const timer = window.setTimeout(() => void loadCatalogues(), 0);
    return () => window.clearTimeout(timer);
  }, [loadCatalogues, tenantId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadTargets(selectedProjectId), 0);
    return () => window.clearTimeout(timer);
  }, [loadTargets, selectedProjectId]);

  const activeProjectIds = useMemo(
    () => new Set(projects.map((project) => project.project_id)),
    [projects],
  );
  const visibleProfiles = useMemo(
    () => compatibleProfiles(profiles, selectedProjectId, activeProjectIds),
    [activeProjectIds, profiles, selectedProjectId],
  );

  // Only approved Profiles scoped to this Project (or unscoped) can be bound. Anything
  // filtered out disappears with no trace, which reads as "that Profile does not exist"
  // rather than "it is not eligible here" — so state the count and the reason.
  const hiddenProfileNote = useMemo(() => {
    if (!selectedProjectId || loadStates.profiles !== "ready") return null;
    const notApproved = profiles.filter((profile) => profile.status !== "approved").length;
    const otherProject = profiles.filter(
      (profile) =>
        profile.status === "approved" &&
        profile.project_id &&
        profile.project_id !== selectedProjectId,
    ).length;
    const reasons: string[] = [];
    if (notApproved > 0) reasons.push(`${notApproved} not yet approved`);
    if (otherProject > 0) reasons.push(`${otherProject} scoped to a different Project`);
    if (reasons.length === 0) return null;
    return `${reasons.join(" and ")} ${notApproved + otherProject === 1 ? "is" : "are"} not shown here. Approve a draft, or pick its Project, to use it.`;
  }, [profiles, selectedProjectId, loadStates.profiles]);
  const selectedProject = projects.find((project) => project.project_id === selectedProjectId) ?? null;
  const selectedTarget = targets.find(
    (target) =>
      target.target_version_id === selectedTargetVersionId &&
      target.project_id === selectedProjectId,
  ) ?? null;
  const selectedProfile = visibleProfiles.find((profile) => profileKey(profile) === selectedProfileKey) ?? null;
  const visiblePolicies = useMemo(
    () => compatiblePolicies(policies, selectedProfile),
    [policies, selectedProfile],
  );
  const selectedPolicy = visiblePolicies.find((policy) => policyKey(policy) === selectedPolicyKey) ?? null;
  const policyChoiceReady = releasePolicyMode === "none" || Boolean(selectedPolicy);
  const reviewReady = Boolean(selectedProject && selectedTarget && selectedProfile && policyChoiceReady);
  const readiness = contractSectionReadiness({
    projectAndTarget: Boolean(selectedProject && selectedTarget),
    profile: Boolean(selectedProfile),
    policyChoice: policyChoiceReady,
    review: reviewReady,
  });
  const activeIndex = WORKSPACE_FLOW.findIndex((step) => step.value === activeSection);
  const completed = WORKSPACE_FLOW.map((step, index) => index < activeIndex && readiness[step.value]);
  const available = WORKSPACE_FLOW.map((_step, index) => index <= activeIndex);

  function selectProject(projectId: string) {
    setSelectedProjectId(projectId);
    setSelectedTargetVersionId("");
    const nextProfiles = compatibleProfiles(profiles, projectId, activeProjectIds);
    const retainedProfile = nextProfiles.find((profile) => profileKey(profile) === selectedProfileKey) ?? null;
    if (!retainedProfile) {
      setSelectedProfileKey("");
      setSelectedPolicyKey("");
      setReleasePolicyMode("none");
    } else {
      const nextPolicies = compatiblePolicies(policies, retainedProfile);
      if (!nextPolicies.some((policy) => policyKey(policy) === selectedPolicyKey)) {
        setSelectedPolicyKey("");
        setReleasePolicyMode("none");
      }
    }
  }

  function selectProfile(key: string) {
    const nextProfile = visibleProfiles.find((profile) => profileKey(profile) === key) ?? null;
    setSelectedProfileKey(key);
    const nextPolicies = compatiblePolicies(policies, nextProfile);
    if (!nextPolicies.some((policy) => policyKey(policy) === selectedPolicyKey)) {
      setSelectedPolicyKey("");
      setReleasePolicyMode("none");
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const projectId = crypto.randomUUID();
    setPending("project");
    try {
      await platformApi.createProject({
        project_id: projectId,
        tenant_id: tenantId,
        name: String(form.get("name")),
        system_type: "application",
        owner: String(form.get("owner")),
        status: "active",
        tags: {},
      });
      await loadCatalogues();
      selectProject(projectId);
      setProjectModalOpen(false);
      setFeedback({ section: "projectAndTarget", tone: "success", message: "Project created." });
    } catch (cause) {
      setFeedback({ section: "projectAndTarget", tone: "error", message: (cause as Error).message });
    } finally {
      setPending(null);
    }
  }

  async function createTarget(form: FormData) {
    if (!selectedProjectId) return;
    const targetVersionId = crypto.randomUUID();
    setPending("target");
    try {
      await platformApi.createTargetVersion(selectedProjectId, {
        target_version_id: targetVersionId,
        target_id: String(form.get("target_id")),
        project_id: selectedProjectId,
        tenant_id: tenantId,
        name: String(form.get("name")),
        version: String(form.get("version")),
        endpoint: String(form.get("endpoint")),
        target_type: String(form.get("target_type")) as TargetVersion["target_type"],
        environment: String(form.get("environment")),
        model_version: String(form.get("model_version")) || null,
        prompt_version: String(form.get("prompt_version")) || null,
        tool_versions: {},
        configuration: {},
      });
      await loadTargets(selectedProjectId);
      setSelectedTargetVersionId(targetVersionId);
      setTargetModalOpen(false);
      setFeedback({ section: "projectAndTarget", tone: "success", message: "Target registered." });
    } catch (cause) {
      setFeedback({ section: "projectAndTarget", tone: "error", message: (cause as Error).message });
    } finally {
      setPending(null);
    }
  }

  async function addCatalogAgent(agent: TargetVersion) {
    if (!selectedProjectId) return;
    const targetVersionId = crypto.randomUUID();
    setPending("agent");
    try {
      await platformApi.createTargetVersion(selectedProjectId, {
        ...agent,
        target_version_id: targetVersionId,
        project_id: selectedProjectId,
        tenant_id: tenantId,
        configuration: { ...agent.configuration, source_catalog_target_version_id: agent.target_version_id },
      });
      await loadTargets(selectedProjectId);
      setSelectedTargetVersionId(targetVersionId);
      setFeedback({ section: "projectAndTarget", tone: "success", message: `${agent.name} was added to the Project.` });
    } catch (cause) {
      setFeedback({ section: "projectAndTarget", tone: "error", message: (cause as Error).message });
      throw cause;
    } finally {
      setPending(null);
    }
  }

  async function finishSetup() {
    if (
      !reviewReady ||
      !selectedProject ||
      !selectedTarget ||
      selectedTarget.project_id !== selectedProject.project_id ||
      !selectedProfile ||
      pending
    ) return;
    setPending("save");
    setFeedback(null);
    let assignment = savedAssignment;
    try {
      assignment ??= await platformApi.createAssignment({
        tenant_id: tenantId,
        project_id: selectedProject.project_id,
        target_version_id: selectedTarget.target_version_id,
        profile_id: selectedProfile.profile_id,
        profile_version: selectedProfile.version,
        gate_policy_id: selectedPolicy?.gate_policy_id,
        gate_policy_version: selectedPolicy?.version,
        name: assignmentName.trim() || undefined,
        purpose: assignmentPurpose.trim() || undefined,
        owner: assignmentOwner.trim() || undefined,
        change_note: assignmentChangeNote.trim() || undefined,
        created_by: "proofgrove-ui",
      });
      setSavedAssignment(assignment);
      const manifest = assignment.resolved_run_manifest ?? await platformApi.getManifest(assignment.run_manifest_id, tenantId);
      setResolvedManifest(manifest);
    } catch (cause) {
      setFeedback({ section: "review", tone: "error", message: assignment ? "The Assignment was saved, but its details could not be loaded. Retry loading the details." : (cause as Error).message });
    } finally {
      setPending(null);
    }
  }

  function stepState(section: ContractWorkspaceSection): SetupStepState {
    if (section === activeSection) return "active";
    const order = WORKSPACE_FLOW.findIndex((step) => step.value === section);
    return order < activeIndex && readiness[section] ? "complete" : "upcoming";
  }

  const navigation = (
    <WorkspaceNavigation
      active={activeSection}
      canContinue={readiness[activeSection]}
      finishing={pending === "save"}
      onFinish={finishSetup}
      onChange={(section) => {
        setFeedback(null);
        setActiveSection(section);
      }}
    />
  );

  if (resolvedManifest) {
    return (
      <div className={PAGE_FRAME}>
        <PageHeader section="Configure" title="New Assignment" description="Assignment saved with immutable governance versions." />
        <SetupCompletionSummary
          project={selectedProject}
          target={selectedTarget}
          profile={selectedProfile}
          policy={selectedPolicy}
          manifest={resolvedManifest}
          assignment={savedAssignment}
          onEdit={() => {
            setResolvedManifest(null);
            setSavedAssignment(null);
            setActiveSection("projectAndTarget");
          }}
        />
      </div>
    );
  }

  if (savedAssignment) {
    return (
      <div className={PAGE_FRAME}>
        <PageHeader section="Configure" title="Assignment saved" description="Your Assignment is saved. Load its resolved details to continue." />
        <ContractSectionFeedback feedback={feedback?.section === "review" ? feedback : null} />
        <Button type="button" onClick={() => void finishSetup()} disabled={Boolean(pending)}>
          {pending ? "Loading details…" : "Retry loading details"}
        </Button>
        <Link href={assignmentPermalinkPath({ assignmentId: savedAssignment.assignment_id, version: savedAssignment.version })} className={buttonVariants({ variant: "outline" })}>Open saved Assignment</Link>
      </div>
    );
  }

  return (
    <div className={PAGE_FRAME}>
      <PageHeader
        section="Configure"
        title="New Assignment"
        description="Choose a Project and target, then bind approved quality and optional release governance."
        actions={
          <>
            <Link href="/contracts" className={buttonVariants({ variant: "outline", size: "sm", className: "shrink-0" })}>
              Evaluation governance
            </Link>
            <Button type="button" variant="outline" size="sm" aria-label="Refresh assignment setup" onClick={() => void loadCatalogues()} disabled={busy || Boolean(pending)}>
              <RefreshCw className={`mr-2 size-4 ${busy ? "animate-spin" : ""}`} aria-hidden="true" />
              {busy ? "Refreshing…" : "Refresh"}
            </Button>
          </>
        }
      />
      {error ? <div role="alert" className="mb-5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">{error}</div> : null}

      <SetupProgress
        label="Assignment setup progress"
        currentStep={activeIndex + 1}
        completed={completed}
        available={available}
        steps={WORKSPACE_FLOW.map((step) => step.label)}
        onStepSelect={(step) => setActiveSection(WORKSPACE_FLOW[step - 1]!.value)}
      />

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_270px]">
        <div className="grid gap-4">
          <SetupStepSection
            id="contract-step-project-target"
            number="1"
            title="Project & target"
            description="Select an active Project first, then choose or register its target."
            state={stepState("projectAndTarget")}
            summary={selectedProject && selectedTarget ? `${selectedProject.name} · ${selectedTarget.name}` : "Choose a Project and target"}
            onEdit={() => setActiveSection("projectAndTarget")}
            actionLabel="Change Project or target"
          >
            <ContractSectionFeedback feedback={feedback?.section === "projectAndTarget" ? feedback : null} />
            <h3 className="mb-3 text-sm font-semibold">Project</h3>
            <ContractProjectsPanel
              projects={projects}
              selectedProjectId={selectedProjectId}
              createOpen={projectModalOpen}
              onSelect={selectProject}
              onCreateOpenChange={setProjectModalOpen}
              onSubmit={createProject}
              submitting={pending === "project"}
              actionsDisabled={Boolean(pending)}
              loadState={loadStates.projects}
            />
            {selectedProject ? (
              <div className="mt-6 border-t pt-6">
                <h3 className="mb-3 text-sm font-semibold">Target</h3>
                <ContractTargetsPanel
                  project={selectedProject}
                  targets={targets}
                  catalogAgents={catalogAgents}
                  customOpen={targetModalOpen}
                  selectedTargetVersionId={selectedTargetVersionId}
                  onSelect={(targetVersionId) => {
                    const target = targets.find((item) => item.target_version_id === targetVersionId);
                    setSelectedTargetVersionId(target?.project_id === selectedProjectId ? targetVersionId : "");
                  }}
                  onAddAgent={addCatalogAgent}
                  onCustomOpenChange={setTargetModalOpen}
                  onSubmit={createTarget}
                  submitting={pending === "target"}
                  actionsDisabled={Boolean(pending)}
                  pendingAgentId={pending === "agent" ? "pending" : null}
                  loadState={loadStates.targets}
                  catalogLoadState={loadStates.agents}
                  onRetryCatalog={loadAgentCatalog}
                />
              </div>
            ) : null}
            {navigation}
          </SetupStepSection>

          <SetupStepSection
            id="contract-step-profiles"
            number="2"
            title="Quality Profile"
            description="Choose an approved Profile compatible with the selected Project."
            state={stepState("profiles")}
            summary={selectedProfile ? `${selectedProfile.name} · version ${selectedProfile.version}` : "Choose an approved Quality Profile"}
            onEdit={() => setActiveSection("profiles")}
            actionLabel="Change Profile"
          >
            <ContractProfilesPanel
              profiles={visibleProfiles}
              selectedProfileKey={selectedProfileKey}
              onSelect={selectProfile}
              loadState={loadStates.profiles}
              actionsDisabled={Boolean(pending)}
              hiddenNote={hiddenProfileNote}
            />
            {navigation}
          </SetupStepSection>

          <SetupStepSection
            id="contract-step-policies"
            number="3"
            title="Gate Policy"
            description="Keep None for standardized evaluation, or choose a compatible approved release policy."
            state={stepState("policies")}
            summary={releasePolicyMode === "none" ? "None · Standardized evaluation" : selectedPolicy ? `${selectedPolicy.name} · version ${selectedPolicy.version}` : "Choose a Gate Policy"}
            onEdit={() => setActiveSection("policies")}
            actionLabel="Change Gate Policy"
          >
            <ContractPoliciesPanel
              policies={visiblePolicies}
              mode={releasePolicyMode}
              selectedPolicyKey={selectedPolicyKey}
              onModeChange={(mode) => {
                setReleasePolicyMode(mode);
                if (mode === "none") setSelectedPolicyKey("");
              }}
              onSelect={setSelectedPolicyKey}
              loadState={loadStates.policies}
              actionsDisabled={Boolean(pending)}
            />
            {navigation}
          </SetupStepSection>

          <SetupStepSection
            id="contract-step-review"
            number="4"
            title="Review & save"
            description="Confirm the immutable Assignment binding before saving."
            state={stepState("review")}
            summary="Review the selected Assignment"
            onEdit={() => setActiveSection("review")}
          >
            <ContractSectionFeedback feedback={feedback?.section === "review" ? feedback : null} />
            <AssignmentReview
              project={selectedProject}
              target={selectedTarget}
              profile={selectedProfile}
              policy={selectedPolicy}
              name={assignmentName}
              onNameChange={setAssignmentName}
              purpose={assignmentPurpose}
              onPurposeChange={setAssignmentPurpose}
              owner={assignmentOwner}
              onOwnerChange={setAssignmentOwner}
              changeNote={assignmentChangeNote}
              onChangeNoteChange={setAssignmentChangeNote}
              suggestedName={
                selectedProfile
                  ? `${selectedProfile.name}${selectedPolicy ? ` + ${selectedPolicy.name}` : ""} on ${selectedTarget?.name ?? ""}`.trim()
                  : ""
              }
            />
            {navigation}
          </SetupStepSection>
        </div>

        <AssignmentSummary
          project={selectedProject}
          target={selectedTarget}
          profile={selectedProfile}
          policy={selectedPolicy}
          mode={releasePolicyMode}
        />
      </div>
    </div>
  );
}

function WorkspaceNavigation({
  active,
  canContinue,
  finishing,
  onFinish,
  onChange,
}: {
  active: ContractWorkspaceSection;
  canContinue: boolean;
  finishing: boolean;
  onFinish: () => Promise<void>;
  onChange: (section: ContractWorkspaceSection) => void;
}) {
  const index = WORKSPACE_FLOW.findIndex((step) => step.value === active);
  const previous = index > 0 ? WORKSPACE_FLOW[index - 1] : null;
  const next = index < WORKSPACE_FLOW.length - 1 ? WORKSPACE_FLOW[index + 1] : null;
  return (
    <nav aria-label="Contract setup navigation" className="mt-4 flex items-center justify-between gap-3">
      {previous ? (
        <Button type="button" variant="outline" onClick={() => onChange(previous.value)}><ChevronLeft className="mr-2 size-4" aria-hidden="true" />Back</Button>
      ) : (
        <Link href="/contracts" className={buttonVariants({ variant: "outline" })}>Cancel</Link>
      )}
      {next ? (
        <Button type="button" disabled={!canContinue} onClick={() => onChange(next.value)}>
          Continue to {next.label}<ChevronRight className="ml-2 size-4" aria-hidden="true" />
        </Button>
      ) : (
        <Button type="button" disabled={!canContinue || finishing} onClick={() => void onFinish()}>
          {finishing ? <LoaderCircle className="mr-2 size-4 animate-spin" aria-hidden="true" /> : null}
          {finishing ? "Saving…" : "Save Assignment"}
        </Button>
      )}
    </nav>
  );
}

/** Persistent read of the in-progress binding, next to the active step rather than
 * above it, so a choice made in step 3 is visibly still there while step 1 is open. */
function AssignmentSummary({ project, target, profile, policy, mode }: {
  project: EvaluationProject | null;
  target: TargetVersion | null;
  profile: QualityProfileVersion | null;
  policy: ReleaseGatePolicyVersion | null;
  mode: "none" | "configured";
}) {
  const rows: Array<{ label: string; value: string; hint?: string | null }> = [
    { label: "Project", value: project?.name ?? "Choose in step 1" },
    {
      label: "Target",
      value: target?.name ?? "Choose in step 1",
      hint: target ? [target.environment, target.model_version || target.version].filter(Boolean).join(" · ") : null,
    },
    { label: "Quality Profile", value: profile?.name ?? "Choose in step 2" },
    { label: "Gate Policy", value: mode === "none" ? "Optional · none chosen" : policy?.name ?? "Choose in step 3" },
    { label: "Resulting state", value: mode === "none" ? "Standardized evaluation" : policy ? "Release-governed" : "Not determined yet" },
  ];
  return (
    // Full height so the rail squares off against the step column rather than
    // ending halfway down it. The contents stay sticky inside, so the summary
    // still follows you down a long step.
    <aside aria-label="Assignment summary" className="rounded-xl border bg-card px-4 py-4 lg:h-full">
      <div className="lg:sticky lg:top-6">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Assignment summary</p>
      <dl className="mt-3 divide-y">
        {rows.map((row) => (
          <div key={row.label} className="py-2.5 first:pt-0 last:pb-0">
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className="mt-0.5 truncate text-sm font-semibold" title={row.value}>
              {row.value}
              {row.hint ? <span className="ml-1.5 truncate text-xs font-normal text-muted-foreground">{row.hint}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      </div>
    </aside>
  );
}

function AssignmentReview({
  project,
  target,
  profile,
  policy,
  name,
  onNameChange,
  suggestedName,
  purpose,
  onPurposeChange,
  owner,
  onOwnerChange,
  changeNote,
  onChangeNoteChange,
}: {
  project: EvaluationProject | null;
  target: TargetVersion | null;
  profile: QualityProfileVersion | null;
  policy: ReleaseGatePolicyVersion | null;
  name: string;
  onNameChange: (value: string) => void;
  suggestedName: string;
  purpose: string;
  onPurposeChange: (value: string) => void;
  owner: string;
  onOwnerChange: (value: string) => void;
  changeNote: string;
  onChangeNoteChange: (value: string) => void;
}) {
  const governance = policy ? "Release-governed" : "Standardized evaluation";
  return (
    <div className="rounded-xl border bg-card">
      {/* Named here rather than generated. Every Assignment on one target used to
          be called "Project · target", so a list of them read as the same string
          repeated and the picker could not tell them apart. */}
      <div className="border-b px-4 py-3">
        <label htmlFor="assignment-name" className="block text-sm font-medium">Name</label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          How this Assignment is listed. Leave blank to use the suggestion.
        </p>
        <Input
          id="assignment-name"
          inputSize="sm"
          className="mt-2"
          value={name}
          placeholder={suggestedName || "Name this Assignment"}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </div>
      {/* Optional, and asked for once, here. The detail page prints these back
          as the record of why a governed configuration exists and who stands
          behind it; unasked, it printed "Not recorded" every time. */}
      <div className="grid gap-4 border-b px-4 py-3 sm:grid-cols-2">
        <div>
          <label htmlFor="assignment-owner" className="block text-sm font-medium">Owner</label>
          <p className="mt-0.5 text-xs text-muted-foreground">Who to ask about this Assignment.</p>
          <Input
            id="assignment-owner"
            inputSize="sm"
            className="mt-2"
            value={owner}
            placeholder="Team or person"
            onChange={(event) => onOwnerChange(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="assignment-purpose" className="block text-sm font-medium">Purpose</label>
          <p className="mt-0.5 text-xs text-muted-foreground">What this Assignment is for.</p>
          <Input
            id="assignment-purpose"
            inputSize="sm"
            className="mt-2"
            value={purpose}
            placeholder="Release scoring for claims"
            onChange={(event) => onPurposeChange(event.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="assignment-change-note" className="block text-sm font-medium">Change note</label>
          <p className="mt-0.5 text-xs text-muted-foreground">Why this version exists. Read by whoever inherits it.</p>
          <Input
            id="assignment-change-note"
            inputSize="sm"
            className="mt-2"
            value={changeNote}
            placeholder="First governed configuration for this target"
            onChange={(event) => onChangeNoteChange(event.target.value)}
          />
        </div>
      </div>
      <dl className="grid gap-px bg-border sm:grid-cols-2">
        {[
          ["Project", project?.name ?? "Not selected"],
          ["Target", target ? `${target.name} · ${target.target_type.replace("_", " ")} · ${target.environment} · ${target.model_version || target.version}` : "Not selected"],
          ["Quality Profile", profile ? `${profile.name} · version ${profile.version}` : "Not selected"],
          ["Gate Policy", policy ? `${policy.name} · version ${policy.version}` : "None"],
          ["Resulting state", governance],
        ].map(([label, value], index, cells) => (
          <div
            key={label}
            className={cn(
              "bg-card px-4 py-3",
              // A lone final cell in a two-column grid leaves the empty slot
              // painted in the grid's gap colour. Span it instead.
              index === cells.length - 1 && cells.length % 2 === 1 && "sm:col-span-2",
            )}
          >
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-sm font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <details className="border-t px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold">Technical details</summary>
        <dl className="mt-3 grid gap-2 font-mono text-xs text-muted-foreground">
          <div><dt>Project ID</dt><dd>{project?.project_id ?? "—"}</dd></div>
          <div><dt>Target version ID</dt><dd>{target?.target_version_id ?? "—"}</dd></div>
          <div><dt>Profile ID/version</dt><dd>{profile ? `${profile.profile_id}@${profile.version}` : "—"}</dd></div>
          <div><dt>Policy ID/version</dt><dd>{policy ? `${policy.gate_policy_id}@${policy.version}` : "None"}</dd></div>
        </dl>
      </details>
    </div>
  );
}

export function SetupCompletionSummary({
  project,
  target,
  profile,
  policy,
  manifest,
  assignment = null,
  onEdit,
  mode = "saved",
}: {
  project: EvaluationProject | null;
  target: TargetVersion | null;
  profile: QualityProfileVersion | null;
  policy: ReleaseGatePolicyVersion | null;
  manifest: ResolvedRunManifest;
  assignment?: EvaluationAssignmentVersion | null;
  onEdit?: () => void;
  /** "saved" is the just-finished-the-wizard moment; "viewing" is landing on an
   * already-saved Assignment via a deep link — no self-referential "View details"
   * link, no "Create revision" action, and a heading that names the Assignment. */
  mode?: "saved" | "viewing";
}) {
  const viewing = mode === "viewing";
  const runHref = assignment ? evaluateHrefFromAssignment({ assignmentId: assignment.assignment_id, version: assignment.version }) : null;
  const detailsHref = assignmentDetailsHref({ runManifestId: manifest.manifest_id, assignmentId: assignment?.assignment_id, version: assignment?.version });
  const permalink = assignment ? assignmentPermalinkPath({ assignmentId: assignment.assignment_id, version: assignment.version }) : "/contracts";
  return (
    <section id="saved-setup" aria-labelledby="saved-setup-title" className="mb-5 overflow-hidden rounded-xl border border-state-positive/30 bg-state-positive-soft">
      <div className="flex flex-col gap-4 border-b border-state-positive/30 px-5 py-5 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:px-6">
        <div className="grid max-w-[42rem] grid-cols-[1.5rem_minmax(0,1fr)] gap-3">
          <CheckCircle2 className="size-6 text-state-positive" aria-hidden="true" />
          <div>
            <p className="text-xs font-semibold uppercase text-state-positive">{viewing ? "Assignment details" : "Saved successfully"}</p>
            <h2 id="saved-setup-title" className="text-xl font-semibold">
              {viewing && assignment ? `${assignment.name} · version ${assignment.version}` : "Assignment saved"}
            </h2>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {runHref ? <Link href={runHref} className={buttonVariants()}>Run evaluation with this Assignment</Link> : null}
          {viewing ? null : <Link href={detailsHref} className={buttonVariants({ variant: "outline" })}>View details</Link>}
          <Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}${permalink}`).catch(() => undefined)}>Copy link</Button>
          {viewing || !onEdit ? null : <Button type="button" variant="outline" onClick={onEdit}><Pencil className="mr-2 size-4" aria-hidden="true" />Create revision</Button>}
        </div>
      </div>
      <dl className="grid gap-px bg-state-positive/25 sm:grid-cols-2 lg:grid-cols-4">
        {[["Project", project?.name ?? manifest.project_id], ["Target", target?.name ?? manifest.target_id], ["Quality Profile", profile?.name ?? manifest.quality_profile_id], ["Gate Policy", policy?.name ?? "No Gate Policy"]].map(([label, value]) => <div key={label} className="bg-white/85 px-5 py-4"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-sm font-semibold">{value}</dd></div>)}
      </dl>
      <div className="border-t border-state-positive/30 bg-white/80 px-5 py-4">
        <h3 className="text-sm font-semibold">Resolved configuration</h3>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">Governance level</dt><dd className="text-sm">{manifest.gate_policy_id ? "Release-governed" : "Standardized evaluation"}</dd></div><div><dt className="text-xs text-muted-foreground">Evidence required</dt><dd className="text-sm">{manifest.evidence_requirements.join(", ") || "None recorded"}</dd></div></dl>
      </div>
    </section>
  );
}
