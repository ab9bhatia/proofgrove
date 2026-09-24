import type { GateResult } from "@/lib/api";
import { ToneBadge } from "@/components/status-badge";

const GATE_LABELS: Record<GateResult, string> = { pass: "Pass", warn: "Warn", fail: "Fail" };

/**
 * A gate verdict, drawn by the one badge the app has.
 *
 * This kept its own type scale, weight and border alpha — 10px semibold on a /40
 * border against ToneBadge's 12px medium on /30 — so a gate badge and an outcome
 * badge sitting in the same row read as two different families saying two
 * different kinds of thing. The gate tones are the tone names already.
 */
export function GateBadge({ gate, size = "md" }: { gate: GateResult; size?: "sm" | "md" | "lg" }) {
  return (
    <ToneBadge tone={gate} size={size === "lg" ? "lg" : size === "sm" ? "sm" : "md"}>
      {GATE_LABELS[gate]}
    </ToneBadge>
  );
}

export function gateDescription(gate: GateResult): string {
  switch (gate) {
    case "pass":
      return "Release may proceed — all KPIs meet thresholds.";
    case "warn":
      return "Marginal score — human review required before release.";
    case "fail":
      return "Release blocked — quality or safety below acceptable threshold.";
  }
}
