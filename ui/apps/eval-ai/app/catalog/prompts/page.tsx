"use client";

import { TablePagination } from "@/components/table-pagination";
import { PAGE_FRAME } from "@/lib/page-frame";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ROWS_PER_PAGE } from "@/lib/pagination";
import { Plus, RefreshCw } from "lucide-react";

import { Button } from "@evalai/shared/ui/button";
import { cn } from "@evalai/shared/utils";

import { EvalHubGate } from "@/components/eval-hub-gate";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/page-state";
import { PromptFormDialog } from "@/components/catalog/prompt-form-dialog";
import { PromptIndexList } from "@/components/catalog/prompt-index-list";
import {
  api,
  platformApi,
  type PlatformCapabilities,
  type PromptVersion,
} from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import { groupPromptVersions, promptIdProblem } from "@/lib/prompts";
import { CatalogToolbar, SearchField } from "@/components/toolbar";
import { Chip } from "@/components/status-badge";

/** Cursor batches match the visible table page size. */
const PROMPT_PAGE_SIZE = ROWS_PER_PAGE;

export default function PromptCatalogPage() {
  return (
    <EvalHubGate>
      <PromptCatalog />
    </EvalHubGate>
  );
}

function PromptCatalog() {
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [totalPromptCount, setTotalPromptCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped by every fresh load. A "Load more" already in flight when Refresh
  // lands would otherwise append its stale page on top of the refreshed list and
  // overwrite the new cursor — duplicating a prompt, or skipping a page.
  const loadGeneration = useRef(0);
  const [tenantId, setTenantId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [success, setSuccess] = useState<string | null>(null);
  // Saving needs the approver role. Offer it to nobody the endpoint would
  // refuse — a 403 after the click is a worse answer.
  const [canManage, setCanManage] = useState(false);
  // Kept apart from `error`: a rejected save is a problem with the form, not a
  // page that failed to load, and belongs beside the fields it is about.
  const [formError, setFormError] = useState<string | null>(null);

  const [promptId, setPromptId] = useState("");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const generation = (loadGeneration.current += 1);
    setLoading(true);
    setError(null);
    try {
      const [tenant, page, capabilities] = await Promise.all([
        api.tenant(),
        platformApi.listPromptPage(PROMPT_PAGE_SIZE),
        // A capability lookup that fails should not take the catalog down with
        // it: fall back to read-only rather than showing nothing at all.
        platformApi.capabilities().catch(
          (): PlatformCapabilities => ({ actions: {} }),
        ),
      ]);
      if (generation !== loadGeneration.current) return;
      setTenantId(tenant.tenant_id);
      setVersions(page.items);
      setCurrentPage(1);
      setTotalPromptCount(page.total);
      setNextCursor(page.next_cursor);
      setCanManage(capabilities.actions?.manage_prompts === true);
    } catch (reason) {
      setError(userFacingError(reason, "Could not load prompts."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const prompts = useMemo(
    () => {
      // Keep the server cursor order as batches arrive; locale sorting can move
      // newly fetched IDs ahead of prompts the user has already paged through.
      const order = new Map([...new Set(versions.map((version) => version.prompt_id))].map((id, index) => [id, index]));
      return groupPromptVersions(versions, query).sort((a, b) => order.get(a.promptId)! - order.get(b.promptId)!);
    },
    [versions, query],
  );
  const loadedPrompts = useMemo(
    () => new Set(versions.map((version) => version.prompt_id)).size,
    [versions],
  );

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const generation = loadGeneration.current;
    setLoadingMore(true);
    try {
      const page = await platformApi.listPromptPage(PROMPT_PAGE_SIZE, nextCursor);
      // A Refresh that landed while this was in flight owns the list now.
      if (generation !== loadGeneration.current) return;
      // Append: a page holds whole prompts, so nothing here can split one.
      setVersions((current) => [...current, ...page.items]);
      setTotalPromptCount(page.total);
      setNextCursor(page.next_cursor);
      return true;
    } catch (reason) {
      if (generation === loadGeneration.current) {
        setError(userFacingError(reason, "Could not load more prompts."));
      }
    } finally {
      setLoadingMore(false);
    }
  }

  const pageNumber = Math.min(currentPage, Math.max(1, Math.ceil(prompts.length / ROWS_PER_PAGE)));
  async function changePage(next: number) {
    if (next > Math.ceil(prompts.length / ROWS_PER_PAGE) && nextCursor) {
      if (!await loadMore()) return;
      // Fill the current search page before moving past newly loaded matches.
      if (prompts.length % ROWS_PER_PAGE !== 0 || prompts.length === 0) return;
    }
    setCurrentPage(next);
  }

  async function savePrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const trimmedId = promptId.trim();
    const trimmedContent = content.trim();
    if (!trimmedId || !trimmedContent) return;

    const idProblem = promptIdProblem(trimmedId);
    if (idProblem) {
      setFormError(idProblem);
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      await platformApi.savePrompt({
        tenant_id: tenantId,
        prompt_id: trimmedId,
        name: name.trim() || trimmedId,
        content: trimmedContent,
        // Empty stays empty: a blank note is no note, not a note saying nothing.
        description: note.trim() || undefined,
      });
      setPromptId("");
      setName("");
      setContent("");
      setNote("");
      setFormOpen(false);
      setSuccess(`Saved ${trimmedId}.`);
      await load();
    } catch (reason) {
      setFormError(userFacingError(reason, "Could not save this prompt."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={PAGE_FRAME}>
      <PageHeader
        section="Configure"
        title="Prompts"
        description="System prompts saved for reuse. Every save is a new version, and production points at the one in use."
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
            {canManage ? (
              <Button
                type="button"
                size="sm"
                aria-haspopup="dialog"
                aria-expanded={formOpen}
                onClick={() => setFormOpen(true)}
              >
                <Plus className="mr-2 size-4" aria-hidden="true" />
                New prompt
              </Button>
            ) : null}
          </>
        }
      />

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

      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold tracking-tight">Prompt library</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Open a prompt to read it in full, review its versions, and choose which
              one production points at.
            </p>
          </div>
          {!loading ? (
            <Chip size="md">
              {prompts.length} of {totalPromptCount}{" "}
              {totalPromptCount === 1 ? "prompt" : "prompts"}
            </Chip>
          ) : null}
        </div>

        {loading ? (
          <ListSkeleton label="Loading prompts…" />
        ) : versions.length === 0 ? (
          <EmptyState
            title="No saved prompts"
            description={
              canManage
                ? "Save a prompt to reuse it across evaluations and compare versions against each other."
                : "Prompts saved by an approver appear here, ready to reference from an evaluation."
            }
          />
        ) : (
          <>
              <PromptIndexList
                prompts={prompts.slice((pageNumber - 1) * ROWS_PER_PAGE, pageNumber * ROWS_PER_PAGE)}
                footer={<><TablePagination total={query.trim() ? prompts.length : totalPromptCount} page={pageNumber} onPageChange={(page) => void changePage(page)} label="prompts" busy={loadingMore} hasMore={Boolean(nextCursor)} />{nextCursor && query.trim() ? <p className="border-t px-5 py-2 text-xs text-muted-foreground">Searching {loadedPrompts} loaded of {totalPromptCount} prompts. Next searches the next batch.</p> : null}</>}
                toolbar={
                  // In the list card, at the shared height — it was a bare
                  // full-width 60px field floating above the panel.
                  <CatalogToolbar>
                    <SearchField
                      name="prompt-search"
                      value={query}
                      onChange={(event) => { setQuery(event.target.value); setCurrentPage(1); }}
                      placeholder="Search prompts…"
                      label="Search prompts"
                    />
                  </CatalogToolbar>
                }
              />
            {prompts.length === 0 ? (
              <EmptyState title="No prompts match this search" description={nextCursor ? "Only the prompts loaded so far have been searched." : "Change or clear your search to see saved prompts."} />
            ) : null}

          </>
        )}
      </section>

      {canManage && formOpen ? (
        <PromptFormDialog
          promptId={promptId}
          name={name}
          content={content}
          saving={saving}
          error={formError}
          onPromptIdChange={(value) => {
            setPromptId(value);
            setFormError(null);
          }}
          note={note}
          onNoteChange={setNote}
          onNameChange={setName}
          onContentChange={setContent}
          onSubmit={(event) => void savePrompt(event)}
          onClose={() => setFormOpen(false)}
        />
      ) : null}
    </div>
  );
}
