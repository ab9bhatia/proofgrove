"use client";

import { useRef, type RefObject } from "react";
import { X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/status-badge";
import {
  GovernanceRowActions,
  type GovernanceLifecycleAction,
  type GovernanceRecord,
} from "@/components/governance-row-actions";
import type { QualityProfileVersion, ReleaseGatePolicyVersion } from "@/lib/api";

export type GovernanceRecordSelection =
  | { kind: "profile"; id: string; version: string }
  | { kind: "policy"; id: string; version: string };

function Values({ values, empty = "None" }: { values: string[]; empty?: string }) {
  return values.length > 0 ? (
    <ul className="mt-2 grid gap-1.5 text-sm text-foreground">
      {values.map((value) => (
        <li key={value} className="rounded-lg border bg-muted/20 px-3 py-2">
          {value}
        </li>
      ))}
    </ul>
  ) : (
    <p className="mt-2 text-sm text-muted-foreground">{empty}</p>
  );
}

function DetailSection({
  title,
  values,
  empty,
}: {
  title: string;
  values: string[];
  empty?: string;
}) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <Values values={values} empty={empty} />
    </section>
  );
}

export function GovernanceRecordDrawer({
  selection,
  profile,
  policy,
  canAuthor,
  pendingAction = null,
  onClose,
  onLifecycleAction,
  onMarkTested,
  onCopyId,
  fallbackFocusRef,
  successMessage = null,
  errorMessage = null,
}: {
  selection: GovernanceRecordSelection;
  profile: QualityProfileVersion | null;
  policy: ReleaseGatePolicyVersion | null;
  canAuthor: boolean;
  pendingAction?: string | null;
  onClose: () => void;
  onLifecycleAction: (record: GovernanceRecord, action: GovernanceLifecycleAction) => void;
  onMarkTested: (profile: QualityProfileVersion, mode: "tested" | "overridden") => void;
  onCopyId: (record: GovernanceRecord) => void;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  successMessage?: string | null;
  errorMessage?: string | null;
}) {
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const technicalDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const value = selection.kind === "profile" ? profile : policy;
  if (!value) return null;

  const record: GovernanceRecord =
    selection.kind === "profile"
      ? { kind: "profile", value: profile as QualityProfileVersion }
      : { kind: "policy", value: policy as ReleaseGatePolicyVersion };
  const scope =
    selection.kind === "profile" && profile?.project_id
      ? `Project ${profile.project_id}`
      : "All Projects";
  const closeWithFallback = () => {
    onClose();
    window.setTimeout(() => {
      const active = document.activeElement;
      if (
        !(active instanceof HTMLElement) ||
        active === document.body ||
        !active.isConnected
      ) {
        fallbackFocusRef?.current?.focus();
      }
    }, 0);
  };
  const showTechnicalDetails = () => {
    if (!technicalDetailsRef.current) return;
    technicalDetailsRef.current.open = true;
    window.setTimeout(() => {
      technicalDetailsRef.current?.querySelector<HTMLElement>("summary")?.focus();
    }, 0);
  };

  return (
    <Dialog
      variant="drawer"
      as="aside"
      labelledBy="governance-record-drawer-title"
      scrimLabel={`Close ${value.name}`}
      onClose={closeWithFallback}
      initialFocusRef={titleRef}
      width="sm:w-[min(42rem,94vw)]"
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-b px-5 py-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {selection.kind === "profile" ? "Quality Profile" : "Gate Policy"}
          </p>
          <h2
            ref={titleRef}
            id="governance-record-drawer-title"
            tabIndex={-1}
            className="mt-1 text-xl font-semibold text-foreground outline-none"
          >
            {value.name}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={value.status} />
            <span className="text-sm text-muted-foreground">Version {value.version}</span>
            <span className="text-sm text-muted-foreground">{scope}</span>
          </div>
        </div>
        <button
          type="button"
          aria-label={`Close ${value.name}`}
          onClick={closeWithFallback}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg border outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-6">
        <p className="text-sm leading-6 text-muted-foreground">
          {value.description || "No description provided."}
        </p>
        <div aria-live="polite" className="mt-4">
          {errorMessage ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          ) : successMessage ? (
            <p role="status" className="text-sm text-state-positive">
              {successMessage}
            </p>
          ) : null}
        </div>

        <div className="mt-6 grid gap-6">
          {selection.kind === "profile" && profile ? (
            <>
              <section className="rounded-xl border bg-muted/20 p-4">
                <h3 className="text-sm font-semibold text-foreground">Test readiness</h3>
                <p className="mt-2 text-sm text-foreground">
                  {(profile.test_status || "not_tested") === "not_tested"
                    ? "Not tested"
                    : profile.test_status === "overridden"
                      ? "Test overridden"
                      : "Tested"}
                </p>
                <dl className="mt-3 grid gap-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Note</dt>
                    <dd>{profile.test_note || "No test note recorded."}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Recorded by</dt>
                    <dd>{profile.tested_by || "Not recorded"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Recorded at</dt>
                    <dd>{profile.tested_at || "Not recorded"}</dd>
                  </div>
                </dl>
              </section>
              <DetailSection title="Metrics and checks" values={profile.metric_ids} />
              <DetailSection
                title="Blocker metrics"
                values={profile.hard_blocker_metric_ids}
                empty="No hard blockers."
              />
              <DetailSection
                title="Required evidence"
                values={profile.evidence_requirements}
                empty="No evidence requirements."
              />
              <DetailSection
                title="Approvers"
                values={profile.approver_roles}
                empty="No approver roles."
              />
            </>
          ) : policy ? (
            <>
              <section className="rounded-xl border bg-muted/20 p-4">
                <h3 className="text-sm font-semibold text-foreground">Rule summary</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Applied only when this policy and a compatible approved Quality Profile are
                  pinned to the same Assignment.
                </p>
              </section>
              <DetailSection
                title="Blocker metrics"
                values={policy.hard_blocker_metric_ids}
                empty="No hard blockers."
              />
              <DetailSection
                title="Required evidence"
                values={policy.required_evidence}
                empty="No evidence requirements."
              />
              <DetailSection
                title="Approvers"
                values={policy.required_approver_roles}
                empty="No approver roles."
              />
            </>
          ) : null}

          <details ref={technicalDetailsRef} className="rounded-xl border bg-muted/20 px-4 py-3">
            <summary className="cursor-pointer text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Technical details
            </summary>
            <dl className="mt-3 grid gap-2 break-all font-mono text-xs text-muted-foreground">
              <div>
                <dt>{selection.kind === "profile" ? "Profile ID" : "Gate Policy ID"}</dt>
                <dd>{selection.id}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{selection.version}</dd>
              </div>
              <div>
                <dt>Tenant ID</dt>
                <dd>{value.tenant_id}</dd>
              </div>
            </dl>
          </details>
        </div>
      </div>

      <footer className="flex justify-end border-t px-5 py-4">
        <GovernanceRowActions
          record={record}
          canAuthor={canAuthor}
          pendingAction={pendingAction}
          onLifecycleAction={onLifecycleAction}
          onMarkTested={onMarkTested}
          onCopyId={onCopyId}
          onTechnicalDetails={showTechnicalDetails}
        />
      </footer>
    </Dialog>
  );
}
