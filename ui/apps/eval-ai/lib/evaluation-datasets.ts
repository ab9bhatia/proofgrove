import { fullName, type DatasetInfo } from "@/lib/api";

/** Keep only the highest version_number per dataset lineage. */
export function latestPublishedDatasets(datasets: DatasetInfo[]): DatasetInfo[] {
  const byName = new Map(datasets.map((dataset) => [fullName(dataset), dataset]));

  function lineageKey(dataset: DatasetInfo): string {
    let current = dataset;
    const seen = new Set<string>();
    while (current.parent_dataset_name && !seen.has(fullName(current))) {
      seen.add(fullName(current));
      const parent = byName.get(current.parent_dataset_name);
      if (!parent) return current.parent_dataset_name;
      current = parent;
    }
    return fullName(current);
  }

  const best = new Map<string, DatasetInfo>();
  for (const dataset of datasets) {
    if (dataset.status !== "PUBLISHED") continue;
    const key = lineageKey(dataset);
    const previous = best.get(key);
    if (!previous || dataset.version_number > previous.version_number) {
      best.set(key, dataset);
    }
  }
  return [...best.values()].sort((left, right) =>
    fullName(left).localeCompare(fullName(right)),
  );
}
