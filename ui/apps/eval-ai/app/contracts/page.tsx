"use client";

import { cn } from "@evalai/shared/utils";
import { COLUMN_HEADER, PAGE_FRAME } from "@/lib/page-frame";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronUp, RefreshCw } from "lucide-react";
import { Button, buttonVariants } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { NavTab, NavTabs } from "@/components/ui/tabs";
import { ProofgroveGate } from "@/components/proofgrove-gate";
import {
  GovernanceCreateDialog,
  type PolicyDraftInput,
  type ProfileDraftInput,
} from "@/components/governance-create-dialog";
import {
  GovernanceRecordDrawer,
  type GovernanceRecordSelection,
} from "@/components/governance-record-drawer";
import {
  AssignmentRowActions,
  GovernanceRowActions,
  type GovernanceLifecycleAction,
  type GovernanceRecord,
} from "@/components/governance-row-actions";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/page-state";
import { Chip, StatusBadge } from "@/components/status-badge";
import { FilterSelect, SearchField, SegmentedControl } from "@/components/toolbar";
import { formatDateTime } from "@/lib/format-time";
import {
  api,
  evaluationApi,
  platformApi,
  type EvaluationAssignmentVersion,
  type MetricCatalogEntry,
  type QualityProfileVersion,
  type ReleaseGatePolicyVersion,
  type RunResult,
} from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import {
  assignmentDetailsHref,
  assignmentFromSearchParams,
  assignmentPermalinkPath,
  evaluateHrefFromAssignment,
} from "@/lib/assignment-links";
import {
  filterAndSortCatalogue,
  type CatalogueSort,
} from "@/lib/governance-catalogue";
import { governanceTabHref, readGovernanceTab } from "@/lib/governance-tabs";
import { partialLoadMessage, settledOr } from "@/lib/partial-load";

type AssignmentShelf = "active" | "archived";
type GovernanceFilter = "all" | "standardized_evaluation" | "release_governed";
type LifecycleFilter = "all" | "draft" | "validated" | "approved" | "retired";

export default function EvaluationGovernancePage() {
  return (
    <ProofgroveGate>
      <EvaluationGovernanceHome />
    </ProofgroveGate>
  );
}

