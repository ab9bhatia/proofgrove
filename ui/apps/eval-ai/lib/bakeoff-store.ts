import type { BakeoffTarget } from "@/lib/bakeoff";

/**
 * Bakeoff launches outlive the tab that started them.
 *
 * Runs are enqueued immediately but cannot be grouped into a workspace until
 * they complete, which can take minutes. `sessionStorage` — where live run ids
 * are kept (`lib/live-runs.ts`) — dies with the tab and prunes terminal ids
 * exactly when grouping needs them, so a bakeoff keeps its own record here.
 */
const STORAGE_KEY = "evalhub:bakeoff-launches";

/** Enough to cover a few forgotten tabs without growing without bound. */
const MAX_REMEMBERED_LAUNCHES = 5;

export interface BakeoffLaunch {
  launchId: string;
  tenantId: string;
  datasetName: string;
  evaluationName?: string;
  targets: BakeoffTarget[];
  /**
   * Set as soon as grouping succeeds, and then KEPT. Its presence is what stops
   * a second pass creating a duplicate — `from-runs` always mints a fresh
   * workspace — and it is also how the launch screen learns where to send the
   * user. Deleting the record on success breaks both.
   */
  workspaceId: string | null;
  /** When grouping succeeded. Retention is measured from here, not creation. */
  groupedAt?: string;
  /** Failed grouping attempts, so a launch that can never group is abandoned. */
  attempts?: number;
  groupingFailed?: boolean;
  createdAt: string;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Private modes and blocked third-party storage both throw on access.
    return null;
  }
}

export function readLaunches(): BakeoffLaunch[] {
  const store = storage();
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is BakeoffLaunch =>
        Boolean(entry) &&
        typeof (entry as BakeoffLaunch).launchId === "string" &&
        Array.isArray((entry as BakeoffLaunch).targets),
    );
  } catch {
    return [];
  }
}

/** A grouped launch is kept only long enough for its own screen to read it. */
const GROUPED_RETENTION_MS = 60 * 60 * 1000;

function writeLaunches(launches: BakeoffLaunch[], now = Date.now()) {
  const store = storage();
  if (!store) return;
  const live = launches.filter((launch) => {
    if (!launch.workspaceId) return true;
    // Measured from when grouping happened, never from creation: a bakeoff that
    // ran longer than the retention window would otherwise be pruned by the
    // very write that records its workspace, losing the user their link to it.
    const age = now - new Date(launch.groupedAt ?? launch.createdAt).getTime();
    return Number.isNaN(age) || age < GROUPED_RETENTION_MS;
  });
  // Evict grouped records before ungrouped ones: an ungrouped launch still owes
  // the user a workspace, and dropping it silently strands its finished runs.
  const ordered = [
    ...live.filter((launch) => !launch.workspaceId),
    ...live.filter((launch) => launch.workspaceId),
  ];
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(ordered.slice(0, MAX_REMEMBERED_LAUNCHES)));
  } catch {
    // Keep the live launch usable when browser storage is full or unavailable.
  }
}

export function rememberLaunch(launch: BakeoffLaunch) {
  const rest = readLaunches().filter((entry) => entry.launchId !== launch.launchId);
  writeLaunches([launch, ...rest]);
}

export function updateLaunch(launchId: string, patch: Partial<BakeoffLaunch>) {
  writeLaunches(
    readLaunches().map((entry) =>
      entry.launchId === launchId ? { ...entry, ...patch } : entry,
    ),
  );
}

export function forgetLaunch(launchId: string) {
  writeLaunches(readLaunches().filter((entry) => entry.launchId !== launchId));
}
