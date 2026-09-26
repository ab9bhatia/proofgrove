"use client";

import { PAGE_FRAME } from "@/lib/page-frame";
import Link from "next/link";
import { useParams, useSelectedLayoutSegments } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Clock, Radio } from "lucide-react";
import { ProofgroveGate } from "@/components/proofgrove-gate";
import { api, type TraceProject } from "@/lib/api";
import { formatDateTime } from "@/lib/format-time";
import { NavTab, NavTabs } from "@/components/ui/tabs";

// Persistent workspace shell for a single Project. The header (identity,
// environment, last-trace time, time-range affordance) and the tab strip stay
// mounted while navigating between the Traces list, the Spans index and an
// individual trace, so this is a real workspace rather than a bare list. Only
// the Traces and Spans tabs exist — Sessions/Metrics are deliberately out of
// scope (no backend).
export default function ProjectWorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <ProofgroveGate>
      <ProjectWorkspace>{children}</ProjectWorkspace>
    </ProofgroveGate>
  );
}

function ProjectWorkspace({ children }: { children: ReactNode }) {
  const params = useParams<{ projectId: string }>();
  const projectId = decodeURIComponent(params.projectId);
  const segments = useSelectedLayoutSegments();
  const [project, setProject] = useState<TraceProject | null>(null);
  // Distinguishes a genuine "no metadata recorded" (loaded, project null) from a
  // lookup failure (error) so the header never renders a fetch failure as if the
  // fields were simply blank.
  const [metaStatus, setMetaStatus] = useState<"loading" | "loaded" | "error">("loading");

  const load = useCallback(async () => {
    setMetaStatus("loading");
    try {
      const { tenant_id: tenantId } = await api.tenant();
      const projects = await api.listTraceProjects(tenantId);
      setProject(projects.find((item) => item.project_id === projectId) ?? null);
      setMetaStatus("loaded");
    } catch {
      // The header degrades to the raw project id and surfaces an explicit
      // "details unavailable" note with a retry; the child page owns the
      // authoritative error surface for trace loading.
      setProject(null);
      setMetaStatus("error");
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const tracesActive = segments[0] === "traces";
  const spansActive = segments[0] === "spans";

  return (
    <div className={PAGE_FRAME}>
      <Link
        href="/projects"
        className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="size-4" aria-hidden="true" /> Projects
      </Link>

      <header className="flex flex-col gap-4 border-b border-border/60 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Radio className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Project workspace</p>
            <h1 className="mt-1 text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
              {project?.name || projectId}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {metaStatus === "error" ? (
                <span className="inline-flex items-center gap-2 rounded-full border border-state-caution/30 px-2 py-0.5 text-state-caution dark:border-state-caution/30 dark:text-state-caution">
                  Project details unavailable
                  <button
                    type="button"
                    onClick={() => void load()}
                    className="font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Retry
                  </button>
                </span>
              ) : (
                <>
                  <span className="inline-flex items-center rounded-full border px-2 py-0.5">
                    {project?.tags?.environment || project?.system_type || "Environment not set"}
                  </span>
                  {project?.classification_state === "unclassified_historical" ? (
                    <span className="inline-flex items-center rounded-full border border-state-caution/30 px-2 py-0.5 text-state-caution dark:border-state-caution/30 dark:text-state-caution">
                      Historical · purpose not classified
                    </span>
                  ) : null}
                  <span className="inline-flex items-center gap-1">
                    <Clock className="size-3.5" aria-hidden="true" />
                    Last trace {project?.last_activity_at ? formatDateTime(project.last_activity_at) : "not recorded"}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Time-range filtering lives in the Traces toolbar, backed by the
            traces/page `since` contract — no placeholder control here. */}
      </header>

      {/* Route navigation, not a tab widget: NavTabs renders a <nav> of links
          with aria-current, sharing only the underline tab visual language. */}
      <NavTabs aria-label="Project sections" className="mt-4">
        <NavTab asChild active={tracesActive}>
          <Link href={`/projects/${encodeURIComponent(projectId)}/traces`}>Traces</Link>
        </NavTab>
        <NavTab asChild active={spansActive}>
          <Link href={`/projects/${encodeURIComponent(projectId)}/spans`}>Spans</Link>
        </NavTab>
      </NavTabs>

      <div className="pt-6">{children}</div>
    </div>
  );
}
