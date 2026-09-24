"use client";

import Link from "next/link";
import { Check } from "lucide-react";

import { buttonVariants } from "@evalai/shared/ui/button";
import { cn } from "@evalai/shared/utils";
import type { QualityProfileVersion } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";

export type CatalogueLoadState = "loading" | "ready" | "error";

export function ContractProfilesPanel({
  profiles,
  selectedProfileKey,
  onSelect,
  loadState = "ready",
  actionsDisabled = false,
  disabledReason = null,
  hiddenNote = null,
}: {
  profiles: QualityProfileVersion[];
  selectedProfileKey: string;
  onSelect: (profileKey: string) => void;
  loadState?: CatalogueLoadState;
  actionsDisabled?: boolean;
  disabledReason?: string | null;
  hiddenNote?: string | null;
}) {
  // A disabled row has to say why it is disabled, not just look faded. One id for the
  // whole group: the reason is the same for every row.
  const disabledReasonId = "profile-selection-disabled-reason";
  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">
        Approved Quality Profiles compatible with the selected Project are available here.
        Lifecycle management stays in Evaluation governance.
      </p>

      {/* A Profile that does not appear here has been filtered out, and silence about
          that reads as "it does not exist". Say how many and why. */}
      {hiddenNote ? (
        <p className="mb-4 text-sm text-muted-foreground">{hiddenNote}</p>
      ) : null}

      {actionsDisabled && disabledReason ? (
        <p id={disabledReasonId} className="mb-4 text-sm text-muted-foreground">
          {disabledReason}
        </p>
      ) : null}

      {loadState === "loading" ? (
        <div role="status" className="rounded-lg border px-4 py-8 text-center text-sm text-muted-foreground">
          Loading Quality Profiles…
        </div>
      ) : loadState === "error" ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-4 text-sm text-destructive">
          Quality Profiles could not be loaded. Refresh to retry before selecting or creating anything.
        </div>
      ) : profiles.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No approved Quality Profiles are compatible with this Project.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div
            aria-hidden="true"
            className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] gap-4 border-b bg-muted/40 px-4 py-2.5 text-xs font-medium text-muted-foreground md:grid"
          >
            <span>Quality Profile</span>
            <span>Coverage</span>
            <span>Status</span>
          </div>
          <div className="divide-y" role="radiogroup" aria-label="Selected quality profile">
            {profiles.map((profile) => {
              const key = `${profile.profile_id}@${profile.version}`;
              const selected = key === selectedProfileKey;
              return (
                <label
                  key={key}
                  className={cn(
                    "relative grid cursor-pointer gap-3 px-4 py-3.5 text-sm transition-colors md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] md:items-center md:gap-4",
                    selected ? "bg-primary/5" : "hover:bg-muted/40",
                    actionsDisabled && "cursor-not-allowed opacity-60",
                  )}
                >
                  <span className="flex min-w-0 items-start gap-2.5">
                    {/* The input covers the whole row rather than hiding at 1x1 under
                        `sr-only`: the row is the click target a user aims at, and a
                        real element there is what carries the focus ring below. */}
                    <input
                      className="peer absolute inset-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
                      type="radio"
                      name="selected-profile"
                      aria-label={`${profile.name}, version ${profile.version}, approved, ${profile.project_id ? `scoped to Project ${profile.project_id}` : "reusable across Projects"}`}
                      aria-describedby={actionsDisabled && disabledReason ? disabledReasonId : undefined}
                      value={key}
                      checked={selected}
                      disabled={actionsDisabled}
                      onChange={() => onSelect(key)}
                    />
                    <span
                      className={cn(
                        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
                        "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2",
                        selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-muted-foreground/40 bg-background",
                      )}
                      aria-hidden="true"
                    >
                      {selected ? <Check className="size-3" strokeWidth={2.5} aria-hidden="true" /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{profile.name}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Version {profile.version} · {profile.project_id ? "This Project" : "Reusable"}
                      </span>
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {profile.metric_ids.length} {profile.metric_ids.length === 1 ? "metric" : "metrics"}
                    {profile.evidence_requirements.length > 0
                      ? ` · ${profile.evidence_requirements.length} evidence`
                      : ""}
                  </span>
                  <StatusBadge status={profile.status} className="w-fit" />
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-5 flex justify-end">
        <Link href="/contracts?tab=profiles" className={buttonVariants({ variant: "outline" })}>
          Manage Quality Profiles
        </Link>
      </div>
    </div>
  );
}