function EvaluationGovernanceHome() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedRecord = useMemo(
    () => governanceSelectionFromSearchParams(searchParams),
    [searchParams],
  );
  const activeTab = selectedRecord
    ? selectedRecord.kind === "profile"
      ? "profiles"
      : "policies"
    : readGovernanceTab(searchParams);
  const [assignments, setAssignments] = useState<EvaluationAssignmentVersion[]>([]);
  const [profiles, setProfiles] = useState<QualityProfileVersion[]>([]);
  const [policies, setPolicies] = useState<ReleaseGatePolicyVersion[]>([]);
  const [metrics, setMetrics] = useState<MetricCatalogEntry[]>([]);
  const [canAuthor, setCanAuthor] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partialLoad, setPartialLoad] = useState<string | null>(null);
  const [assignmentShelf, setAssignmentShelf] = useState<AssignmentShelf>("active");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const assignmentFocus = assignmentFromSearchParams(new URLSearchParams(searchParams.toString()));
  const highlightedAssignmentKey = assignmentFocus ? `${assignmentFocus.assignmentId}@${assignmentFocus.assignmentVersion}` : null;
  const [assignmentQuery, setAssignmentQuery] = useState("");
  const [assignmentSort, setAssignmentSort] = useState<CatalogueSort>("newest");
  const [assignmentFilter, setAssignmentFilter] = useState<GovernanceFilter>("all");
  const [profileQuery, setProfileQuery] = useState("");
  const [profileSort, setProfileSort] = useState<CatalogueSort>("newest");
  const [profileFilter, setProfileFilter] = useState<LifecycleFilter>("all");
  const [policyQuery, setPolicyQuery] = useState("");
  const [policySort, setPolicySort] = useState<CatalogueSort>("newest");
  const [policyFilter, setPolicyFilter] = useState<LifecycleFilter>("all");
  const [retireRecord, setRetireRecord] = useState<GovernanceRecord | null>(null);
  const [overrideProfile, setOverrideProfile] = useState<QualityProfileVersion | null>(null);
  // Marking tested now names the run whose evidence was scored against the
  // Profile, so it needs the same shape of dialog the override already has.
  const [testProfile, setTestProfile] = useState<QualityProfileVersion | null>(null);
  const [testRunId, setTestRunId] = useState("");
  const [testRuns, setTestRuns] = useState<RunResult[]>([]);
  const [testError, setTestError] = useState<string | null>(null);
  const [overrideNote, setOverrideNote] = useState("");
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const focusHandled = useRef(false);
  const loadGeneration = useRef(0);
  const activeCatalogueTabRef = useRef<HTMLAnchorElement | null>(null);
  const createKind =
    searchParams.get("create") === "profile" && activeTab === "profiles"
      ? "profile"
      : searchParams.get("create") === "policy" && activeTab === "policies"
        ? "policy"
        : null;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("setup") || params.has("new")) {
      router.replace(`/contracts/new${window.location.search}${window.location.hash}`);
      return;
    }
  }, [router]);

  const load = useCallback(async (background = false) => {
    const generation = ++loadGeneration.current;
    if (!background) {
      setLoading(true);
      setActionSuccess(null);
    }
    setError(null);
    setPartialLoad(null);
    setActionError(null);
    try {
      const { tenant_id } = await api.tenant();
      if (generation !== loadGeneration.current) return;
      const missing: string[] = [];
      // One Assignments fetch covers Active and Archived shelves; switching
      // shelves filters client-side so deep-link focus does not fire a second
      // listAssignments (the first-navigation 429 root cause).
      const [assignmentsResult, profilesResult, policiesResult, capabilitiesResult, metricsResult] =
        await Promise.allSettled([
          platformApi.listAssignments(tenant_id, {
            includeArchived: true,
          }),
          platformApi.listProfiles(tenant_id),
          platformApi.listGatePolicies(tenant_id),
          platformApi.capabilities(tenant_id),
          evaluationApi.listMetrics(),
        ]);
      if (generation !== loadGeneration.current) return;
      const listed = settledOr(assignmentsResult, [], "Assignments", missing);
      if (!focusHandled.current && highlightedAssignmentKey) {
        const match = listed.find(
          (item) => `${item.assignment_id}@${item.version}` === highlightedAssignmentKey,
        );
        if (match?.archived_at) setAssignmentShelf("archived");
        focusHandled.current = true;
      }
      setAssignments(listed);
      setProfiles(settledOr(profilesResult, [], "Quality Profiles", missing));
      setPolicies(settledOr(policiesResult, [], "Gate Policies", missing));
      setMetrics(settledOr(metricsResult, [], "metrics", missing));
      const capabilities =
        capabilitiesResult.status === "fulfilled"
          ? capabilitiesResult.value
          : { actions: {} };
      setCanAuthor(capabilities.actions.author_governance === true);
      setPartialLoad(partialLoadMessage(missing));
    } catch (err) {
      if (generation !== loadGeneration.current) return;
      setError(userFacingError(err));
    } finally {
      if (generation === loadGeneration.current && !background) setLoading(false);
    }
  }, [highlightedAssignmentKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const visibleAssignments = useMemo(() => {
    const shelfRows = assignments.filter((item) =>
      assignmentShelf === "archived" ? Boolean(item.archived_at) : !item.archived_at,
    );
    const governanceFiltered =
      assignmentFilter === "all"
        ? shelfRows
        : shelfRows.filter((item) => item.governance_state === assignmentFilter);
    return filterAndSortCatalogue(governanceFiltered, {
      query: assignmentQuery,
      sort: assignmentSort,
      fields: (item) => [item.name, item.assignment_id, item.purpose],
    });
  }, [assignmentFilter, assignmentQuery, assignmentShelf, assignmentSort, assignments]);

  const visibleProfiles = useMemo(() => {
    const lifecycleFiltered =
      profileFilter === "all" ? profiles : profiles.filter((item) => item.status === profileFilter);
    return filterAndSortCatalogue(lifecycleFiltered, {
      query: profileQuery,
      sort: profileSort,
      fields: (item) => [item.name, item.profile_id, item.description],
    });
  }, [profileFilter, profileQuery, profileSort, profiles]);

  const visiblePolicies = useMemo(() => {
    const lifecycleFiltered =
      policyFilter === "all" ? policies : policies.filter((item) => item.status === policyFilter);
    return filterAndSortCatalogue(lifecycleFiltered, {
      query: policyQuery,
      sort: policySort,
      fields: (item) => [item.name, item.gate_policy_id, item.description],
    });
  }, [policies, policyFilter, policyQuery, policySort]);

  const activeAssignmentCount = useMemo(
    () => assignments.filter((item) => !item.archived_at).length,
    [assignments],
  );

  const selectedProfile =
    selectedRecord?.kind === "profile"
      ? profiles.find(
          (profile) =>
            profile.profile_id === selectedRecord.id && profile.version === selectedRecord.version,
        ) ?? null
      : null;
  const selectedPolicy =
    selectedRecord?.kind === "policy"
      ? policies.find(
          (policy) =>
            policy.gate_policy_id === selectedRecord.id &&
            policy.version === selectedRecord.version,
        ) ?? null
      : null;
  const selectedProduct = selectedRecord?.kind === "profile" ? "Quality Profile" : "Gate Policy";
  const selectedCatalogueUnavailable = selectedRecord
    ? partialLoad?.includes(selectedRecord.kind === "profile" ? "Quality Profiles" : "Gate Policies") ?? false
    : false;

  function replaceRecordSelection(selection: GovernanceRecordSelection | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (selection) {
      const tab = selection.kind === "profile" ? "profiles" : "policies";
      params.set("tab", tab);
      params.delete(selection.kind === "profile" ? "policy" : "profile");
      params.set(selection.kind, `${selection.id}@${selection.version}`);
    } else {
      if (selectedRecord) params.delete(selectedRecord.kind);
      params.set("tab", activeTab);
    }
    router.replace(`/contracts?${params.toString()}`);
  }

  function openRecord(record: GovernanceRecord) {
    replaceRecordSelection(
      record.kind === "profile"
        ? { kind: "profile", id: record.value.profile_id, version: record.value.version }
        : { kind: "policy", id: record.value.gate_policy_id, version: record.value.version },
    );
  }

  function closeCreateDialog() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("create");
    params.set("tab", activeTab);
    setCreateError(null);
    router.replace(`/contracts?${params.toString()}`);
  }

  async function createProfile(input: ProfileDraftInput) {
    setCreatePending(true);
    setCreateError(null);
    try {
      const { tenant_id } = await api.tenant();
      await platformApi.createProfile({
        ...input,
        tenant_id,
        project_id: null,
        status: "draft",
      });
      await load(true);
      closeCreateDialog();
      setActionSuccess(`${input.name} was created as a draft.`);
    } catch (err) {
      setCreateError(userFacingError(err));
    } finally {
      setCreatePending(false);
    }
  }

  async function createPolicy(input: PolicyDraftInput) {
    setCreatePending(true);
    setCreateError(null);
    try {
      const { tenant_id } = await api.tenant();
      await platformApi.createGatePolicy({
        ...input,
        tenant_id,
        status: "draft",
      });
      await load(true);
      closeCreateDialog();
      setActionSuccess(`${input.name} was created as a draft.`);
    } catch (err) {
      setCreateError(userFacingError(err));
    } finally {
      setCreatePending(false);
    }
  }

  async function copyRecordId(record: GovernanceRecord) {
    setActionSuccess(null);
    setActionError(null);
    const identity =
      record.kind === "profile"
        ? `${record.value.profile_id}@${record.value.version}`
        : `${record.value.gate_policy_id}@${record.value.version}`;
    const failure = `Could not copy ${identity}. Copy it manually: ${identity}`;
    try {
      await navigator.clipboard.writeText(identity);
      setCopyFeedback(identity);
      window.setTimeout(() => setCopyFeedback(null), 1500);
    } catch {
      setCopyFeedback(null);
      setActionError(failure);
    }
  }

  async function saveProfileTestStatus(
    profile: QualityProfileVersion,
    mode: "tested" | "overridden",
    note?: string,
    sourceRunId?: string,
  ) {
    const action = mode === "tested" ? "mark-tested" : "override";
    const key = `${profile.profile_id}@${profile.version}:${action}`;
    setActionSuccess(null);
    setPendingAction(key);
    setActionError(null);
    try {
      const { tenant_id } = await api.tenant();
      await platformApi.markProfileTested(profile.profile_id, profile.version, tenant_id, {
        mode,
        note,
        source_run_id: sourceRunId,
      });
      await load(true);
      setActionSuccess(
        mode === "tested"
          ? `${profile.name} was marked tested.`
          : `${profile.name} test requirement was overridden.`,
      );
      if (mode === "overridden") {
        setOverrideProfile(null);
        setOverrideNote("");
        setOverrideError(null);
      } else {
        setTestProfile(null);
        setTestRunId("");
        setTestError(null);
      }
    } catch (err) {
      setActionError(
        userFacingError(
          err,
          err instanceof Error ? err.message : "The request could not be completed. Try again.",
        ),
      );
    } finally {
      setPendingAction(null);
    }
  }

  function markProfile(profile: QualityProfileVersion, mode: "tested" | "overridden") {
    if (mode === "tested") {
      // No longer a one-click assertion: the operator picks the run whose
      // stored evidence was scored against this Profile's checks.
      setActionError(null);
      setTestProfile(profile);
      setTestRunId("");
      setTestError(null);
      void (async () => {
        try {
          const { tenant_id } = await api.tenant();
          const runs = await evaluationApi.listRuns(tenant_id);
          setTestRuns(runs.filter((run) => run.status === "completed"));
        } catch {
          setTestRuns([]);
        }
      })();
      return;
    }
    setActionError(null);
    setOverrideProfile(profile);
    setOverrideNote("");
    setOverrideError(null);
  }

  function transitionRecord(record: GovernanceRecord, action: GovernanceLifecycleAction) {
    if (action === "retire") {
      setActionError(null);
      setRetireRecord(record);
      return;
    }
    void runLifecycleTransition(record, action);
  }

  async function runLifecycleTransition(
    record: GovernanceRecord,
    action: GovernanceLifecycleAction,
  ) {
    const id = record.kind === "profile" ? record.value.profile_id : record.value.gate_policy_id;
    const key = `${id}@${record.value.version}:${action}`;
    setActionSuccess(null);
    setPendingAction(key);
    setActionError(null);
    try {
      const { tenant_id } = await api.tenant();
      if (record.kind === "profile") {
        await platformApi.transitionProfile(
          record.value.profile_id,
          record.value.version,
          tenant_id,
          action,
        );
      } else {
        await platformApi.transitionGatePolicy(
          record.value.gate_policy_id,
          record.value.version,
          tenant_id,
          action,
        );
      }
      await load(true);
      const pastTense = {
        validate: "validated",
        approve: "approved",
        retire: "retired",
        reinstate: "reinstated and returned to draft",
      }[action];
      setActionSuccess(`${record.value.name} was ${pastTense}.`);
      if (action === "retire") setRetireRecord(null);
    } catch (err) {
      setActionError(
        userFacingError(
          err,
          err instanceof Error ? err.message : "The request could not be completed. Try again.",
        ),
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function copyAssignmentLink(assignment: EvaluationAssignmentVersion) {
    const path = assignmentPermalinkPath({
      assignmentId: assignment.assignment_id,
      version: assignment.version,
    });
    const absolute = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(absolute);
      setCopyFeedback(`${assignment.assignment_id}@${assignment.version}`);
      window.setTimeout(() => setCopyFeedback(null), 1500);
    } catch {
      setActionError("Clipboard is unavailable in this browser context.");
    }
  }

  async function archiveOrRestore(
    assignment: EvaluationAssignmentVersion,
    action: "archive" | "restore",
  ) {
    const key = `${assignment.assignment_id}@${assignment.version}:${action}`;
    setPendingAction(key);
    setActionError(null);
    try {
      const { tenant_id } = await api.tenant();
      if (action === "archive") {
        await platformApi.archiveAssignment(assignment.assignment_id, assignment.version, tenant_id);
      } else {
        await platformApi.restoreAssignment(assignment.assignment_id, assignment.version, tenant_id);
      }
      await load();
    } catch (err) {
      setActionError(userFacingError(err));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className={PAGE_FRAME}>
      <PageHeader
        section="Configure"
        title="Evaluation governance"
        description="Define reusable quality checks, optionally add release rules, then assign approved versions to a target before you evaluate."
        actions={
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        }
      />
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      {actionError ? (
        <p role="alert" className="mb-6 text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      {copyFeedback ? (
        <p role="status" className="mb-6 text-sm text-muted-foreground">
          Copied {copyFeedback}.
        </p>
      ) : null}
      {actionSuccess ? (
        <p role="status" className="mb-6 text-sm text-state-positive">
          {actionSuccess}
        </p>
      ) : null}
      {partialLoad ? (
        <p role="status" className="mb-6 text-sm text-muted-foreground">
          {partialLoad}
        </p>
      ) : null}
      {loading ? (
        <ListSkeleton label="Loading evaluation governance" rows={6} />
      ) : (
        <>
          <NavTabs aria-label="Governance catalogues">
            <NavTab asChild active={activeTab === "profiles"}>
              <Link ref={activeTab === "profiles" ? activeCatalogueTabRef : undefined} href={governanceTabHref("profiles")}>Quality Profiles ({profiles.length})</Link>
            </NavTab>
            <NavTab asChild active={activeTab === "policies"}>
              <Link ref={activeTab === "policies" ? activeCatalogueTabRef : undefined} href={governanceTabHref("policies")}>Gate Policies ({policies.length})</Link>
            </NavTab>
            <NavTab asChild active={activeTab === "assignments"}>
              <Link ref={activeTab === "assignments" ? activeCatalogueTabRef : undefined} href={governanceTabHref("assignments")}>Assignments ({activeAssignmentCount})</Link>
            </NavTab>
          </NavTabs>
          <div className="pt-6">
            {activeTab === "profiles" ? (
              <GovernanceSection
                title="Quality Profiles"
                purpose="Reusable checks, thresholds and required evidence. They do not select a Project or target."
                action={
                  canAuthor ? (
                    <Link href="/contracts?tab=profiles&create=profile" className={buttonVariants({ size: "sm" })}>
                      Create Quality Profile
                    </Link>
                  ) : null
                }
                toolbar={
                  <CatalogueToolbar
                    searchId="profile-search"
                    searchLabel="Search Quality Profiles"
                    query={profileQuery}
                    onQueryChange={setProfileQuery}
                    sort={profileSort}
                    onSortChange={setProfileSort}
                    filterLabel="Profile status"
                    filterValue={profileFilter}
                    onFilterChange={(value) => setProfileFilter(value as LifecycleFilter)}
                    filterOptions={[
                      { value: "all", label: "All statuses" },
                      { value: "draft", label: "Draft" },
                      { value: "validated", label: "Validated" },
                      { value: "approved", label: "Approved" },
                      { value: "retired", label: "Retired" },
                    ]}
                  />
                }
                emptyTitle="No Quality Profiles"
                emptyDescription="Create a draft profile, then validate and approve it before assigning it to a target."
                unavailable={partialLoad?.includes("Quality Profiles") ?? false}
                unavailableTitle="Quality Profiles are unavailable"
                columns={
                  <CatalogueColumns cols={GRID_COLS_PROFILES}>
                    <SortHeader label="Quality Profile" axis="name" sort={profileSort} onSortChange={setProfileSort} />
                    <span>Status</span>
                    <span>Test readiness</span>
                    <SortHeader label="Created" axis="created" sort={profileSort} onSortChange={setProfileSort} />
                    <span className="sr-only">Actions</span>
                  </CatalogueColumns>
                }
              >
                {visibleProfiles.map((profile) => {
              const profileKey = `${profile.profile_id}@${profile.version}`;
              const scope = profile.project_id ? `Project ${profile.project_id}` : "All Projects";
              const record: GovernanceRecord = { kind: "profile", value: profile };
              const selected =
                selectedRecord?.kind === "profile" &&
                selectedRecord.id === profile.profile_id &&
                selectedRecord.version === profile.version;
              return (
              <li key={profileKey}>
                <div className={`relative grid items-center gap-6 px-4 py-3 transition-colors hover:bg-muted/25 sm:px-5 ${GRID_COLS_PROFILES}`}>
                  {/* An invisible button across the whole row, the same technique the
                      Datasets table uses, so the hit target is the row rather than
                      just the name text. */}
                  <button
                    type="button"
                    // Inert while a lifecycle action is in flight. The list refetches
                    // and reflows when the action lands, so the second half of a
                    // genuine double-click on a row button would otherwise arrive on
                    // whatever row has slid into that position and open its drawer.
                    disabled={Boolean(pendingAction)}
                    className="absolute inset-0 z-0 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-label={`Open ${profile.name}, version ${profile.version}, ${profile.status}, ${scope}`}
                    onClick={() => openRecord(record)}
                  />
                  <div className="pointer-events-none z-10 min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{profile.name}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      v{profile.version} · {scope} · {profile.metric_ids.length}{" "}
                      {profile.metric_ids.length === 1 ? "metric" : "metrics"}
                      <span className="lg:hidden"> · {profileStatusLabel(profile)}</span>
                    </p>
                  </div>
                  <div className="pointer-events-none z-10"><StatusBadge status={profile.status} /></div>
                  <div className="pointer-events-none z-10 hidden lg:block">
                    <Chip size="sm">{profileStatusLabel(profile)}</Chip>
                  </div>
                  <div className="pointer-events-none z-10 hidden lg:block">
                    <CreatedCell value={profile.created_at} />
                  </div>
                  <div className="relative z-10">
                    {!selected ? (
                      <GovernanceRowActions
                        record={record}
                        canAuthor={canAuthor}
                        pendingAction={pendingAction}
                        onLifecycleAction={transitionRecord}
                        onMarkTested={markProfile}
                        onCopyId={(selected) => void copyRecordId(selected)}
                        onTechnicalDetails={openRecord}
                      />
                    ) : null}
                  </div>
                </div>
              </li>
              );
            })}
              </GovernanceSection>
            ) : null}
            {activeTab === "policies" ? (
              <GovernanceSection
                title="Gate Policies"
                purpose="Optional release rules: blockers, evidence, review conditions and allowed approvers."
                action={
                  canAuthor ? (
                    <Link href="/contracts?tab=policies&create=policy" className={buttonVariants({ size: "sm" })}>
                      Create Gate Policy
                    </Link>
                  ) : null
                }
                toolbar={
                  <CatalogueToolbar
                    searchId="policy-search"
                    searchLabel="Search Gate Policies"
                    query={policyQuery}
                    onQueryChange={setPolicyQuery}
                    sort={policySort}
                    onSortChange={setPolicySort}
                    filterLabel="Policy status"
                    filterValue={policyFilter}
                    onFilterChange={(value) => setPolicyFilter(value as LifecycleFilter)}
                    filterOptions={[
                      { value: "all", label: "All statuses" },
                      { value: "draft", label: "Draft" },
                      { value: "validated", label: "Validated" },
                      { value: "approved", label: "Approved" },
                      { value: "retired", label: "Retired" },
                    ]}
                  />
                }
                emptyTitle="No Gate Policies"
                emptyDescription="A Quality Profile can be assigned without a Gate Policy. That produces a standardized evaluation, not release evidence."
                unavailable={partialLoad?.includes("Gate Policies") ?? false}
                unavailableTitle="Gate Policies are unavailable"
                columns={
                  <CatalogueColumns cols={GRID_COLS_POLICIES}>
                    <SortHeader label="Gate Policy" axis="name" sort={policySort} onSortChange={setPolicySort} />
                    <span>Status</span>
                    <SortHeader label="Created" axis="created" sort={policySort} onSortChange={setPolicySort} />
                    <span className="sr-only">Actions</span>
                  </CatalogueColumns>
                }
              >
                {visiblePolicies.map((policy) => {
              const policyKey = `${policy.gate_policy_id}@${policy.version}`;
              const record: GovernanceRecord = { kind: "policy", value: policy };
              const selected =
                selectedRecord?.kind === "policy" &&
                selectedRecord.id === policy.gate_policy_id &&
                selectedRecord.version === policy.version;
              return (
              <li key={policyKey}>
                <div className={`relative grid items-center gap-6 px-4 py-3 transition-colors hover:bg-muted/25 sm:px-5 ${GRID_COLS_POLICIES}`}>
                  <button
                    type="button"
                    // Inert while a lifecycle action is in flight. The list refetches
                    // and reflows when the action lands, so the second half of a
                    // genuine double-click on a row button would otherwise arrive on
                    // whatever row has slid into that position and open its drawer.
                    disabled={Boolean(pendingAction)}
                    className="absolute inset-0 z-0 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-label={`Open ${policy.name}, version ${policy.version}, ${policy.status}, All Projects`}
                    onClick={() => openRecord(record)}
                  />
                  <div className="pointer-events-none z-10 min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{policy.name}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      v{policy.version} · {policy.hard_blocker_metric_ids.length} blockers ·{" "}
                      {policy.required_evidence.length} evidence · {policy.required_approver_roles.length} approvers
                    </p>
                  </div>
                  <div className="pointer-events-none z-10"><StatusBadge status={policy.status} /></div>
                  <div className="pointer-events-none z-10 hidden lg:block">
                    <CreatedCell value={policy.created_at} />
                  </div>
                  <div className="relative z-10">
                    {!selected ? (
                      <GovernanceRowActions
                        record={record}
                        canAuthor={canAuthor}
                        pendingAction={pendingAction}
                        onLifecycleAction={transitionRecord}
                        onMarkTested={markProfile}
                        onCopyId={(selected) => void copyRecordId(selected)}
                        onTechnicalDetails={openRecord}
                      />
                    ) : null}
                  </div>
                </div>
              </li>
              );
            })}
              </GovernanceSection>
            ) : null}
            {activeTab === "assignments" ? (
              <GovernanceSection
                title="Assignments"
                purpose="The only place a Project and exact target version are bound to approved controls."
                action={
                  <div className="flex flex-wrap items-center gap-3">
                    <SegmentedControl
                      label="Assignment shelf"
                      value={assignmentShelf}
                      onChange={setAssignmentShelf}
                      options={[
                        { value: "active" as const, label: "Active" },
                        { value: "archived" as const, label: "Archived" },
                      ]}
                    />
                    {canAuthor ? (
                      <Link href="/contracts/new" className={buttonVariants({ size: "sm" })}>
                        Create Assignment
                      </Link>
                    ) : null}
                  </div>
                }
                toolbar={
                  <CatalogueToolbar
                    searchId="assignment-search"
                    searchLabel="Search Assignments"
                    query={assignmentQuery}
                    onQueryChange={setAssignmentQuery}
                    sort={assignmentSort}
                    onSortChange={setAssignmentSort}
                    filterLabel="Governance state"
                    filterValue={assignmentFilter}
                    onFilterChange={(value) => setAssignmentFilter(value as GovernanceFilter)}
                    filterOptions={[
                      { value: "all", label: "All states" },
                      { value: "standardized_evaluation", label: "Standardized evaluation" },
                      { value: "release_governed", label: "Release-governed" },
                    ]}
                  />
                }
                emptyTitle={assignmentShelf === "archived" ? "No archived Assignments" : "No Assignments"}
                emptyDescription={
                  assignmentShelf === "archived"
                    ? "Archived Assignments remain available here for restore. They cannot launch evaluations while archived."
                    : "Choose a Project and target, then pin an approved Quality Profile and optional Gate Policy."
                }
                unavailable={partialLoad?.includes("Assignments") ?? false}
                unavailableTitle="Assignments are unavailable"
                columns={
                  <CatalogueColumns cols={GRID_COLS_ASSIGNMENTS}>
                    <SortHeader label="Assignment" axis="name" sort={assignmentSort} onSortChange={setAssignmentSort} />
                    <span>Governance state</span>
                    <SortHeader label="Created" axis="created" sort={assignmentSort} onSortChange={setAssignmentSort} />
                    <span className="sr-only">Actions</span>
                  </CatalogueColumns>
                }
              >
                {visibleAssignments.map((assignment) => {
                  const key = `${assignment.assignment_id}@${assignment.version}`;
                  const highlighted = highlightedAssignmentKey === key;
                  const archived = Boolean(assignment.archived_at);
                  const actionKey = `${key}:${archived ? "restore" : "archive"}`;
                  const copied = copyFeedback === key;
                  return (
                    <li key={key} id={`assignment-${assignment.assignment_id}-${assignment.version}`}>
                      <div className={highlighted ? "bg-brand-text/5 ring-2 ring-inset ring-brand-text/30" : ""}>
                        <div className={`relative grid items-center gap-6 px-4 py-3 transition-colors hover:bg-muted/25 sm:px-5 ${GRID_COLS_ASSIGNMENTS}`}>
                          {/* Opening the row opens the Assignment, the same as the
                              Profile and Policy catalogues. This was the one tab
                              where the name was inert and the only way in was the
                              menu. */}
                          <Link
                            href={assignmentDetailsHref({
                              runManifestId: assignment.run_manifest_id,
                              assignmentId: assignment.assignment_id,
                              version: assignment.version,
                            })}
                            aria-label={`Open ${assignment.name}, version ${assignment.version}`}
                            className="absolute inset-0 z-0 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-foreground">{assignment.name}</p>
                            {/* The identifier line used to be a raw UUID. A user
                                recognises an Assignment by what it is for and which
                                revision they are looking at; the machine ids are
                                support material and live under the disclosure below. */}
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              v{assignment.version}
                              {assignment.purpose?.trim() ? ` · ${assignment.purpose.trim()}` : ""}
                              {assignment.owner?.trim() ? ` · ${assignment.owner.trim()}` : ""}
                              <span className="lg:hidden">
                                {assignment.created_at ? ` · ${formatDateTime(assignment.created_at)}` : ""}
                              </span>
                            </p>
                          </div>
                          {/* Wrapped: a chip placed straight into a grid cell is
                              stretched to the column width, so it read as a bar
                              rather than a pill. */}
                          <div className="min-w-0">
                            <Chip>
                              {archived
                                ? "Archived"
                                : assignment.governance_state === "release_governed"
                                  ? "Release-governed"
                                  : "Standardized evaluation"}
                            </Chip>
                          </div>
                          <div className="hidden lg:block">
                            <CreatedCell value={assignment.created_at} />
                          </div>
                          <div className="justify-self-end">
                            <AssignmentRowActions
                              name={assignment.name}
                              archived={archived}
                              canAuthor={canAuthor}
                              pending={pendingAction === actionKey}
                              runHref={evaluateHrefFromAssignment({
                                assignmentId: assignment.assignment_id,
                                version: assignment.version,
                              })}
                              detailsHref={assignmentDetailsHref({
                                runManifestId: assignment.run_manifest_id,
                                assignmentId: assignment.assignment_id,
                                version: assignment.version,
                              })}
                              copied={copied}
                              onCopyLink={() => void copyAssignmentLink(assignment)}
                              onArchiveToggle={() =>
                                void archiveOrRestore(assignment, archived ? "restore" : "archive")
                              }
                            />
                          </div>
                        </div>
                        {/* The machine identifiers stay reachable, one disclosure away,
                            rather than being printed across the card's identity line. */}
                        <details className="border-t border-dashed px-5 pb-3 pt-2 text-xs text-muted-foreground">
                          <summary className="cursor-pointer rounded py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            Technical details
                          </summary>
                          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                            <div className="min-w-0">
                              <dt className="font-medium text-foreground">Assignment ID</dt>
                              <dd className="truncate font-mono">{assignment.assignment_id}</dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="font-medium text-foreground">Run manifest</dt>
                              <dd className="truncate font-mono">{assignment.run_manifest_id}</dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="font-medium text-foreground">Quality Profile</dt>
                              <dd className="truncate font-mono">{assignment.profile_id} · v{assignment.profile_version}</dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="font-medium text-foreground">Gate Policy</dt>
                              <dd className="truncate font-mono">
                                {assignment.gate_policy_id
                                  ? `${assignment.gate_policy_id} · v${assignment.gate_policy_version ?? ""}`
                                  : "None"}
                              </dd>
                            </div>
                          </dl>
                        </details>
                      </div>
                    </li>
                  );
                })}
              </GovernanceSection>
            ) : null}
          </div>
        </>
      )}
      {createKind ? (
        <GovernanceCreateDialog
          kind={createKind}
          metrics={metrics}
          existingNames={(createKind === "profile" ? profiles : policies).map((item) => item.name)}
          pending={createPending}
          error={createError}
          onClose={closeCreateDialog}
          onCreateProfile={createProfile}
          onCreatePolicy={createPolicy}
        />
      ) : null}
      {selectedRecord && (selectedProfile || selectedPolicy) && !retireRecord && !overrideProfile && !createKind ? (
        <GovernanceRecordDrawer
          selection={selectedRecord}
          profile={selectedProfile}
          policy={selectedPolicy}
          canAuthor={canAuthor}
          pendingAction={pendingAction}
          onClose={() => replaceRecordSelection(null)}
          onLifecycleAction={transitionRecord}
          onMarkTested={markProfile}
          onCopyId={copyRecordId}
          fallbackFocusRef={activeCatalogueTabRef}
          successMessage={copyFeedback ? `Copied ${copyFeedback}.` : actionSuccess}
          errorMessage={actionError}
        />
      ) : null}
      {selectedRecord && !loading && !selectedProfile && !selectedPolicy && !retireRecord && !overrideProfile ? (
        <Dialog
          variant="drawer"
          as="aside"
          labelledBy="governance-record-recovery-title"
          scrimLabel="Dismiss unavailable record"
          onClose={() => replaceRecordSelection(null)}
          width="sm:w-[min(32rem,94vw)]"
        >
          <header className="border-b px-5 py-5">
            <h2 id="governance-record-recovery-title" className="text-xl font-semibold text-foreground">
              Unable to open {selectedProduct}
            </h2>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
            <p className="text-sm leading-6 text-muted-foreground">
              {selectedCatalogueUnavailable
                ? `This ${selectedProduct} could not be loaded.`
                : `${selectedProduct} ${selectedRecord.id}@${selectedRecord.version} was not found.`}
            </p>
          </div>
          <footer className="flex justify-end gap-3 border-t px-5 py-4">
            {selectedCatalogueUnavailable ? (
              <Button type="button" variant="outline" aria-label="Retry record load" onClick={() => void load()}>
                Retry
              </Button>
            ) : null}
            <Button type="button" aria-label="Close record details" onClick={() => replaceRecordSelection(null)}>
              Close
            </Button>
          </footer>
        </Dialog>
      ) : null}
      {retireRecord ? (
        <Dialog
          labelledBy="retire-governance-record-title"
          onClose={() => setRetireRecord(null)}
          scrimLabel={`Cancel retiring ${retireRecord.value.name}`}
          width="w-[min(30rem,calc(100vw-2rem))]"
          className="flex-none"
        >
          <div className="p-5 sm:p-6">
            <h2 id="retire-governance-record-title" className="text-lg font-semibold text-foreground">
              Retire “{retireRecord.value.name}”?
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              This version can no longer be selected for new Assignments. You can reinstate it
              later, which returns it to draft and clears its tested status.
            </p>
            {actionError ? (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {actionError}
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-3 border-t pt-5">
              <Button type="button" variant="outline" onClick={() => setRetireRecord(null)} disabled={pendingAction?.endsWith(":retire")}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                aria-label={`Retire ${retireRecord.value.name}`}
                disabled={pendingAction?.endsWith(":retire")}
                onClick={() => void runLifecycleTransition(retireRecord, "retire")}
              >
                {pendingAction?.endsWith(":retire") ? "Retiring…" : "Retire"}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {testProfile ? (
        <Dialog
          labelledBy="mark-tested-title"
          onClose={() => {
            setTestProfile(null);
            setTestRunId("");
            setTestError(null);
          }}
          scrimLabel={`Close dry-run evidence for ${testProfile.name}`}
          width="w-[min(34rem,calc(100vw-2rem))]"
          className="flex-none"
        >
          <form
            className="p-5 sm:p-6"
            onSubmit={(event) => {
              event.preventDefault();
              if (!testRunId) {
                setTestError("Choose the run whose evidence was scored against this Profile.");
                return;
              }
              setTestError(null);
              void saveProfileTestStatus(testProfile, "tested", undefined, testRunId);
            }}
          >
            <h2 id="mark-tested-title" className="text-lg font-semibold text-foreground">
              Record a dry run for “{testProfile.name}”
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Pick the completed run whose stored evidence was scored against these checks. Proofgrove
              verifies the run covered them before recording the Profile as tested.
            </p>
            {actionError ? (
              <p role="alert" className="mt-3 text-sm text-destructive">{actionError}</p>
            ) : null}
            <label htmlFor="mark-tested-run" className="mt-4 block text-sm font-medium">Run</label>
            <select
              id="mark-tested-run"
              className={cn("select-chevron mt-2 w-full rounded-lg border border-input bg-background px-3 py-2 pr-9 text-sm")}
              value={testRunId}
              aria-invalid={testError ? true : undefined}
              aria-describedby={testError ? "mark-tested-run-error" : undefined}
              onChange={(event) => setTestRunId(event.target.value)}
            >
              <option value="">Choose a completed run…</option>
              {testRuns.map((run) => (
                <option key={run.run_id} value={run.run_id}>
                  {run.experiment?.name || run.run_id}
                  {run.completed_at ? ` · ${formatDateTime(run.completed_at)}` : ""}
                </option>
              ))}
            </select>
            {testError ? (
              <p id="mark-tested-run-error" role="alert" className="mt-2 text-sm text-destructive">{testError}</p>
            ) : null}
            {testRuns.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                No completed runs in this workspace yet. Score one against these checks first, or
                record an override with a note.
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-3 border-t pt-5">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setTestProfile(null);
                  setTestRunId("");
                  setTestError(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={Boolean(pendingAction)}>Record dry run</Button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {overrideProfile ? (
        <Dialog
          labelledBy="override-profile-title"
          onClose={() => {
            setOverrideProfile(null);
            setOverrideNote("");
            setOverrideError(null);
          }}
          scrimLabel={`Close override for ${overrideProfile.name}`}
          width="w-[min(34rem,calc(100vw-2rem))]"
          className="flex-none"
        >
          <form
            className="p-5 sm:p-6"
            onSubmit={(event) => {
              event.preventDefault();
              const note = overrideNote.trim();
              if (!note) {
                setOverrideError("Override requires a note.");
                return;
              }
              setOverrideError(null);
              void saveProfileTestStatus(overrideProfile, "overridden", note);
            }}
          >
            <h2 id="override-profile-title" className="text-lg font-semibold text-foreground">
              Override Not tested for “{overrideProfile.name}”
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Record why this Quality Profile may be approved without a dry-run.
            </p>
            {actionError ? (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {actionError}
              </p>
            ) : null}
            <label htmlFor="override-note" className="mt-5 grid gap-2 text-sm font-medium text-foreground">
              Override note
              <textarea
                id="override-note"
                value={overrideNote}
                onChange={(event) => {
                  setOverrideNote(event.target.value);
                  if (event.target.value.trim()) setOverrideError(null);
                }}
                rows={5}
                required
                aria-invalid={overrideError ? true : undefined}
                aria-describedby={overrideError ? "override-note-error" : undefined}
                className="min-h-28 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
            </label>
            {overrideError ? (
              <p id="override-note-error" role="alert" className="mt-2 text-sm text-destructive">
                {overrideError}
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-3 border-t pt-5">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setOverrideProfile(null);
                  setOverrideNote("");
                  setOverrideError(null);
                }}
                disabled={pendingAction?.endsWith(":override")}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!overrideNote.trim() || pendingAction?.endsWith(":override")}>
                {pendingAction?.endsWith(":override") ? "Saving…" : "Save override"}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}

function governanceSelectionFromSearchParams(searchParams: {
  get: (name: string) => string | null;
}): GovernanceRecordSelection | null {
  for (const kind of ["profile", "policy"] as const) {
    const value = searchParams.get(kind);
    if (!value) continue;
    const separator = value.lastIndexOf("@");
    if (separator <= 0 || separator === value.length - 1) continue;
    return {
      kind,
      id: value.slice(0, separator),
      version: value.slice(separator + 1),
    };
  }
  return null;
}

function profileStatusLabel(profile: QualityProfileVersion): string {
  const status = profile.test_status || "not_tested";
  if (status === "tested") return "Tested";
  if (status === "overridden") return "Test overridden";
  return "Not tested";
}

function CatalogueToolbar({
  searchId,
  searchLabel,
  query,
  onQueryChange,
  sort,
  onSortChange,
  filterLabel,
  filterValue,
  onFilterChange,
  filterOptions,
}: {
  searchId: string;
  searchLabel: string;
  query: string;
  onQueryChange: (value: string) => void;
  sort: CatalogueSort;
  onSortChange: (value: CatalogueSort) => void;
  filterLabel: string;
  filterValue: string;
  onFilterChange: (value: string) => void;
  filterOptions: Array<{ value: string; label: string }>;
}) {
  return (
    // One strip, inline controls, labels carried as accessible names rather than
    // stacked text. The stacked-label version was twice as tall and read as a form
    // floating above the table instead of the table's own toolbar.
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <SearchField
        containerClassName="min-w-[12rem] flex-1"
        id={searchId}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Name or id"
        label={searchLabel}
      />
      {/* Restored below `lg` only: the sortable column headers live in a
          `hidden lg:grid` row, so deleting this control left small screens with
          no way to sort at all. */}
      <FilterSelect
        label={`${searchLabel} sort`}
        className="lg:hidden"
        value={sort}
        onChange={(event) => onSortChange(event.target.value as CatalogueSort)}
      >
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="name_asc">Name A–Z</option>
        <option value="name_desc">Name Z–A</option>
      </FilterSelect>
      <FilterSelect
        label={filterLabel}
        value={filterValue}
        onChange={(event) => onFilterChange(event.target.value)}
      >
        {filterOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </FilterSelect>
    </div>
  );
}

/**
 * Catalogue rows are a CSS grid, matching the Datasets library rather than a
 * <table>: same COLUMN_HEADER bar, same "flexible name column plus fixed
 * metadata columns" rhythm, same trailing actions cell.
 *
 * Two templates per tab, not one. The Datasets table keeps a single row template
 * at every width, and below ~1024px its fixed columns starve the name column
 * until names truncate to a single letter. Governance rows carry an action
 * button datasets rows do not, so they would fare worse; the narrow template
 * drops the two columns whose values also appear on the row's secondary line.
 */
// Every column is a fixed width except the name. An `auto` Actions column looks
// harmless and is not: the primary button's label differs per row (Mark tested /
// Validate / Retire), so the column resized per row, which resized the flexible
// name column, which shifted Status, Test readiness and Created out of alignment
// with their own headers. Fixed width, one grid, columns line up.
// Written out in full, never interpolated: Tailwind generates classes by scanning
// source text, so a template-literal class name produces no CSS at all and the grid
// silently collapses to one column.
//
// Every column is a fixed width except the name. An `auto` Actions column looks
// harmless and is not: the primary button's label differs per row (Mark tested /
// Validate / Retire), so the column resized per row, which resized the flexible
// name column, which shifted Status, Test readiness and Created out of alignment
// with their own headers. Fixed width, one grid, columns line up.
/** Governance rows are taller than a dataset row — ten keeps a page on one screen. */
const ROWS_PER_PAGE = 10;

const GRID_COLS_PROFILES =
  "grid-cols-[minmax(0,1fr)_9rem_11rem] lg:grid-cols-[minmax(0,1fr)_9rem_11rem_12rem_11rem]";
const GRID_COLS_POLICIES =
  "grid-cols-[minmax(0,1fr)_9rem_11rem] lg:grid-cols-[minmax(0,1fr)_9rem_12rem_11rem]";
const GRID_COLS_ASSIGNMENTS =
  "grid-cols-[minmax(0,1fr)_14rem_11rem] lg:grid-cols-[minmax(0,1fr)_14rem_12rem_11rem]";

/**
 * A column header that sorts, replacing the sort dropdown that offered the same
 * two axes the columns already show. Same control the Datasets library uses.
 */
function SortHeader({
  label,
  axis,
  sort,
  onSortChange,
  align = "left",
}: {
  label: string;
  axis: "name" | "created";
  sort: CatalogueSort;
  onSortChange: (value: CatalogueSort) => void;
  align?: "left" | "right";
}) {
  const ascending = axis === "name" ? "name_asc" : "oldest";
  const descending = axis === "name" ? "name_desc" : "newest";
  const active = sort === ascending || sort === descending;
  const isAscending = sort === ascending;
  return (
    <button
      type="button"
      onClick={() => onSortChange(isAscending ? descending : ascending)}
      // Restated rather than inherited: text-transform does not cross a button
      // boundary in every engine, so an inherited uppercase silently drops.
      className={cn(
        "inline-flex w-full items-center gap-1 rounded uppercase tracking-[0.08em] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        align === "right" ? "justify-end" : "justify-start",
      )}
      aria-label={`Sort by ${label.toLowerCase()}${active ? `, currently ${isAscending ? "ascending" : "descending"}` : ""}`}
    >
      {label}
      {active ? (
        isAscending ? <ChevronUp className="size-3" aria-hidden="true" />
                    : <ChevronDown className="size-3" aria-hidden="true" />
      ) : (
        <ChevronsUpDown className="size-3 opacity-50" aria-hidden="true" />
      )}
    </button>
  );
}

function CatalogueColumns({ cols, children }: { cols: string; children: ReactNode }) {
  return (
    <div className={`hidden items-center gap-6 px-4 sm:px-5 lg:grid ${cols} ${COLUMN_HEADER}`}>
      {children}
    </div>
  );
}

/** Right-aligned, tabular so dates line up column-wise. */
function CreatedCell({ value }: { value?: string | null }) {
  return (
    <span className="hidden text-xs tabular-nums text-muted-foreground lg:block">
      {value ? formatDateTime(value) : "—"}
    </span>
  );
}

function GovernanceSection({
  title,
  purpose,
  action,
  toolbar,
  emptyTitle,
  emptyDescription,
  unavailable,
  unavailableTitle,
  columns,
  children,
}: {
  title: string;
  purpose: string;
  action: ReactNode;
  toolbar?: ReactNode;
  emptyTitle: string;
  emptyDescription: string;
  unavailable: boolean;
  unavailableTitle: string;
  columns?: ReactNode;
  children: ReactNode;
}) {
  const items = (Array.isArray(children) ? children : children ? [children] : []).filter(Boolean);
  const hasItems = items.length > 0;
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / ROWS_PER_PAGE));
  // Clamped rather than reset: filtering down to fewer pages while sitting on a
  // later one should show the last page, not silently jump to the first.
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * ROWS_PER_PAGE;
  const visible = items.slice(pageStart, pageStart + ROWS_PER_PAGE);
  return (
    // Heading, controls, columns, rows and the pager are one card, as in the
    // Datasets library. They used to be a heading floating on the page above a
    // separate bordered table, which read as two unrelated things.
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="border-b px-5 py-4">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{purpose}</p>
      </div>
      <div>
        {toolbar || action ? (
          // Search, filter, shelf and the create action on one line. The shelf and
          // the button used to sit up beside the heading, which left the toolbar
          // half empty and the search stretched across it.
          <div className="flex flex-wrap items-center gap-2 border-b bg-muted/10 px-4 py-3 sm:px-5">
            {toolbar}
            {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
          </div>
        ) : null}
        {unavailable ? (
          <EmptyState
            title={unavailableTitle}
            description="The rest of this page is still available."
            className="m-5"
          />
        ) : hasItems ? (
          <div>
            {columns}
            <ul role="list" className="divide-y">{visible}</ul>
            {/* Shown whenever there are rows, not only past one page — the same as
                the Datasets library. The count is the useful half; hiding it until
                a catalogue outgrows a page means it is absent exactly while you are
                learning what the page holds. */}
            <div className="flex flex-col gap-3 border-t bg-muted/10 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                Showing <span className="font-medium text-foreground">{pageStart + 1}</span>–
                <span className="font-medium text-foreground">
                  {Math.min(pageStart + ROWS_PER_PAGE, items.length)}
                </span>{" "}
                of <span className="font-medium text-foreground">{items.length}</span>{" "}
                {title.toLowerCase()}
              </p>
              <nav className="flex items-center gap-2" aria-label={`${title} pagination`}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={currentPage === 1}
                  onClick={() => setPage(Math.max(1, currentPage - 1))}
                >
                  <ChevronLeft className="mr-1 size-3.5" aria-hidden="true" />
                  Previous
                </Button>
                <span className="min-w-20 text-center text-xs font-medium" aria-live="polite">
                  Page {currentPage} of {pageCount}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={currentPage === pageCount}
                  onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
                >
                  Next
                  <ChevronRight className="ml-1 size-3.5" aria-hidden="true" />
                </Button>
              </nav>
            </div>
          </div>
        ) : (
          <EmptyState title={emptyTitle} description={emptyDescription} className="m-5" />
        )}
      </div>
    </section>
  );
}
