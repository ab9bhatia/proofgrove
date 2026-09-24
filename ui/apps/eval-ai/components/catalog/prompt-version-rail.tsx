"use client";

import { cn } from "@evalai/shared/utils";

import { Chip } from "@/components/status-badge";
import type { PromptVersion } from "@/lib/api";
import { formatDate } from "@/lib/format-time";
import { promptPreview } from "@/lib/prompts";

/**
 * The prompt's history, as a list you read from.
 *
 * Versions used to collapse into a `<details>` at the bottom of a catalog card,
 * which made history something you opened rather than something you compared
 * against. Here every version is one row, and choosing one swaps the text beside
 * it — so seeing what changed is a click, not a round trip through a dialog.
 */
export function PromptVersionRail({
  versions,
  openVersion,
  productionVersion,
  onOpen,
  onCompare,
}: {
  /** Newest first, as `groupPromptVersions` returns them. */
  versions: PromptVersion[];
  openVersion: number;
  productionVersion: number | null;
  onOpen: (version: PromptVersion) => void;
  onCompare?: (version: PromptVersion) => void;
}) {
  return (
    <section className="panel overflow-hidden" aria-labelledby="prompt-version-rail-title">
      <h2
        id="prompt-version-rail-title"
        className="border-b px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {versions.length} {versions.length === 1 ? "version" : "versions"}
      </h2>
      <ul className="max-h-[60vh] divide-y overflow-y-auto">
        {versions.map((version) => {
          const open = version.version === openVersion;
          return (
            <li key={version.version}>
              <button
                type="button"
                onClick={() => onOpen(version)}
                // The open row is the one whose text fills the pane beside it.
                aria-current={open ? "true" : undefined}
                className={cn(
                  "block min-h-11 w-full px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  // A 5%-opacity brand tint was the only sign of which version filled
                  // the pane, so the page could show v1 while the rail looked like it
                  // was pointing at v2. The inset rule reads at a glance and, unlike a
                  // real border, costs no layout. Neutral rather than brand: lime
                  // already carries identity, active nav and pass status.
                  open
                    ? "bg-secondary font-medium shadow-[inset_3px_0_0_var(--primary)]"
                    : "hover:bg-muted/40",
                )}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium tabular-nums">v{version.version}</span>
                  {version.archived_at ? <Chip>Archived</Chip> : null}
                  {version.version === productionVersion ? (
                    <span className="inline-flex items-center rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand-text ring-1 ring-brand/25 dark:bg-brand/15 dark:text-brand dark:ring-brand/30">
                      production
                    </span>
                  ) : null}
                  {version.labels
                    .filter((label) => label !== "production")
                    .map((label) => (
                      <Chip key={label}>{label}</Chip>
                    ))}
                </span>
                {/* What changed, when. A row reading only "v3" makes the history
                    a list of numbers rather than a record of decisions; the text
                    itself is already in the pane beside it. */}
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {version.description?.trim() || promptPreview(version.content, 60)}
                </span>
                {version.created_at ? (
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {formatDate(version.created_at)}
                    {version.created_by ? ` · ${version.created_by}` : ""}
                  </span>
                ) : null}
              </button>
              {onCompare && versions.length > 1 ? <button type="button" onClick={() => onCompare(version)} className="min-h-11 w-full px-4 pb-2 text-left text-sm font-medium text-brand-text hover:underline focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Compare version ${version.version}`}>Compare with another version</button> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
