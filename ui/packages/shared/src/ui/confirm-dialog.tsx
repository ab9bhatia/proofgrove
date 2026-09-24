"use client";

import type { LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "../utils";

export interface OverlayConfirmDialogProps {
  icon?: LucideIcon;
  /** Visual tone for the icon badge and confirm button. Defaults to "destructive". */
  tone?: "destructive" | "default";
  title: string;
  description: ReactNode;
  cancelLabel?: string;
  confirmLabel: string;
  /** Label shown on the confirm button while `pending` is true. Defaults to `confirmLabel`. */
  pendingLabel?: string;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Generic "are you sure?" dialog used for destructive actions (delete) and
 * unsaved-changes guards (discard). Renders as its own fixed-position overlay,
 * so it can be layered on top of another modal — callers should mount it
 * conditionally rather than pass an `open` prop.
 */
export function OverlayConfirmDialog({
  icon: Icon,
  tone = "destructive",
  title,
  description,
  cancelLabel = "Cancel",
  confirmLabel,
  pendingLabel,
  pending = false,
  onCancel,
  onConfirm,
}: OverlayConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-md flex-col gap-5 rounded-3xl bg-background p-6 shadow-xl sm:min-w-[380px]">
        <div className="flex flex-col gap-2">
          {Icon && (
            <div
              aria-hidden="true"
              className={cn(
                "grid size-11 place-items-center rounded-full",
                tone === "destructive" ? "bg-destructive/10" : "bg-muted",
              )}
            >
              <Icon
                className={cn(
                  "size-5",
                  tone === "destructive" ? "text-destructive" : "text-foreground",
                )}
              />
            </div>
          )}
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <div id={descriptionId} className="text-sm text-muted-foreground">
            {description}
          </div>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="flex-1 rounded-full border border-border py-2.5 text-sm font-medium hover:bg-muted disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={cn(
              "flex-1 rounded-full py-2.5 text-sm font-semibold disabled:opacity-40",
              tone === "destructive"
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-foreground text-background hover:bg-foreground/90",
            )}
          >
            {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
