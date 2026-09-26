import { fullName, type DatasetInfo } from "@/lib/api";

export type DatasetLineageGroup = {
  /** Stable key for the lineage (root dataset name). */
  rootName: string;
  /** Highest-version dataset shown as the landing row. */
  latest: DatasetInfo;
  /** Older versions, newest first (excludes latest). */
  previous: DatasetInfo[];
};

function parentOf(ds: DatasetInfo): string | null {
  return ds.parent_dataset_name?.trim() || null;
}

/** Resolve the root name for a dataset by walking parent links when present. */
export function lineageRootName(ds: DatasetInfo, byName: Map<string, DatasetInfo>): string {
  const self = fullName(ds);
  let current = self;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) break;
    seen.add(current);
    const node = byName.get(current);
    const parent = node ? parentOf(node) : null;
    if (!parent || !byName.has(parent)) break;
    current = parent;
  }
  // Prefer stripping _vN suffix when no parent chain exists.
  if (current === self) {
    const match = self.match(/^(.*)_v\d+$/);
    if (match?.[1]) return match[1];
  }
  return current;
}

/** Group datasets so each lineage shows latest first, with previous versions nested. */
export function groupDatasetsByLineage(datasets: DatasetInfo[]): DatasetLineageGroup[] {
  const byName = new Map<string, DatasetInfo>();
  for (const ds of datasets) {
    const name = fullName(ds);
    if (name) byName.set(name, ds);
  }

  const groups = new Map<string, DatasetInfo[]>();
  for (const ds of datasets) {
    const root = lineageRootName(ds, byName);
    const list = groups.get(root) ?? [];
    list.push(ds);
    groups.set(root, list);
  }

  const result: DatasetLineageGroup[] = [];
  for (const [rootName, members] of groups) {
    const sorted = [...members].sort((a, b) => {
      const versionDiff = (b.version_number || 0) - (a.version_number || 0);
      if (versionDiff !== 0) return versionDiff;
      return fullName(a).localeCompare(fullName(b));
    });
    const [latest, ...previous] = sorted;
    if (!latest) continue;
    result.push({ rootName, latest, previous });
  }

  return result.sort((a, b) => fullName(a.latest).localeCompare(fullName(b.latest)));
}

/**
 * Provenance category for the Source column.
 *
 * `created_by` is a raw pipeline name (`playwright`, `proofgrove-generator`, …),
 * not vocabulary a reader should have to decode. Every recognised value maps
 * to one of a small set of categories; anything unrecognised still gets a
 * readable label instead of leaking the raw string.
 */
export function datasetSourceLabel(ds: DatasetInfo): string {
  if (ds.change_reason === "content_update") return "Version";
  const by = (ds.created_by || "").toLowerCase();
  if (by.includes("generator") || by.includes("generate")) return "Generate";
  if (by.includes("playwright")) return "Runtime verification";
  if (by.includes("upload") || by.includes("import") || by.includes("ui")) return "Import";
  // Anything unrecognised is still a provenance answer, not a pipeline name.
  // Title-casing the raw creator leaked "Codex E2e" and "Codex Runtime Verific…"
  // into a column whose other values are categories.
  return "Registry";
}

/**
 * The version number embedded in a dataset's own name (`support_v3` → `3`),
 * or null when the name carries no such suffix. 14 of 117 names end this way,
 * and 2 disagree with the live `version_number` — a stale name, not a live fact.
 */
export function nameVersionSuffix(name: string): number | null {
  const match = name.match(/^.*_v(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * A stored `dataset_version` as it should read.
 *
 * The backend used to stamp `name.vN` onto a dataset that was already *named*
 * with its version, giving "…_v11.v11". That is fixed at the source, but every
 * run, experiment and report recorded before the fix still carries the doubled
 * string, and those records are immutable. Collapse it on the way out.
 *
 * Only an exact repeat is collapsed: "legacy_v5.v7" is two real facts — forked
 * from v5, now on v7 — and is left alone.
 */
export function datasetVersionLabel(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "";
  return text.replace(/([._])v(\d+)\.v\2$/i, "$1v$2");
}
