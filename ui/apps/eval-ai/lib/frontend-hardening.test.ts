import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOTS = [join(APP_ROOT, "app"), join(APP_ROOT, "components")];

function tsxSources(root: string): Array<{ path: string; source: string }> {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return tsxSources(path);
    if (!entry.isFile() || !entry.name.endsWith(".tsx")) return [];
    return [{ path, source: readFileSync(path, "utf8") }];
  });
}

const sources = SOURCE_ROOTS.flatMap(tsxSources);

function matches(pattern: RegExp): string[] {
  return sources
    .filter(({ source }) => pattern.test(source))
    .map(({ path }) => path.slice(APP_ROOT.length + 1));
}

describe("frontend hardening invariants", () => {
  it("does not use blocking browser alerts for recoverable workflow errors", () => {
    expect(matches(/window\.alert\s*\(/)).toEqual([]);
  });

  it("does not render links through the unsupported Button asChild prop", () => {
    expect(matches(/<Button\b[^>]*\basChild\b[^>]*>/)).toEqual([]);
  });

  it("avoids forced autofocus and broad transition-all animations", () => {
    expect(matches(/\bautoFocus\b/)).toEqual([]);
    expect(matches(/\btransition-all\b/)).toEqual([]);
  });
});
