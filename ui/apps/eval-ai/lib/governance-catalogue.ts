/** Client-side catalogue helpers for Evaluation governance lists. */

export type CatalogueSort = "newest" | "oldest" | "name_asc" | "name_desc";

export type CatalogueItem = {
  name: string;
  created_at?: string | null;
};

export function matchesCatalogueQuery(
  query: string,
  ...fields: Array<string | null | undefined>
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => (field || "").toLowerCase().includes(needle));
}

export function sortCatalogueItems<T extends CatalogueItem>(
  items: readonly T[],
  sort: CatalogueSort,
): T[] {
  const copy = [...items];
  copy.sort((left, right) => {
    if (sort === "name_asc" || sort === "name_desc") {
      const cmp = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
      return sort === "name_asc" ? cmp : -cmp;
    }
    const leftTime = Date.parse(left.created_at || "") || 0;
    const rightTime = Date.parse(right.created_at || "") || 0;
    return sort === "newest" ? rightTime - leftTime : leftTime - rightTime;
  });
  return copy;
}

export function filterAndSortCatalogue<T extends CatalogueItem>(
  items: readonly T[],
  options: {
    query: string;
    sort: CatalogueSort;
    fields: (item: T) => Array<string | null | undefined>;
  },
): T[] {
  const filtered = items.filter((item) => matchesCatalogueQuery(options.query, ...options.fields(item)));
  return sortCatalogueItems(filtered, options.sort);
}
