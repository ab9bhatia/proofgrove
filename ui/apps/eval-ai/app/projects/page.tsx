"use client";

import { SearchField, CatalogToolbar } from "@/components/toolbar";
import { PAGE_FRAME } from "@/lib/page-frame";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Archive, ChevronRight, Plus, RadioTower, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { OverlayConfirmDialog } from "@/components/ui/confirm-dialog";
import { ProjectCreateDialog } from "@/components/contract-projects-panel";
import { EvalHubGate } from "@/components/eval-hub-gate";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, LoadingState } from "@/components/page-state";
import { api, platformApi, type EvaluationProject, type TraceProject } from "@/lib/api";
import { formatDateTime } from "@/lib/format-time";
import { userFacingError } from "@/lib/api-errors";

export default function ProjectsPage() {
  return <EvalHubGate><ProjectsView /></EvalHubGate>;
}

function ProjectsView() {
  const [projects, setProjects] = useState<TraceProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [createdProject, setCreatedProject] = useState<EvaluationProject | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [showArchived, setShowArchived] = useState(false);
  const [projectToArchive, setProjectToArchive] = useState<TraceProject | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [projectToRestore, setProjectToRestore] = useState<TraceProject | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<TraceProject | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      setProjects(await api.listTraceProjects(tenantId));
    } catch (reason) {
      setError(userFacingError(reason, "Unable to load Projects"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    setError(null);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      const project = await platformApi.createProject({
        project_id: crypto.randomUUID(),
        tenant_id: tenantId,
        name: String(form.get("name") || "").trim(),
        system_type: "application",
        owner: String(form.get("owner") || "").trim(),
        status: "active",
        purpose: "system",
        tags: {},
        created_by: "user",
      });
      setCreatedProject(project);
      setCreateOpen(false);
      await load();
    } catch (reason) {
      setError(userFacingError(reason, "Unable to create tracing project"));
    } finally {
      setSubmitting(false);
    }
  }

  async function archiveProject() {
    if (!projectToArchive) return;
    setArchiving(true);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      await platformApi.archiveProject(projectToArchive.project_id, tenantId);
      setProjectToArchive(null);
      await load();
    } catch (reason) {
      setError(userFacingError(reason, "Unable to archive project"));
    } finally {
      setArchiving(false);
    }
  }

  async function restoreProject() {
    if (!projectToRestore) return;
    setRestoring(true);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      await platformApi.restoreProject(projectToRestore.project_id, tenantId);
      setProjectToRestore(null);
      await load();
    } catch (reason) {
      setError(userFacingError(reason, "Unable to restore project"));
    } finally {
      setRestoring(false);
    }
  }

  async function deleteProject() {
    if (!projectToDelete) return;
    setDeleting(true);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      await platformApi.deleteProject(projectToDelete.project_id, tenantId);
      setProjectToDelete(null);
      await load();
    } catch (reason) {
      // The API refuses with 409 and names what still holds the Project, so
      // surface that text rather than a generic failure.
      setError(userFacingError(reason, "Unable to delete project"));
    } finally {
      setDeleting(false);
    }
  }

  const archivedCount = projects.filter((project) => project.status === "archived").length;
  const visibleProjects = visibleTraceProjects(projects, showArchived)
    .filter((project) => [project.name, project.description, project.system_type].join(" ").toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : (b.last_activity_at || "").localeCompare(a.last_activity_at || ""));

  return (
    <div className={PAGE_FRAME}>
      <PageHeader
        section="Workspace"
        title="Observability"
        description="Create a Project for an evaluated AI system, then browse its captured traces. Evidence without a genuine trace ID remains in the evaluation case inspector."
        actions={
          <Button type="button" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden="true" />
            New project
          </Button>
        }
      />
      {createdProject ? (
        <section className="mb-5 rounded-xl border bg-muted/20 p-4" aria-live="polite">
          <p className="text-sm font-semibold">{createdProject.name} is ready</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Bind your collector or evaluation target to this Project ID. Traces appear only after
            genuine trace and parent-span identifiers are persisted; an empty Project does not
            fabricate a trace tree.
          </p>
          <code className="mt-3 block overflow-x-auto rounded-lg border bg-background px-3 py-2 text-xs">
            {createdProject.project_id}
          </code>
        </section>
      ) : null}
      <div className="mb-5 overflow-hidden rounded-xl border bg-card">
        <CatalogToolbar>
          <SearchField value={query} onChange={(event) => setQuery(event.target.value)} label="Search projects" placeholder="Search projects…" />
          <select aria-label="Sort projects" value={sort} onChange={(event) => setSort(event.target.value)} className="h-11 rounded-lg border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <option value="recent">Recent activity</option>
            <option value="name">Name</option>
          </select>
          <Button type="button" variant="outline" aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
          </Button>
        </CatalogToolbar>
      </div>
      {loading ? <LoadingState label="Loading Projects…" /> : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : visibleProjects.length === 0 ? (
        <EmptyState
          title={query.trim() ? "No matching projects" : projects.length ? "No active Projects" : "No Projects yet"}
          description={query.trim() ? "Try another name or clear the search to see projects again." : projects.length ? "Archived Projects are preserved and can be shown with the filter above." : "Create or bind an evaluation to a Project. Historical Projects remain visible as unclassified until their purpose is confirmed."}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {visibleProjects.map((project) => (
            <ProjectCard
              key={project.project_id}
              project={project}
              onArchive={setProjectToArchive}
              onRestore={setProjectToRestore}
              onDelete={setProjectToDelete}
            />
          ))}
        </div>
      )}
      {createOpen ? (
        <ProjectCreateDialog
          submitting={submitting}
          actionsDisabled={false}
          onClose={() => setCreateOpen(false)}
          onSubmit={createProject}
          description="Create a tenant-scoped tracing workspace. It remains empty until genuine trace evidence is captured and bound to it."
        />
      ) : null}
      {projectToArchive ? (
        <OverlayConfirmDialog
          icon={Archive}
          title="Archive project?"
          description={`${projectToArchive.name} will stop accepting new evaluation runs. Its traces and evaluation evidence remain available.`}
          confirmLabel="Archive project"
          pendingLabel="Archiving…"
          pending={archiving}
          onCancel={() => setProjectToArchive(null)}
          onConfirm={() => void archiveProject()}
        />
      ) : null}
      {projectToRestore ? (
        <OverlayConfirmDialog
          icon={RotateCcw}
          tone="default"
          title="Restore project?"
          description={`${projectToRestore.name} will accept new evaluation runs again.`}
          confirmLabel="Restore project"
          pendingLabel="Restoring…"
          pending={restoring}
          onCancel={() => setProjectToRestore(null)}
          onConfirm={() => void restoreProject()}
        />
      ) : null}
      {projectToDelete ? (
        <OverlayConfirmDialog
          icon={Trash2}
          title="Delete project permanently?"
          description={
            <>
              <span className="block">
                {projectToDelete.name} and its {projectToDelete.trace_count} captured
                trace{projectToDelete.trace_count === 1 ? "" : "s"} will be removed from Eval
                Hub. This cannot be undone.
              </span>
              <span className="mt-2 block text-xs">
                Archived span payloads are stored in hourly batches shared across every
                Project in the tenant, so they are not pruned here — they age out under the
                archive&apos;s own retention. Deletion removes these traces from Proofgrove, not
                from the archive.
              </span>
            </>
          }
          confirmLabel="Delete project"
          pendingLabel="Deleting…"
          pending={deleting}
          onCancel={() => setProjectToDelete(null)}
          onConfirm={() => void deleteProject()}
        />
      ) : null}
    </div>
  );
}

