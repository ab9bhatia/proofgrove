"use client";

import type { ReactNode } from "react";
import { cn } from "@evalai/shared/utils";
import { COLUMN_HEADER } from "@/lib/page-frame";
import { ChevronDown } from "lucide-react";
import { CatalogToolbar, SearchField } from "@/components/toolbar";

import type { TargetVersion } from "@/lib/api";

type AgentCard = {
  description?: string;
  protocolVersion?: string;
  skills?: Array<{ id?: string; name?: string }>;
};

function agentCard(target: TargetVersion): AgentCard {
  const value = target.configuration?.agent_card;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AgentCard)
    : {};
}

export function AgentCatalogList({
  agents,
  query,
  onQueryChange,
  footer,
}: {
  agents: TargetVersion[];
  footer?: ReactNode;
  query?: string;
  onQueryChange?: (query: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      {/* Same row as every other catalog list. This one had no search at all,
          so a long agent list could only be scanned by eye. */}
      {onQueryChange ? (
        <CatalogToolbar>
          <SearchField
            value={query ?? ""}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search agents…"
            label="Search onboarded agents"
          />
        </CatalogToolbar>
      ) : null}
      <div className="overflow-x-auto"><div className="min-w-[700px]">
      <div className={cn("grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,0.7fr)_7rem_6rem] gap-4", COLUMN_HEADER)}>
        <span>Agent</span>
        <span>Model</span>
        <span>Environment</span>
        <span>Source</span>
        <span className="text-right">Details</span>
      </div>

      {agents.length === 0 ? (
        <div className="space-y-3 px-5 py-10 text-center text-sm">
          <p>{query?.trim() ? "No agents match your search." : "No agents available."}</p>
          {query?.trim() && onQueryChange ? <button type="button" className="min-h-11 rounded-lg border px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onQueryChange("")}>Clear search</button> : null}
        </div>
      ) : null}
      <div role="list" aria-label="Onboarded agents" className="divide-y">
        {agents.map((agent) => {
          const card = agentCard(agent);
          const skills = Array.isArray(card.skills) ? card.skills : [];
          const platformSynced = agent.configuration?.catalog_source === "kagent_discovery";

          return (
            <article key={agent.target_version_id} role="listitem">
              <details className="group">
                <summary
                  aria-label={`Connection details for ${agent.name}`}
                  className="grid min-h-11 cursor-pointer list-none gap-4 px-4 py-4 transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 sm:px-5 grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,0.7fr)_7rem_6rem] items-center [&::-webkit-details-marker]:hidden"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                      <h3 className="min-w-0 truncate text-sm font-semibold tracking-tight" title={agent.name}>
                        {agent.name}
                      </h3>
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground" translate="no">
                      {agent.target_id}
                    </p>
                    {/* The endpoint is a machine address, not a way to tell two
                        agents apart. It is in Details, one click away, where it
                        can be read in full instead of wrapping over two lines. */}
                  </div>

                  <div className="min-w-0 text-sm">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground sr-only">
                      Model
                    </span>
                    <span className="block truncate font-medium" title={agent.model_version || undefined}>
                      {agent.model_version || "Not reported"}
                    </span>
                  </div>

                  <div className="text-sm">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground sr-only">
                      Environment
                    </span>
                    <span className="font-medium capitalize">{agent.environment || "—"}</span>
                  </div>

                  <div className="min-w-0 text-sm">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground sr-only">
                      Source
                    </span>
                    <SourceLabel platformSynced={platformSynced} />
                  </div>

                  <span className="flex items-center gap-1 text-sm font-medium text-primary justify-end">
                    Details
                    <ChevronDown
                      aria-hidden="true"
                      className="size-4 transition-transform group-open:rotate-180"
                    />
                  </span>
                </summary>

                <div className="border-t bg-muted/20 px-4 py-4 sm:px-5">
                  <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
                    <div className="min-w-0 sm:col-span-2 xl:col-span-4">
                      <dt className="text-xs font-medium text-muted-foreground">Description</dt>
                      <dd className="mt-1 leading-5">
                        {card.description?.trim() || "No description provided."}
                      </dd>
                    </div>
                    <TechnicalDetail label="Target ID" value={agent.target_id} mono />
                    <TechnicalDetail label="Version" value={agent.version} mono />
                    <TechnicalDetail
                      label="Protocol"
                      value={card.protocolVersion || "Not reported"}
                    />
                    <TechnicalDetail
                      label="Skills"
                      value={
                        skills.length
                          ? skills.map((skill) => skill.name || skill.id).filter(Boolean).join(", ")
                          : "None reported"
                      }
                    />
                    <div className="min-w-0 sm:col-span-2 xl:col-span-4">
                      <dt className="text-xs font-medium text-muted-foreground">Endpoint</dt>
                      <dd className="mt-1 break-all font-mono text-xs leading-5 text-foreground" translate="no">
                        {agent.endpoint}
                      </dd>
                    </div>
                  </dl>
                </div>
              </details>
            </article>
          );
        })}
      </div>
      </div></div>
      {footer}
    </div>
  );
}

/**
 * Where the agent came from.
 *
 * This was a green badge with a tick in both states — "Platform synced" and
 * "Verified" — so every row carried the same success mark and it distinguished
 * nothing. Source is an attribute like model or environment, so it reads as one:
 * a column, in the same plain text as its neighbours.
 */
function SourceLabel({ platformSynced }: { platformSynced: boolean }) {
  return (
    <span className="truncate text-xs text-muted-foreground">
      {platformSynced ? "Platform" : "Manual"}
    </span>
  );
}

function TechnicalDetail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        className={mono ? "mt-1 break-all font-mono text-xs" : "mt-1 break-words font-medium"}
        translate={mono ? "no" : undefined}
      >
        {value}
      </dd>
    </div>
  );
}
