import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { DatasetInfo } from "@/lib/api";
import type { DatasetLineageGroup } from "@/lib/dataset-lineage";

// DatasetLibrary owns its own URL state (useSearchParams/useRouter/usePathname),
// like ExperimentsLibrary — these static renders run without a mounted router.
vi.mock("next/navigation", () => ({
  usePathname: () => "/datasets",
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

import { DatasetLibrary, readLibraryState, sortDatasetGroups, writeLibrarySearchParams } from "./dataset-library";

function ds(overrides: Partial<DatasetInfo> = {}): DatasetInfo {
  return {
    dataset_id: "dataset-1",
    name: "support-quality",
    tenant_id: "tenant-classroom",
    product_id: "customer-support",
    status: "DRAFT",
    version_number: 1,
    parent_dataset_name: null,
    dqs: null,
    change_reason: null,
    created_by: "eval-hub-ui",
    record_count: 12,
    updated_at: "2026-08-20T12:00:00Z",
    ...overrides,
  };
}

describe("DatasetLibrary markup", () => {
  it("uses six columns, with no separate Actions column", () => {
    const html = renderToStaticMarkup(createElement(DatasetLibrary, { datasets: [ds()], loading: false }));

    expect(html).toContain('role="list"');
    expect(html).toContain('role="listitem"');
    expect(html).toContain(">Dataset<");
    expect(html).toContain(">Source<");
    expect(html).toContain(">Cases<");
    expect(html).toContain(">Updated<");
    // Status is a column again: as a chip beside the name it competed with the
    // dataset's own name for the eye, and left the row's columns unbalanced.
    expect(html).toContain(">Status<");
    expect(html).not.toContain(">Product<");
    expect(html).toContain('placeholder="Search datasets…"');
    // No bulk selection: the checkboxes had no batch action to call.
    expect(html).not.toContain('type="checkbox"');
  });

  it("names the row by what it is: name, status chip, then version metadata", () => {
    const html = renderToStaticMarkup(createElement(DatasetLibrary, { datasets: [ds()], loading: false }));

    expect(html).toContain("support-quality");
    // Title case from this commit on: the badge renders the status as a word,
    // not as the enum key. "DRAFT" survives only as a style-map key.
    expect(html).toContain("Draft");
    expect(html).toContain("v1 latest");
    // A single-version dataset has nothing to link to a history tab for.
    expect(html).not.toContain("versions</a>");
    expect(html).not.toContain("dataset-1");
  });

  it("maps a raw created_by into a provenance category, never the raw pipeline name", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetLibrary, {
        datasets: [ds({ created_by: "playwright" }), ds({ dataset_id: "d2", name: "b", created_by: "system" })],
        loading: false,
      }),
    );

    expect(html).toContain("Runtime verification");
    expect(html).not.toContain(">playwright<");
    // Unrecognised creators land on a category, not a title-cased pipeline name.
    expect(html).toContain("Registry");
  });

  it("row is the link, and the overflow menu is always visible beside it", () => {
    const html = renderToStaticMarkup(createElement(DatasetLibrary, { datasets: [ds()], loading: false }));

    expect(html).toContain('href="/datasets/support-quality"');
    expect(html).toContain('aria-label="Open support-quality"');
    expect(html).toContain('aria-label="More actions for support-quality"');
    // Always visible: export and delete live behind this menu, and a control you
    // have to discover by hovering is a control most people never find.
    expect(html).not.toContain("opacity-0");
    expect(html).not.toContain(">Open<");
  });

  it("keeps the canonical name used by detail links and explains the historical suffix", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetLibrary, {
        datasets: [ds({ name: "legacy_dataset_v5", version_number: 7 })],
        loading: false,
      }),
    );

    expect(html).toContain("legacy_dataset");
    expect(html).toContain(">legacy_dataset_v5<");
    expect(html).toContain('aria-label="Open legacy_dataset_v5"');
    expect(html).toContain("forked from v5");
    expect(html).toContain("v7 latest");
    expect(html).toContain('title="Named &quot;legacy_dataset_v5&quot;');
  });

  it("does not claim a fork when the name's _vN agrees with the live version", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetLibrary, {
        datasets: [ds({ name: "clean_dataset_v3", version_number: 3 })],
        loading: false,
      }),
    );

    expect(html).not.toContain("forked from");
  });

  it("shows one lifecycle count split, active vs retired, from the whole loaded library", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetLibrary, {
        datasets: [
          ds({ dataset_id: "d1", name: "alpha", status: "PUBLISHED" }),
          ds({ dataset_id: "d2", name: "beta", status: "DRAFT" }),
          ds({ dataset_id: "d3", name: "gamma", status: "RETIRED" }),
        ],
        loading: false,
      }),
    );

    expect(html).toContain("Active (2)");
    expect(html).toContain("Retired (1)");
  });

  it("counts lineages, the unit the table renders, not versions", () => {
    // Three versions of one dataset are one row. Counting raw rows made the
    // strip say "Active (3)" over a table of 1, contradicting its own footer.
    const html = renderToStaticMarkup(
      createElement(DatasetLibrary, {
        datasets: [
          ds({ dataset_id: "v1", name: "support-quality", version_number: 1, status: "PUBLISHED" }),
          ds({ dataset_id: "v2", name: "support-quality_v2", version_number: 2, status: "PUBLISHED" }),
          ds({ dataset_id: "v3", name: "support-quality_v3", version_number: 3, status: "PUBLISHED" }),
        ],
        loading: false,
      }),
    );

    expect(html).toContain("Active (1)");
    expect(html).not.toContain("Active (3)");
  });

  it("counts a mixed lineage in one bucket, matching the rows it renders", () => {
    // One lineage whose older version is retired is still one active row. The
    // strip has to agree with the table under it, whichever tab is showing.
    const html = renderToStaticMarkup(
      createElement(DatasetLibrary, {
        datasets: [
          ds({ dataset_id: "v2", name: "support-quality_v2", version_number: 2, status: "PUBLISHED" }),
          ds({ dataset_id: "v1", name: "support-quality", version_number: 1, status: "RETIRED" }),
          ds({ dataset_id: "old", name: "legacy-set", version_number: 1, status: "RETIRED" }),
        ],
        loading: false,
      }),
    );

    expect(html).toContain("Active (1)");
    expect(html).toContain("Retired (2)");
  });

  it("shows an empty state with no results", () => {
    const html = renderToStaticMarkup(createElement(DatasetLibrary, { datasets: [], loading: false }));

    expect(html).toContain("No active datasets");
  });

  it("shows the loading skeleton", () => {
    const html = renderToStaticMarkup(createElement(DatasetLibrary, { datasets: [], loading: true }));

    expect(html).toContain("Loading datasets…");
  });
});

