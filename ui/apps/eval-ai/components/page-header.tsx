import type { ReactNode } from "react";

import { cn } from "@evalai/shared/utils";
import type { NavigationSection } from "@/lib/navigation";

/**
 * The eyebrow names the workspace section a page lives in — the same four
 * groups the sidebar navigates (see NAVIGATION_GROUPS in lib/navigation.ts).
 * It answers one question, "what part of Proofgrove is this", so it must not
 * also carry the product name ("Proofgrove") or the kind of object on the page
 * ("Prompt", "Experiment") — those are two different questions and mixing
 * them into one slot is what made the eyebrow read as inconsistent.
 */
/** The same four names the sidebar groups by, so the two cannot drift apart. */
export type PageSection = NavigationSection;

export function PageHeader({
  section,
  title,
  description,
  actions,
  className,
}: {
  section?: PageSection;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "mb-8 flex flex-col gap-4 border-b border-border/70 pb-6 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        {section ? (
          <p className="eval-hub-eyebrow mb-2 text-eyebrow">{section}</p>
        ) : null}
        <h1 className="text-balance font-display text-3xl font-semibold tracking-tight text-foreground sm:text-[2rem]">
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-3xl text-pretty text-sm leading-6 text-muted-foreground sm:text-base">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
