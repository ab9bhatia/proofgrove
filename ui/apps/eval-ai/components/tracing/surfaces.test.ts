import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The trace inspector has exactly two card surfaces: the span tree pane and the
 * span detail pane. Everything else groups with rules and space.
 *
 * It drifted the other way once already. The trace summary was a bordered card
 * containing a bordered, tinted metadata band; the span tree's filters were a
 * second bordered, tinted block inside the tree card; and the detail pane held
 * payload blocks that repainted the surface underneath them. Four levels of
 * nesting, every one of them a 1px border on a muted wash, so nothing read as
 * hierarchy and the screen read as scattered.
 *
 * These assertions are on source rather than rendered output because the rule
 * is about which components are allowed to declare a surface at all.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, name), "utf8");

describe("trace inspector surfaces", () => {
  it("leaves the panes as the only cards", () => {
    const inspector = read("trace-inspector.tsx");
    // Span tree, span detail and the annotation summary each keep their
    // border; nothing else in the composition adds one. The trace summary
    // above them is a header strip, and the bands inside them group with
    // rules and space.
    const borders = inspector.match(/rounded-xl border/g) ?? [];
    expect(borders).toHaveLength(3);
  });

  it("keeps the trace summary a header strip", () => {
    const summary = read("trace-summary.tsx");
    // A rule separates it from the panes below. A border would box it.
    expect(summary).toContain("border-b");
    expect(summary).not.toMatch(/rounded-(lg|xl) border/);
  });

  it("keeps fact bands off any surface of their own", () => {
    const facts = read("trace-facts.tsx");
    // MetadataBand sits inside the summary and inside the detail pane. Either
    // way its parent has already declared the surface.
    expect(facts).not.toContain("bg-muted");
    expect(facts).not.toMatch(/rounded-(lg|md|xl) border/);
  });

  it("keeps the span tree free of its own filtering controls", () => {
    const tree = read("span-tree-pane.tsx");
    expect(tree).not.toContain("bg-muted/20");
    // The tree used to carry a search box and three filters in a bordered,
    // tinted block — a card inside the tree card, and a second filtering
    // vocabulary over a list the reader can already see in full.
    expect(tree).not.toContain('from "@/components/toolbar"');
    expect(tree).not.toContain("<select");
    expect(tree).not.toContain('type="search"');
  });

  it("stops detail blocks repainting the surface they sit on", () => {
    const detail = read("span-detail-pane.tsx");
    // Payload, content and event blocks keep a hairline boundary, but a tint on
    // top of the pane's own tint is what made them read as cards in a card.
    expect(detail).not.toContain("bg-muted/10");
    // Token and cost are facts about the span, not a third coloured surface.
    expect(detail).not.toContain("bg-purple-500/5");
  });
});

describe("results grouping surfaces", () => {
  it("keeps tables free of nested card surfaces when grouping is enabled", () => {
    for (const table of ["trace-table.tsx", "span-table.tsx"]) {
      expect(read(table), `${table} declares a nested card surface`).not.toContain("panel");
    }
  });

  it("separates rows from each other as well as from the page", () => {
    for (const table of ["trace-table.tsx", "span-table.tsx"]) {
      expect(read(table), table).toContain("even:bg-muted/20");
    }
  });
});

describe("selected annotations placement", () => {
  it("gets its own pane beside the tree and the detail", () => {
    const inspector = read("trace-inspector.tsx");
    // Annotations follow selection in a peer pane.
    expect(inspector).toContain('aria-label="Annotation summary"');
    expect(inspector).toContain("SelectedAnnotationSummary");
    // Three columns when annotations can be loaded.
    // Deferred to xl: at lg the drawer (capped below the viewport) squeezes
    // the detail pane under 200px if a third column claims space that early.
    expect(inspector).toMatch(/xl:grid-cols-\[[^\]]*_[^\]]*_[^\]]*\]/);
  });

  it("is not a band under the detail pane, nor a tab inside it", () => {
    const inspector = read("trace-inspector.tsx");
    // Both were tried and both were wrong: pinned underneath it was the last
    // thing on a long scroll, and as a tab it hid behind the span's own
    // Info / Attributes / Events.
    expect(inspector).not.toContain("border-t p-4");
    expect(inspector).not.toContain("TabsTrigger");
    expect(read("span-detail-pane.tsx")).not.toContain("CaseAnnotationSummary");
  });
});

describe("trace inspector file sizes", () => {
  it("keeps each pane small enough to hold in one head", () => {
    // The split exists because this was one 1135-line file with twenty nested
    // component functions, which is where edits started going wrong.
    for (const name of [
      "trace-inspector.tsx",
      "trace-summary.tsx",
      "trace-facts.tsx",
      "span-tree-pane.tsx",
      "span-detail-pane.tsx",
    ]) {
      expect(read(name).split("\n").length, `${name} is growing back`).toBeLessThan(520);
    }
  });
});
