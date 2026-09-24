"use client";

import Link from "next/link";
import { Check } from "lucide-react";

import { buttonVariants } from "@evalai/shared/ui/button";
import { cn } from "@evalai/shared/utils";
import type { ReleaseGatePolicyVersion } from "@/lib/api";
import type { CatalogueLoadState } from "@/components/contract-profiles-panel";
import { StatusBadge } from "@/components/status-badge";

export function ContractPoliciesPanel({
  policies,
  mode,
  selectedPolicyKey,
  onModeChange,
  onSelect,
  loadState = "ready",
  actionsDisabled = false,
}: {
  policies: ReleaseGatePolicyVersion[];
  mode: "none" | "configured";
  selectedPolicyKey: string;
  onModeChange: (mode: "none" | "configured") => void;
  onSelect: (policyKey: string) => void;
  loadState?: CatalogueLoadState;
  actionsDisabled?: boolean;
}) {
  return (
    <div>
      {loadState === "error" ? (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-4 text-sm text-destructive">
          Gate Policies could not be loaded. Refresh to retry. Policy selection is unavailable until the catalogue loads.
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Gate Policy choice">
        <PolicyModeOption
          checked={mode === "none"}
          title="None"
          description="Standardized evaluation: comparable scoring without release governance."
          disabled={actionsDisabled}
          onChange={() => onModeChange("none")}
        />
        <PolicyModeOption
          checked={mode === "configured"}
          title="Use a Gate Policy"
          description="Release-governed: approved policy rules determine release eligibility."
          disabled={actionsDisabled || loadState === "error"}
          onChange={() => onModeChange("configured")}
        />
      </div>

      {mode === "configured" ? (
        <div className="mt-5 border-t pt-5">
          {loadState === "loading" ? (
            <div role="status" className="rounded-lg border px-4 py-8 text-center text-sm text-muted-foreground">
              Loading Gate Policies…
            </div>
          ) : loadState === "error" ? null : policies.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              No approved Gate Policies are compatible with this Quality Profile. A policy
              can only gate on checks the Profile actually scores, so one whose hard-fail
              checks are missing from it is not offered here.
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <div
                aria-hidden="true"
                className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] gap-4 border-b bg-muted/40 px-4 py-2.5 text-xs font-medium text-muted-foreground md:grid"
              >
                <span>Gate Policy</span>
                <span>Requirements</span>
                <span>Status</span>
              </div>
              <div className="divide-y" role="radiogroup" aria-label="Selected Gate Policy">
                {policies.map((policy) => {
                  const key = `${policy.gate_policy_id}@${policy.version}`;
                  const selected = key === selectedPolicyKey;
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
                        <input
                          className="peer absolute inset-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
                          type="radio"
                          name="selected-policy"
                          aria-label={`${policy.name}, version ${policy.version}, approved`}
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
                          <span className="block truncate font-medium">{policy.name}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">Version {policy.version}</span>
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {policy.required_evidence.length} evidence · {policy.required_approver_roles.length} approvers
                        {policy.hard_blocker_metric_ids.length
                          ? ` · ${policy.hard_blocker_metric_ids.length} blockers`
                          : ""}
                      </span>
                      <StatusBadge status={policy.status} className="w-fit" />
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : null}

      <div className="mt-5 flex justify-end">
        <Link href="/contracts?tab=policies" className={buttonVariants({ variant: "outline" })}>
          Manage Gate Policies
        </Link>
      </div>
    </div>
  );
}

function PolicyModeOption({
  checked,
  title,
  description,
  disabled,
  onChange,
}: {
  checked: boolean;
  title: string;
  description: string;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={cn(
        "relative flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3.5 transition-colors",
        checked ? "border-primary bg-primary/5" : "hover:bg-muted/40",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input className="peer absolute inset-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed" type="radio" name="policy-mode" checked={checked} disabled={disabled} onChange={onChange} />
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/40 bg-background",
        )}
        aria-hidden="true"
      >
        {checked ? <Check className="size-3" strokeWidth={2.5} aria-hidden="true" /> : null}
      </span>
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}
