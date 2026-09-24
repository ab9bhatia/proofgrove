import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROUTE_TEMPLATES } from "./route-templates";

const APP_DIR = fileURLToPath(new URL("../app", import.meta.url));

function discoverRoutes(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) {
      if (entry.name === "page.tsx") found.push(prefix || "/");
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (entry.name === "api" || entry.name.startsWith("_")) continue;
    const segment =
      entry.name.startsWith("(") && entry.name.endsWith(")")
        ? ""
        : `/${entry.name}`;
    found.push(...discoverRoutes(join(dir, entry.name), prefix + segment));
  }
  return found;
}

describe("ROUTE_TEMPLATES", () => {
  it("covers every Proofgrove page", () => {
    expect(discoverRoutes(APP_DIR).sort()).toEqual([...ROUTE_TEMPLATES].sort());
  });

  it("is sorted, unique, and contains no concrete UUIDs", () => {
    expect(ROUTE_TEMPLATES).toEqual([...new Set(ROUTE_TEMPLATES)]);
    expect(ROUTE_TEMPLATES).toEqual([...ROUTE_TEMPLATES].sort());
    for (const route of ROUTE_TEMPLATES) {
      expect(route).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
    }
  });
});
