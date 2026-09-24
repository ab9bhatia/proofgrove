"use client";

import { useMemo, useState } from "react";
import { LoaderCircle, X } from "lucide-react";

import { Button } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@evalai/shared/ui/label";
import type { MetricCatalogEntry, QualityProfileVersion } from "@/lib/api";
import {
  derivedEvidence,
  GovernanceMetricPicker,
  profileIdFromName,
} from "@/components/governance-metric-picker";

export type GovernanceCreateKind = "profile" | "policy";

export type ProfileDraftInput = {
  profile_id: string;
  version: string;
  name: string;
  scenario: QualityProfileVersion["scenario"];
  metric_ids: string[];
  metric_requirements: Record<string, "required" | "optional">;
  evidence_requirements: string[];
  hard_blocker_metric_ids: string[];
  approver_roles: string[];
};

export type PolicyDraftInput = {
  gate_policy_id: string;
  version: string;
  name: string;
  required_evidence: string[];
  required_approver_roles: string[];
  hard_blocker_metric_ids: string[];
};

/** New records always start at 1.0.0; later versions come from the revision flow. */
const INITIAL_VERSION = "1.0.0";

// The backend accepts these two and fails closed on anything else
// (`validate_governance_roles`, `GOVERNANCE_ROLES`). Two fixed values, so a
// pair of checkboxes rather than a free-text box that can only be typed wrong.
const APPROVER_ROLES = [
  { id: "eval-hub-approver", label: "Approver", hint: "the platform default" },
  { id: "eval-hub-reviewer", label: "Reviewer", hint: "also require a reviewer" },
] as const;