describe("DatasetLibrary paging", () => {
  const many = Array.from({ length: 45 }, (_, i) => ds({ dataset_id: `dataset-${i}`, name: `dataset-${i}` }));

  it("paginates the client-side, filtered result set at 20 rows", () => {
    const html = renderToStaticMarkup(createElement(DatasetLibrary, { datasets: many, loading: false }));

    expect(html).toContain("Showing");
    expect(html).toContain("of");
    expect(html).toContain("<span");
    expect(html).toContain("Page 1 of 3");
    expect(html).toContain('aria-label="active datasets pagination"');
  });
});

describe("dataset library URL state", () => {
  it("round-trips query, status, product, sort and page", () => {
    const written = writeLibrarySearchParams("", {
      query: "support",
      status: "PUBLISHED",
      product: "customer-support",
      sortKey: "cases",
      sortDir: "asc",
      page: 3,
    });

    expect(readLibraryState(new URLSearchParams(written))).toEqual({
      query: "support",
      status: "PUBLISHED",
      product: "customer-support",
      sortKey: "cases",
      sortDir: "asc",
      page: 3,
    });
  });

  it("defaults to updated/desc/page 1 and rejects an unknown status", () => {
    expect(readLibraryState(new URLSearchParams("status=not-a-status"))).toEqual({
      query: "",
      status: "",
      product: "",
      sortKey: "updated",
      sortDir: "desc",
      page: 1,
    });
  });

  it("omits default values from the written query string", () => {
    expect(
      writeLibrarySearchParams("", {
        query: "",
        status: "",
        product: "",
        sortKey: "updated",
        sortDir: "desc",
        page: 1,
      }),
    ).toBe("");
  });
});

describe("sortDatasetGroups", () => {
  function group(name: string, overrides: Partial<DatasetInfo>): DatasetLineageGroup {
    return { rootName: name, latest: ds({ dataset_id: name, name, ...overrides }), previous: [] };
  }

  it("sorts by cases, nulls last regardless of direction", () => {
    const groups = [group("a", { record_count: 5 }), group("b", { record_count: undefined }), group("c", { record_count: 20 })];

    expect(sortDatasetGroups(groups, "cases", "desc").map((g) => g.rootName)).toEqual(["c", "a", "b"]);
    expect(sortDatasetGroups(groups, "cases", "asc").map((g) => g.rootName)).toEqual(["a", "c", "b"]);
  });

  it("sorts by updated_at, most recent first by default", () => {
    const groups = [
      group("old", { updated_at: "2026-01-01T00:00:00Z" }),
      group("new", { updated_at: "2026-08-01T00:00:00Z" }),
      group("unknown", { updated_at: null }),
    ];

    expect(sortDatasetGroups(groups, "updated", "desc").map((g) => g.rootName)).toEqual(["new", "old", "unknown"]);
  });
});

describe("the header row lines up with the cells beneath it", () => {
  it("right-aligns both trailing headers, matching their cells", () => {
    const html = renderToStaticMarkup(createElement(DatasetLibrary, { datasets: [ds()], loading: false }));

    // Cases is a number (right), Updated is a date (left). A header aligned the
    // other way to its own column reads as a misaligned table.
    const before = (marker: string) => {
      const at = html.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      return html.slice(Math.max(0, at - 400), at);
    };
    expect(before('aria-label="Sort by cases')).toContain("justify-end");
    expect(before('aria-label="Sort by updated')).toContain("justify-end");
  });

  it("states the result count once, in the footer", () => {
    const html = renderToStaticMarkup(createElement(DatasetLibrary, { datasets: [ds()], loading: false }));

    expect(html).toContain("Showing");
    // The toolbar carried a second, differently-worded copy of the same number.
    expect(html.match(/of <!-- -->1<!-- -->|of 1/g)?.length ?? 0).toBeLessThan(2);
  });
});

describe("older versions stay reachable", () => {
  it("lists each older version, not a link to an event log", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetLibrary, {
        datasets: [ds({ name: "support-quality", version_number: 3 }), ds({ dataset_id: "d2", name: "support-quality_v2", version_number: 2 })],
        loading: false,
      }),
    );

    // The rebuild pointed "N versions" at ?tab=history, which shows version events
    // — you could no longer open or export an older version from the library.
    expect(html).not.toContain("tab=history");
    expect(html).toContain("versions");
  });
});
