import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GateResult } from "@/lib/api";
import { GateBadge, gateDescription } from "./gate-badge";

const GATES: GateResult[] = ["pass", "warn", "fail"];

describe("GateBadge", () => {
  it("renders each gate with its design-system token utilities", () => {
    const expected: Record<GateResult, string[]> = {
      // Same border alpha as every other outcome badge: the gate badge used /40
      // against ToneBadge's /30, which is what made them read as two families.
      pass: ["bg-gate-pass-soft", "text-gate-pass", "border-gate-pass/30"],
      warn: ["bg-gate-warn-soft", "text-gate-warn", "border-gate-warn/30"],
      fail: ["bg-gate-fail-soft", "text-gate-fail", "border-gate-fail/30"],
    };
    for (const gate of GATES) {
      const html = renderToStaticMarkup(createElement(GateBadge, { gate }));
      for (const cls of expected[gate]) expect(html).toContain(cls);
      expect(html).toContain(gate.charAt(0).toUpperCase() + gate.slice(1));
      // A pill, the brand's radius for tags and badges — 8px is the control
      // radius, and a badge wearing it looked like the button beside it.
      expect(html).toContain("rounded-full");
      expect(html).not.toContain("font-mono");
    }
  });

  it("carries no hardcoded palette classes — the gate tokens are the single source of truth", () => {
    for (const gate of GATES) {
      const html = renderToStaticMarkup(createElement(GateBadge, { gate }));
      expect(html).not.toMatch(/emerald|amber|red-\d|#[0-9a-fA-F]{3,8}/);
    }
  });

  it("describes every gate outcome", () => {
    for (const gate of GATES) {
      expect(gateDescription(gate)).toBeTruthy();
    }
  });
});
