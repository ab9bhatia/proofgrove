import { fullName, type DatasetInfo } from "@/lib/api";

/**
 * Client-side dataset search over the loaded page.
 *
 * Shared with the page shell so the "N of M datasets" caption counts the rows
 * the library actually renders. Counting the raw page instead made the caption
 * contradict the library's own "Showing 1–20 of 100" as soon as a query was
 * typed.
 */
export function filterDatasetsByQuery(datasets: DatasetInfo[], query: string): DatasetInfo[] {
  const search = query.trim().toLowerCase();
  if (!search) return datasets;
  return datasets.filter((ds) => {
    const haystack = [
      fullName(ds),
      ds.dataset_id,
      ds.product_id,
      ds.status,
      ds.created_by,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(search);
  });
}
