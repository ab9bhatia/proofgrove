import { describe, expect, it } from "vitest";

import { filterAndSortCatalogue, matchesCatalogueQuery } from "./governance-catalogue";

describe("governance catalogue helpers", () => {
  it("matches any of the searchable fields", () => {
    expect(matchesCatalogueQuery("claims", "Claims release", "claims-release")).toBe(true);
    expect(matchesCatalogueQuery("release", "Claims quality", "profile-a")).toBe(false);
    expect(matchesCatalogueQuery("  ", "anything")).toBe(true);
  });

  it("filters then sorts by name", () => {
    const rows = [
      { name: "Zebra", id: "z", created_at: "2026-09-01T00:00:00Z" },
      { name: "Alpha", id: "a", created_at: "2026-09-02T00:00:00Z" },
      { name: "Beta claims", id: "b", created_at: "2026-09-03T00:00:00Z" },
    ];
    expect(
      filterAndSortCatalogue(rows, {
        query: "a",
        sort: "name_asc",
        fields: (item) => [item.name, item.id],
      }).map((item) => item.name),
    ).toEqual(["Alpha", "Beta claims", "Zebra"]);
  });

  it("sorts newest first by created_at", () => {
    const rows = [
      { name: "Older", created_at: "2026-01-01T00:00:00Z" },
      { name: "Newer", created_at: "2026-09-01T00:00:00Z" },
    ];
    expect(
      filterAndSortCatalogue(rows, {
        query: "",
        sort: "newest",
        fields: (item) => [item.name],
      }).map((item) => item.name),
    ).toEqual(["Newer", "Older"]);
  });
});