function randomSuffix(): string {
  // Fixed width and from the crypto source. `Math.random().toString(16)` can
  // return fewer than six characters on a small draw, so the id's shape varied
  // with luck — and this suffix is what keeps two same-named records apart.
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

export function GovernanceCreateDialog({
  kind,
  metrics,
  pending,
  error,
  onClose,
  onCreateProfile,
  onCreatePolicy,
  existingNames = [],
}: {
  kind: GovernanceCreateKind;
  metrics: MetricCatalogEntry[];
  pending: boolean;
  error: string | null;
  existingNames?: string[];
  onClose: () => void;
  onCreateProfile: (input: ProfileDraftInput) => Promise<void>;
  onCreatePolicy: (input: PolicyDraftInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [scenario, setScenario] = useState<"llm_core" | "rag" | "agentic">("llm_core");
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>([]);
  const [hardFail, setHardFail] = useState<string[]>([]);
  const [approverRoles, setApproverRoles] = useState<string[]>([]);
  const isProfile = kind === "profile";
  const title = isProfile ? "Create Quality Profile" : "Create Gate Policy";

  // Evidence is a property of the checks you picked, not a separate thing to type.
  // It used to be a comma-separated box next to the checkboxes that already imply it.
  const evidence = useMemo(() => derivedEvidence(metrics, selectedMetrics), [metrics, selectedMetrics]);

  // Warn, do not block: a repeated name is usually a mistake, but a deliberate
  // second variant is legitimate and the id is what actually has to be unique.
  // Nothing warned at all before, which is how three "Tool Use Correctness"
  // profiles ended up indistinguishable in the catalogue.
  const duplicateName =
    name.trim().length > 0 &&
    existingNames.some((existing) => existing.trim().toLowerCase() === name.trim().toLowerCase());

  const toggleMetric = (metricId: string) =>
    setSelectedMetrics((current) => {
      if (!current.includes(metricId)) return [...current, metricId];
      // Clearing a check clears its hard-fail flag too, so a hidden blocker cannot
      // survive on a metric the profile no longer scores.
      setHardFail((flags) => flags.filter((id) => id !== metricId));
      return current.filter((id) => id !== metricId);
    });

  const submit = () => {
    const suffix = randomSuffix();
    if (isProfile) {
      void onCreateProfile({
        profile_id: profileIdFromName(name, suffix),
        version: INITIAL_VERSION,
        name: name.trim(),
        scenario,
        metric_ids: selectedMetrics,
        // Every check is optional unless it is a hard fail.
        //
        // An unstated requirement resolves to REQUIRED, and a required check that
        // composes no KPI is still refused ("required metric(s) have no
        // release-gate composition") — seventeen catalogue metrics compose none,
        // every content-safety, ops and nlp one among them. Hard fails are the
        // exception: they gate by run-level veto rather than through a KPI, so
        // they are the only checks safe to mark required from this dialog.
        metric_requirements: Object.fromEntries(
          selectedMetrics.map((metricId) => [metricId, hardFail.includes(metricId) ? "required" : "optional"] as const),
        ),
        evidence_requirements: evidence,
        hard_blocker_metric_ids: hardFail,
        approver_roles: approverRoles,
      });
      return;
    }
    void onCreatePolicy({
      gate_policy_id: profileIdFromName(name, suffix),
      version: INITIAL_VERSION,
      name: name.trim(),
      required_evidence: evidence,
      required_approver_roles: approverRoles,
      hard_blocker_metric_ids: hardFail.length > 0 ? hardFail : selectedMetrics,
    });
  };

  return (
    <Dialog
      labelledBy="governance-create-title"
      scrimLabel={`Close ${title}`}
      onClose={pending ? () => undefined : onClose}
      width="w-[min(44rem,calc(100vw-2rem))]"
      className="flex-none"
    >
      <div className="flex items-start justify-between gap-4 border-b px-5 py-4 sm:px-6">
        <div>
          <h2 id="governance-create-title" className="text-lg font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {isProfile
              ? "Pick the checks this profile runs. It saves as a draft; test, validate and approve it from the catalogue."
              : "Pick the checks that must not fail for a release. It saves as a draft; validate and approve it from the catalogue."}
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label={`Close ${title}`} onClick={onClose} disabled={pending}>
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {/* Header / scrolling body / sticky footer. Without it the panel's own
          overflow-hidden silently clipped the form: at a 600px-tall window the
          footer, Cancel and Create included, was unreachable with no scrollbar. */}
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto px-5 py-5 sm:px-6 sm:py-6">
          <fieldset disabled={pending} className="contents">
            <div className="grid gap-2">
              <Label className="text-sm font-medium" htmlFor="governance-name">
                {isProfile ? "Profile name" : "Policy name"}
              </Label>
              <Input
                id="governance-name"
                name="name"
                required
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-describedby={duplicateName ? "governance-name-duplicate" : undefined}
              />
              {duplicateName ? (
                <p id="governance-name-duplicate" role="status" className="text-xs text-state-caution">
                  Another {isProfile ? "Quality Profile" : "Gate Policy"} already uses this name. You can
                  still save it, but the two will be hard to tell apart in the catalogue.
                </p>
              ) : null}
              {/* The id and the version used to be typed by hand on every record.
                  Both are generated now; the id is shown so it is not a surprise. */}
              <p className="text-xs text-muted-foreground">
                Saved as version {INITIAL_VERSION}
                {name.trim() ? `, id ${profileIdFromName(name, "…")}` : ""}.
              </p>
            </div>

            {isProfile ? (
              <div className="grid gap-2">
                <Label className="text-sm font-medium" htmlFor="governance-scenario">Scenario</Label>
                <select
                  id="governance-scenario"
                  value={scenario}
                  onChange={(event) => setScenario(event.target.value as typeof scenario)}
                  className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                >
                  <option value="llm_core">LLM core</option>
                  <option value="rag">RAG</option>
                  <option value="agentic">Agentic</option>
                </select>
              </div>
            ) : null}

            <fieldset className="grid gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <legend className="text-sm font-medium">
                  {isProfile ? "Checks" : "Checks that must not fail"}
                </legend>
                <p className="text-xs text-muted-foreground">{selectedMetrics.length} selected</p>
              </div>
              <GovernanceMetricPicker
                metrics={metrics}
                selected={selectedMetrics}
                hardFail={hardFail}
                onToggle={toggleMetric}
                onToggleHardFail={(metricId) =>
                  setHardFail((current) =>
                    current.includes(metricId)
                      ? current.filter((id) => id !== metricId)
                      : [...current, metricId],
                  )
                }
              />
              <p className="text-xs text-muted-foreground">
                {evidence.length > 0
                  ? `Requires evidence: ${evidence.join(", ")}.`
                  : "Evidence requirements are worked out from the checks you pick."}
              </p>
            </fieldset>

            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Who signs off</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {APPROVER_ROLES.map((role) => (
                  <label
                    key={role.id}
                    className="flex items-start gap-2 rounded-lg border border-input px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={approverRoles.includes(role.id)}
                      onChange={() =>
                        setApproverRoles((current) =>
                          current.includes(role.id)
                            ? current.filter((id) => id !== role.id)
                            : [...current, role.id],
                        )
                      }
                    />
                    <span>
                      <span className="font-medium">{role.label}</span>
                      <span className="block text-xs text-muted-foreground">{role.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Leave both clear to keep the platform default, which asks for an Approver.
              </p>
            </fieldset>
          </fieldset>

          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>

        <div className="flex justify-end gap-3 border-t px-5 py-4 sm:px-6">
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" disabled={pending || !name.trim() || selectedMetrics.length === 0}>
            {pending ? <LoaderCircle className="mr-2 size-4 animate-spin" aria-hidden="true" /> : null}
            {pending ? "Creating…" : `Create draft ${isProfile ? "Quality Profile" : "Gate Policy"}`}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
