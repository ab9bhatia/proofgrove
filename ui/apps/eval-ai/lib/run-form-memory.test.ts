import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RUN_DRAFT_MAX_AGE_MS,
  RUN_FORM_SCHEMA_VERSION,
  bindRunFormTenant,
  forgetRunDraft,
  recallRunDraft,
  recallRunForm,
  rememberRunDraft,
  rememberRunForm,
  type RunFormSnapshot,
} from "./run-form-memory";

const DRAFT_STORAGE_KEY = "evalhub:run-form-drafts";
const RUN_STORAGE_KEY = "evalhub:run-form-memory";

// The module reads window.sessionStorage; the vitest node environment has no DOM, so provide a
// minimal in-memory Storage shim for these tests.
function installSessionStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  };
  (globalThis as unknown as { window: unknown }).window = { sessionStorage: storage };
  return storage;
}

let storage: ReturnType<typeof installSessionStorage>;

beforeEach(() => {
  storage = installSessionStorage();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("run form draft memory", () => {
  it("persists a new-run draft without an evaluation scope", () => {
    const snapshot: RunFormSnapshot = {
      kind: "agent",
      evaluationName: "Fraud gate",
      datasetName: "fraud.v3",
      selectedMetrics: ["llm.correctness"],
    };

    rememberRunDraft("agent", snapshot);

    const recalled = recallRunDraft("agent");
    expect(recalled?.datasetName).toBe("fraud.v3");
    // The evaluation form no longer records a scope on drafts.
    expect(recalled?.evaluationScope).toBeUndefined();
  });

  it("clears a stale legacy scope once the scope-free form re-saves the draft", () => {
    // Simulate a draft written by an older build that still recorded a scope.
    rememberRunDraft("agent", { kind: "agent", datasetName: "d", evaluationScope: "tool_interactions" });
    expect(recallRunDraft("agent")?.evaluationScope).toBe("tool_interactions");

    // The current form persists a draft with no scope; the stale value cannot survive to seed a new run.
    rememberRunDraft("agent", { kind: "agent", datasetName: "d" });
    expect(recallRunDraft("agent")?.evaluationScope).toBeUndefined();
  });

  it("forgets a draft on demand", () => {
    rememberRunDraft("llm", { kind: "llm", datasetName: "d" });
    expect(recallRunDraft("llm")).not.toBeNull();
    forgetRunDraft("llm");
    expect(recallRunDraft("llm")).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("clears drafts and run memory when a different tenant binds", () => {
    bindRunFormTenant("tenant-a");
    rememberRunDraft("agent", { kind: "agent", datasetName: "fraud.v3" });
    rememberRunForm("run-1", { kind: "agent", datasetName: "fraud.v3", label: "baseline" });
    expect(recallRunDraft("agent")).not.toBeNull();
    expect(recallRunForm("run-1")).not.toBeNull();

    bindRunFormTenant("tenant-b");

    expect(recallRunDraft("agent")).toBeNull();
    expect(recallRunForm("run-1")).toBeNull();
  });

  it("keeps state when the same tenant re-binds", () => {
    bindRunFormTenant("tenant-a");
    rememberRunDraft("agent", { kind: "agent", datasetName: "fraud.v3" });
    bindRunFormTenant("tenant-a");
    expect(recallRunDraft("agent")?.datasetName).toBe("fraud.v3");
  });

  it("refuses a payload stamped for another tenant even without a rebind", () => {
    // A payload restored from another tenant's session must never seed this tenant's form.
    storage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        version: RUN_FORM_SCHEMA_VERSION,
        tenant: "tenant-x",
        data: { agent: { kind: "agent", datasetName: "secret", updatedAt: new Date().toISOString() } },
      }),
    );
    bindRunFormTenant("tenant-a");
    expect(recallRunDraft("agent")).toBeNull();
  });
});

describe("stale-draft expiry", () => {
  it("drops a draft older than the max age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    rememberRunDraft("agent", { kind: "agent", datasetName: "fraud.v3" });

    vi.setSystemTime(new Date("2026-08-01T12:00:00Z").getTime() + RUN_DRAFT_MAX_AGE_MS + 1);
    expect(recallRunDraft("agent")).toBeNull();
  });

  it("keeps a draft younger than the max age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    rememberRunDraft("agent", { kind: "agent", datasetName: "fraud.v3" });

    vi.setSystemTime(new Date("2026-08-01T12:00:00Z").getTime() + RUN_DRAFT_MAX_AGE_MS - 1000);
    expect(recallRunDraft("agent")?.datasetName).toBe("fraud.v3");
  });

  it("drops a draft whose timestamp is unreadable", () => {
    storage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        version: RUN_FORM_SCHEMA_VERSION,
        tenant: null,
        data: { agent: { kind: "agent", datasetName: "d", updatedAt: "not-a-date" } },
      }),
    );
    expect(recallRunDraft("agent")).toBeNull();
  });
});

describe("schema versioning", () => {
  it("drops a legacy unversioned draft payload instead of half-restoring it", () => {
    // Shape written by builds that predate the envelope: a bare kind → draft map.
    storage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ agent: { kind: "agent", datasetName: "d", updatedAt: new Date().toISOString() } }),
    );
    expect(recallRunDraft("agent")).toBeNull();
    // The stale payload is purged, not left behind to confuse a later read.
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("drops a legacy unversioned run-memory payload", () => {
    storage.setItem(
      RUN_STORAGE_KEY,
      JSON.stringify({ "run-1": { kind: "agent", datasetName: "d" } }),
    );
    expect(recallRunForm("run-1")).toBeNull();
    expect(storage.getItem(RUN_STORAGE_KEY)).toBeNull();
  });

  it("stays on the version whose drafts are still readable", () => {
    // Bumping the version discards every in-flight draft on deploy, so it may
    // only move when the persisted shape genuinely changes incompatibly.
    expect(RUN_FORM_SCHEMA_VERSION).toBe(2);
  });

  it("drops payloads written by a different schema version", () => {
    storage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        version: RUN_FORM_SCHEMA_VERSION + 1,
        tenant: null,
        data: { agent: { kind: "agent", datasetName: "d", updatedAt: new Date().toISOString() } },
      }),
    );
    expect(recallRunDraft("agent")).toBeNull();
  });
});
