const STORAGE_KEY = "evalhub:run-form-memory";
const DRAFT_STORAGE_KEY = "evalhub:run-form-drafts";
const TENANT_KEY = "evalhub:run-form-tenant";

/**
 * Version of the persisted payload shape. Bump it whenever the stored shape
 * changes; payloads from any other version are dropped whole rather than
 * half-restored into the form.
 */
export const RUN_FORM_SCHEMA_VERSION = 2;

/** Drafts untouched for longer than this are stale and dropped on read. */
export const RUN_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type RunFormKind = "agent" | "rag" | "llm" | "provided";

/** Snapshot of the evaluation form used to start a run. */
export type RunFormSnapshot = {
  kind: RunFormKind;
  evaluationName?: string | null;
  label?: string | null;
  /** Every label on the run. `label` remains the first one, for drafts written
   *  before labels became a list. */
  labels?: string[] | null;
  datasetName?: string | null;
  agentId?: string | null;
  endpoint?: string | null;
  targetModel?: string | null;
  selectedLlmId?: string | null;
  judgeModel?: string | null;
  enableJudge?: boolean;
  humanReview?: boolean;
  parallelRequests?: number;
  selectedMetrics?: string[];
  selectedContracts?: string[];
  applyContracts?: boolean;
  systemPrompt?: string | null;
  systemPromptRef?: string | null;
  /** null = whole tool layer; array = the exact named-tool selection. */
  selectedToolIds?: string[] | null;
  /** User-requested evaluation depth. Backend readiness remains authority on availability. */
  evaluationScope?: "final_response" | "tool_interactions" | "full_execution";
  projectId?: string | null;
};

export type RunFormDraft = RunFormSnapshot & { updatedAt: string };

type MemoryMap = Record<string, RunFormSnapshot>;
type DraftMap = Partial<Record<RunFormKind, RunFormDraft>>;

/** Envelope around every persisted payload: schema version + owning tenant. */
type Envelope<T> = { version: number; tenant: string | null; data: T };

function storageArea(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function boundTenant(): string | null {
  const storage = storageArea();
  if (!storage) return null;
  try {
    return storage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}

/**
 * Scope run-form storage to the active tenant. Binding a different tenant than
 * the one previously bound clears all remembered forms and drafts so state can
 * never leak across tenants; re-binding the same tenant is a no-op.
 */
export function bindRunFormTenant(tenantId: string) {
  const storage = storageArea();
  if (!storage) return;
  const tenant = tenantId.trim();
  if (!tenant) return;
  try {
    const previous = storage.getItem(TENANT_KEY);
    if (previous && previous !== tenant) {
      storage.removeItem(STORAGE_KEY);
      storage.removeItem(DRAFT_STORAGE_KEY);
    }
    storage.setItem(TENANT_KEY, tenant);
  } catch {
    // Storage unavailable; nothing persisted, nothing to isolate.
  }
}

function readStore<T extends object>(key: string): T | null {
  const storage = storageArea();
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Envelope<T>> | null;
    if (!parsed || typeof parsed !== "object" || parsed.version !== RUN_FORM_SCHEMA_VERSION) {
      // Legacy or future payload shape: drop it whole instead of half-restoring.
      storage.removeItem(key);
      return null;
    }
    const tenant = boundTenant();
    if (parsed.tenant != null && tenant != null && parsed.tenant !== tenant) {
      // Stamped for another tenant: never seed this tenant's form with it.
      storage.removeItem(key);
      return null;
    }
    return parsed.data && typeof parsed.data === "object" ? (parsed.data as T) : null;
  } catch {
    return null;
  }
}

function writeStore<T>(key: string, data: T) {
  const storage = storageArea();
  if (!storage) return;
  const envelope: Envelope<T> = {
    version: RUN_FORM_SCHEMA_VERSION,
    tenant: boundTenant(),
    data,
  };
  try {
    storage.setItem(key, JSON.stringify(envelope));
  } catch {
    // Quota exceeded or storage unavailable; remembering forms is best-effort.
  }
}

function readMemory(): MemoryMap {
  return readStore<MemoryMap>(STORAGE_KEY) ?? {};
}

function writeMemory(map: MemoryMap) {
  const entries = Object.entries(map).slice(0, 40);
  writeStore(STORAGE_KEY, Object.fromEntries(entries));
}

/** Persist the form used to enqueue ``runId`` so Run history / Rerun can recover it. */
export function rememberRunForm(runId: string, snapshot: RunFormSnapshot) {
  if (!runId) return;
  const next = readMemory();
  next[runId] = {
    ...snapshot,
    label: snapshot.label?.trim() || null,
  };
  writeMemory(next);
}

export function recallRunForm(runId: string): RunFormSnapshot | null {
  if (!runId) return null;
  return readMemory()[runId] ?? null;
}

export function recallRunLabel(runId: string): string {
  const label = recallRunForm(runId)?.label?.trim();
  return label || "";
}

function isFreshDraft(draft: RunFormDraft, now: number): boolean {
  const savedAt = Date.parse(draft.updatedAt ?? "");
  return Number.isFinite(savedAt) && now - savedAt <= RUN_DRAFT_MAX_AGE_MS;
}

function readDrafts(): DraftMap {
  const all = readStore<DraftMap>(DRAFT_STORAGE_KEY) ?? {};
  const now = Date.now();
  const fresh: DraftMap = {};
  for (const [kind, draft] of Object.entries(all) as [RunFormKind, RunFormDraft | undefined][]) {
    if (draft && isFreshDraft(draft, now)) fresh[kind] = draft;
  }
  return fresh;
}

export function rememberRunDraft(kind: RunFormKind, snapshot: RunFormSnapshot) {
  const drafts = readDrafts();
  drafts[kind] = { ...snapshot, kind, updatedAt: new Date().toISOString() };
  writeStore(DRAFT_STORAGE_KEY, drafts);
}

export function recallRunDraft(kind: RunFormKind): RunFormDraft | null {
  return readDrafts()[kind] ?? null;
}

export function forgetRunDraft(kind: RunFormKind) {
  const drafts = readDrafts();
  delete drafts[kind];
  writeStore(DRAFT_STORAGE_KEY, drafts);
}
