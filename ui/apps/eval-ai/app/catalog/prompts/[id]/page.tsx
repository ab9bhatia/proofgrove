"use client";

import { PAGE_FRAME } from "@/lib/page-frame";
import { FormEvent, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Archive, Pencil, Plus, RefreshCw } from "lucide-react";

import { Button } from "@evalai/shared/ui/button";
import { OverlayConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@evalai/shared/utils";

import { EvalHubGate } from "@/components/eval-hub-gate";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/page-state";
import { PromptFormDialog } from "@/components/catalog/prompt-form-dialog";
import { CopyButton } from "@/components/copy-button";
import { PromptComparison } from "@/components/catalog/prompt-comparison";
import { PromptVersionRail } from "@/components/catalog/prompt-version-rail";
import { Chip, ProductionBadge } from "@/components/status-badge";
import {
  api,
  platformApi,
  type PlatformCapabilities,
  type PromptVersion,
} from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import { formatDateTime } from "@/lib/format-time";
import {
  decodePromptId,
  groupPromptVersions,
  leadVersion,
  productionVersion,
  promptRef,
} from "@/lib/prompts";

export default function PromptDetailPage() {
  return (
    <EvalHubGate>
      <Suspense fallback={<ListSkeleton label="Loading this prompt…" />}><PromptDetail /></Suspense>
    </EvalHubGate>
  );
}

function PromptDetail() {
  const params = useParams<{ id: string }>();
  const promptId = decodePromptId(params?.id ?? "");
  const searchParams = useSearchParams();
  const requestedComparison = Number(searchParams.get("compare"));
  const [comparisonVersion, setComparisonVersion] = useState<number | null>(null);
  const [comparisonClosed, setComparisonClosed] = useState(false);

  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  // Per-action locks: without them a double-click sends the request twice.
  const [promoting, setPromoting] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [versionToArchive, setVersionToArchive] = useState<PromptVersion | null>(null);
  // Which version the reading pane is showing. Null means "whichever leads" —
  // held as a number rather than the object so a reload does not strand it on a
  // stale copy of the same version.
  const [openVersion, setOpenVersion] = useState<number | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  // Which version the open form was seeded from, so the dialog can say that a
  // version is never overwritten. Undefined means "writing a fresh one".
  const [editingFrom, setEditingFrom] = useState<number | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    if (!promptId) return;
    setLoading(true);
    setError(null);
    try {
      const [tenant, listed, capabilities] = await Promise.all([
        api.tenant(),
        platformApi.listPrompts(promptId, true),
        platformApi.capabilities().catch((): PlatformCapabilities => ({ actions: {} })),
      ]);
      setTenantId(tenant.tenant_id);
      setVersions(listed);
      setCanManage(capabilities.actions?.manage_prompts === true);
    } catch (reason) {
      setError(userFacingError(reason, "Could not load this prompt."));
    } finally {
      setLoading(false);
    }
  }, [promptId]);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const prompt = useMemo(() => groupPromptVersions(versions)[0] ?? null, [versions]);
  const live = prompt ? productionVersion(prompt) : null;
  // Derived during render rather than synced by an effect: the open version is a
  // function of what loaded plus what was clicked, and an effect would render
  // one frame of the wrong body first.
  const shown = prompt
    ? prompt.versions.find((version) => version.version === openVersion) ?? leadVersion(prompt)
    : null;

  async function promote(version: PromptVersion) {
    const ref = promptRef(version);
    if (promoting) return;
    setPromoting(ref);
    setError(null);
    try {
      await platformApi.movePromptLabel(version.prompt_id, "production", {
        tenant_id: tenantId,
        version: version.version,
      });
      setSuccess(`${ref} is now production.`);
      await load();
    } catch (reason) {
      setError(userFacingError(reason, "Could not move the production label."));
    } finally {
      setPromoting(null);
    }
  }

  async function archiveVersion(version: PromptVersion) {
    const ref = promptRef(version);
    if (archiving) return;
    setArchiving(ref);
    setError(null);
    try {
      await platformApi.archivePromptVersion(version.prompt_id, version.version, tenantId);
      setVersionToArchive(null);
      // The pane may have been showing the version that just left.
      setOpenVersion(null);
      setSuccess(`${ref} is archived. Runs that used it still resolve it.`);
      await load();
    } catch (reason) {
      setError(userFacingError(reason, "Could not archive this version."));
    } finally {
      setArchiving(null);
    }
  }

  async function saveVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const trimmedContent = content.trim();
    if (!trimmedContent) return;

    setSaving(true);
    setFormError(null);
    try {
      await platformApi.savePrompt({
        tenant_id: tenantId,
        prompt_id: promptId,
        name: name.trim() || prompt?.name || promptId,
        content: trimmedContent,
        description: note.trim() || undefined,
      });
      setName("");
      setContent("");
      setNote("");
      setFormOpen(false);
      setEditingFrom(undefined);
      // Show what was just written, not whatever was open before.
      setOpenVersion(null);
      setSuccess(`Saved a new version of ${promptId}.`);
      await load();
    } catch (reason) {
      setFormError(userFacingError(reason, "Could not save this version."));
    } finally {
      setSaving(false);
    }
  }

  const busy = promoting !== null || archiving !== null;
  const comparedVersion = comparisonVersion ?? (!comparisonClosed && versions.some(v => v.version === requestedComparison) ? requestedComparison : null);

  return (
    <div className={PAGE_FRAME}>
      <p className="mb-4 text-sm">
        <Link href="/catalog/prompts" className="text-primary hover:underline">
          ← All prompts
        </Link>
      </p>

      <PageHeader
        section="Configure"
        title={prompt?.name ?? promptId}
        description="Every save is a new version. Production points at the one evaluations resolve by default."
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw
                className={cn("mr-2 size-4", loading && "animate-spin")}
                aria-hidden="true"
              />
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
            {canManage && prompt ? (
              <Button
                type="button"
                size="sm"
                aria-haspopup="dialog"
                aria-expanded={formOpen}
                onClick={() => {
                  setEditingFrom(undefined);
                  setContent("");
                  setNote("");
                  setFormOpen(true);
                }}
              >
                <Plus className="mr-2 size-4" aria-hidden="true" />
                New version
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-mono text-xs text-muted-foreground" translate="no">
          {promptId}
        </span>
        <ProductionBadge version={live} />
      </div>

      {success ? (
        <div
          role="status"
          className="mb-5 rounded-lg border border-state-positive/30 bg-state-positive-soft px-3 py-2.5 text-sm text-state-positive dark:border-state-positive/30 dark:bg-state-positive-soft dark:text-state-positive"
        >
          {success}
        </div>
      ) : null}
      {error ? (
        <ErrorState className="mb-5" message={error} onRetry={() => void load()} />
      ) : null}

      {comparedVersion !== null && prompt ? (
        <div className="mb-5">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">Compare versions</h2><Button variant="outline" size="sm" onClick={() => { setComparisonVersion(null); setComparisonClosed(true); }}>Close comparison</Button></div>
          <PromptComparison key={`${promptId}:${comparedVersion}`} versions={prompt.versions} initialVersion={comparedVersion} candidateVersion={versions.some(v => v.version === Number(searchParams.get("candidate"))) ? Number(searchParams.get("candidate")) : undefined} />
        </div>
      ) : null}

      {loading ? (
        <ListSkeleton label="Loading this prompt…" />
      ) : !prompt || !shown ? (
        <EmptyState
          title="No such prompt"
          description="It may have been archived, or the id in the address may be wrong."
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          <article className="panel overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
              <h2 className="flex items-center gap-2.5 text-sm font-semibold">
                <span className="tabular-nums">Version {shown.version}</span>
                {shown.archived_at ? <Chip>Archived</Chip> : null}
                {shown.labels.map((label) => (
                  <Chip key={label}>{label}</Chip>
                ))}
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                {/* Reading and reusing the text is what this page is for, so the
                    copy sits with the text — not only behind manage rights. */}
                <CopyButton value={shown.content} subject="prompt" />
                {canManage && !shown.archived_at ? (
                  <>
                  {/* A version is immutable — runs cite `prompt-id@version` for
                      provenance — so editing seeds the next version from this
                      one rather than overwriting it. */}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`Edit version ${shown.version}`}
                    onClick={() => {
                      setContent(shown.content);
                      setName(prompt.name);
                      setEditingFrom(shown.version);
                      setNote("");
                      setFormError(null);
                      setFormOpen(true);
                    }}
                  >
                    <Pencil className="mr-2 size-3.5" aria-hidden="true" />
                    Edit
                  </Button>
                  {live === shown.version ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void promote(shown)}
                    >
                      {promoting === promptRef(shown) ? "Promoting…" : "Make production"}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Archive version ${shown.version}`}
                    disabled={busy}
                    onClick={() => setVersionToArchive(shown)}
                  >
                    <Archive className="mr-2 size-4" aria-hidden="true" />
                    {archiving === promptRef(shown) ? "Archiving…" : "Archive"}
                  </Button>
                  </>
                ) : null}
              </div>
            </header>

            {shown.description?.trim() || shown.created_at ? (
              <p className="border-b bg-muted/20 px-5 py-2.5 text-xs leading-5 text-muted-foreground">
                {shown.description?.trim() ? (
                  <span className="text-foreground">{shown.description.trim()}</span>
                ) : null}
                {shown.description?.trim() && shown.created_at ? " · " : null}
                {shown.created_at ? formatDateTime(shown.created_at) : null}
                {shown.created_by ? ` · ${shown.created_by}` : null}
              </p>
            ) : null}

            {/* The prompt itself, at full size: real text a person can read,
                select and copy, rather than a clamped preview of it. */}
            {shown.content.trim() ? (
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-xs leading-6">
                {shown.content}
              </pre>
            ) : (
              <p className="px-5 py-4 text-sm text-muted-foreground">
                This version has no content.
              </p>
            )}
          </article>

          <PromptVersionRail
            versions={prompt.versions}
            openVersion={shown.version}
            productionVersion={live}
            onOpen={(version) => setOpenVersion(version.version)}
            onCompare={(version) => { setComparisonVersion(version.version); setComparisonClosed(false); }}
          />
        </div>
      )}

      {canManage && formOpen ? (
        <PromptFormDialog
          promptId={promptId}
          promptIdLocked
          basedOnVersion={editingFrom}
          name={name}
          content={content}
          saving={saving}
          error={formError}
          onPromptIdChange={() => {}}
          note={note}
          onNoteChange={setNote}
          onNameChange={setName}
          onContentChange={setContent}
          onSubmit={(event) => void saveVersion(event)}
          onClose={() => {
            setFormOpen(false);
            setEditingFrom(undefined);
          }}
        />
      ) : null}

      {versionToArchive ? (
        <OverlayConfirmDialog
          icon={Archive}
          title={`Archive ${versionToArchive.prompt_id} v${versionToArchive.version}?`}
          description="It leaves this catalog and the evaluation pickers, and any label it carries is dropped. Runs that already used it keep resolving it, so their provenance and exact reruns are unaffected. This cannot be undone from here."
          confirmLabel="Archive version"
          pendingLabel="Archiving…"
          pending={archiving === promptRef(versionToArchive)}
          onCancel={() => setVersionToArchive(null)}
          onConfirm={() => void archiveVersion(versionToArchive)}
        />
      ) : null}
    </div>
  );
}