export function visibleTraceProjects(projects: TraceProject[], showArchived: boolean) {
  return showArchived ? projects : projects.filter((project) => project.status !== "archived");
}

export function ProjectCard({
  project,
  onArchive,
  onRestore,
  onDelete,
}: {
  project: TraceProject;
  onArchive: (project: TraceProject) => void;
  onRestore?: (project: TraceProject) => void;
  onDelete?: (project: TraceProject) => void;
}) {
  const archived = project.status === "archived";
  return (
    <article className="group rounded-xl border bg-card p-5 transition-colors hover:border-foreground/30">
      <div className="flex items-start justify-between gap-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <RadioTower className="size-4" aria-hidden="true" />
        </span>
        <div className="flex items-center gap-1">
          {project.project_id !== "unassigned" ? (
            archived ? (
              /* Archiving is reversible, and an archived Project can be removed
                 for good. Delete lives only here, so it is always two steps
                 from the active list. */
              <>
                {onRestore ? (
                  <button
                    type="button"
                    aria-label={`Restore project ${project.name}`}
                    title="Restore project"
                    onClick={() => onRestore(project)}
                    className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <RotateCcw className="size-4" aria-hidden="true" />
                  </button>
                ) : null}
                {onDelete ? (
                  <button
                    type="button"
                    aria-label={`Delete project ${project.name}`}
                    title="Delete project permanently"
                    onClick={() => onDelete(project)}
                    className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                ) : null}
              </>
            ) : (
              <button
                type="button"
                aria-label={`Archive project ${project.name}`}
                title="Archive project"
                onClick={() => onArchive(project)}
                className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Archive className="size-4" aria-hidden="true" />
              </button>
            )
          ) : null}
          <Link
            href={`/projects/${encodeURIComponent(project.project_id)}/traces`}
            aria-label={`Open project ${project.name}`}
            className="inline-flex size-9 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
        </div>
      </div>
      <Link
        href={`/projects/${encodeURIComponent(project.project_id)}/traces`}
        className="mt-5 block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <h2 className="text-sm font-semibold">{project.name}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{project.description || project.system_type}</p>
      </Link>
      {archived ? (
        <p className="mt-3 text-xs font-medium text-muted-foreground">Archived</p>
      ) : project.classification_state === "unclassified_historical" ? (
        <p className="mt-3 text-xs text-state-caution">
          Historical Project · purpose not classified
        </p>
      ) : null}
      <div className="mt-5 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
        <span>{project.trace_count} captured trace{project.trace_count === 1 ? "" : "s"}</span>
        <time dateTime={project.last_activity_at || undefined}>{project.last_activity_at ? formatDateTime(project.last_activity_at) : "No activity recorded"}</time>
      </div>
    </article>
  );
}
