"use client";

import { useEffect, useRef } from "react";
import { LoaderCircle, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { cn } from "@evalai/shared/utils";
import { Button, buttonVariants } from "@evalai/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@evalai/shared/ui/dropdown-menu";
import type { QualityProfileVersion, ReleaseGatePolicyVersion } from "@/lib/api";

export type GovernanceLifecycleAction = "validate" | "approve" | "retire" | "reinstate";
export type GovernanceRecord =
  | { kind: "profile"; value: QualityProfileVersion }
  | { kind: "policy"; value: ReleaseGatePolicyVersion };
export type ProfilePrimaryAction = "mark-tested" | GovernanceLifecycleAction;

export function profilePrimaryAction(profile: QualityProfileVersion): ProfilePrimaryAction | null {
  // Retirement is reversible now: a retired version returns to draft, re-tests
  // and re-earns approval. Before this the row simply had no action at all.
  if (profile.status === "retired") return "reinstate";
  if (profile.status === "approved") return "retire";
  if ((profile.test_status || "not_tested") === "not_tested") return "mark-tested";
  if (profile.status === "validated") return "approve";
  if (profile.status === "draft") return "validate";
  return null;
}

export function policyPrimaryAction(
  policy: ReleaseGatePolicyVersion,
): GovernanceLifecycleAction | null {
  if (policy.status === "draft") return "validate";
  if (policy.status === "validated") return "approve";
  if (policy.status === "approved") return "retire";
  if (policy.status === "retired") return "reinstate";
  return null;
}

function recordIdentity(record: GovernanceRecord): string {
  return record.kind === "profile"
    ? `${record.value.profile_id}@${record.value.version}`
    : `${record.value.gate_policy_id}@${record.value.version}`;
}

function actionLabel(action: ProfilePrimaryAction): string {
  if (action === "mark-tested") return "Mark tested";
  if (action === "reinstate") return "Reinstate";
  return action.charAt(0).toUpperCase() + action.slice(1);
}

export function GovernanceRowActions({
  record,
  canAuthor = true,
  pendingAction = null,
  onLifecycleAction,
  onMarkTested,
  onCopyId,
  onTechnicalDetails,
}: {
  record: GovernanceRecord;
  canAuthor?: boolean;
  pendingAction?: string | null;
  onLifecycleAction: (record: GovernanceRecord, action: GovernanceLifecycleAction) => void;
  onMarkTested: (profile: QualityProfileVersion, mode: "tested" | "overridden") => void;
  onCopyId: (record: GovernanceRecord) => void;
  onTechnicalDetails: (record: GovernanceRecord) => void;
}) {
  const preventMenuFocusRestore = useRef(false);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const wasPending = useRef(false);
  const name = record.value.name;
  const primary =
    record.kind === "profile"
      ? profilePrimaryAction(record.value)
      : policyPrimaryAction(record.value);
  const actionKey = primary ? `${recordIdentity(record)}:${primary}` : null;
  const pending = actionKey != null && pendingAction === actionKey;
  const canOverride =
    record.kind === "profile" &&
    (record.value.status === "draft" || record.value.status === "validated") &&
    (record.value.test_status || "not_tested") === "not_tested";

  // A lifecycle action can remove the button that triggered it — Retire leaves the row
  // with no primary action at all — and the browser then drops focus to <body>, losing
  // the keyboard user's place in the list. The row's menu is always there, so focus
  // lands on that instead.
  useEffect(() => {
    if (wasPending.current && !pending && document.activeElement === document.body) {
      menuTriggerRef.current?.focus();
    }
    wasPending.current = pending;
  }, [pending]);

  const runPrimary = () => {
    if (!primary) return;
    if (primary === "mark-tested" && record.kind === "profile") {
      onMarkTested(record.value, "tested");
      return;
    }
    onLifecycleAction(record, primary as GovernanceLifecycleAction);
  };

  return (
    // Fixed geometry, not fixed content. The primary action stays visible in the
    // row (Profiles and Policies are managed from here), but the button is one
    // width for every label and the slot is reserved even when a row has no
    // primary action left — otherwise Mark tested / Validate / Retire each
    // measured differently and retired rows left a hole, so no two rows put
    // their controls in the same place.
    <div className="relative z-10 flex items-center justify-end gap-2" onClick={(event) => event.stopPropagation()}>
      <div className="flex w-[7.5rem] justify-end">
        {canAuthor && primary ? (
          <Button
            type="button"
            size="sm"
            className="w-full"
            variant={primary === "retire" || primary === "reinstate" ? "outline" : "default"}
            disabled={pending}
            aria-label={`${actionLabel(primary)} ${name}`}
            onClick={runPrimary}
          >
            {pending ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
            {pending ? "Saving…" : actionLabel(primary)}
          </Button>
        ) : null}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={menuTriggerRef}
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={`More actions for ${name}`}
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-48"
          onCloseAutoFocus={(event) => {
            if (!preventMenuFocusRestore.current) return;
            event.preventDefault();
            preventMenuFocusRestore.current = false;
          }}
        >
          {canAuthor && canOverride && record.kind === "profile" ? (
            <DropdownMenuItem onSelect={() => onMarkTested(record.value, "overridden")}>
              Override Not tested
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => onCopyId(record)}>Copy ID</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              preventMenuFocusRestore.current = true;
              onTechnicalDetails(record);
            }}
          >
            Technical details
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function AssignmentRowActions({
  name,
  archived,
  canAuthor,
  pending,
  runHref,
  detailsHref,
  copied,
  onCopyLink,
  onArchiveToggle,
}: {
  name: string;
  archived: boolean;
  canAuthor: boolean;
  pending: boolean;
  runHref: string;
  detailsHref: string;
  copied: boolean;
  onCopyLink: () => void;
  onArchiveToggle: () => void;
}) {
  return (
    // Same geometry as GovernanceRowActions above: one fixed-width primary slot,
    // then the menu. Assignments used to render four flat buttons of equal weight,
    // which is what made this tab look unlike the other two.
    <div className="relative z-10 flex items-center justify-end gap-2" onClick={(event) => event.stopPropagation()}>
      <div className="flex w-[7.5rem] justify-end">
        {!archived ? (
          <Link
            href={runHref}
            aria-label="Run evaluation with this Assignment"
            className={cn(buttonVariants({ size: "sm" }), "w-full")}
          >
            Run evaluation
          </Link>
        ) : canAuthor ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full"
            aria-label="Restore Assignment"
            disabled={pending}
            onClick={onArchiveToggle}
          >
            {pending ? "Restoring…" : "Restore"}
          </Button>
        ) : null}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="icon-sm" aria-label={`More actions for ${name}`}>
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem asChild>
            <Link href={detailsHref}>View details</Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onCopyLink}>{copied ? "Copied" : "Copy link"}</DropdownMenuItem>
          {canAuthor && !archived ? (
            <DropdownMenuItem onSelect={onArchiveToggle} disabled={pending}>
              Archive Assignment
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
