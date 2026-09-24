import type { RunResult } from "@/lib/api";
import { ToneBadge } from "@/components/status-badge";
import { OUTCOME_TONES, presentRunOutcome } from "@/lib/run-outcome";

/**
 * A run's outcome, in the one shape and colour that outcome always gets.
 *
 * Every list drew this itself: a gate became a badge and everything else became
 * plain grey text, so a passing run looked significant while "Inconclusive" and
 * "Partial evidence" — the runs someone actually has to deal with —
 * looked like incidental metadata. Both are badges now, and the colour comes from
 * the state rather than from whichever table is rendering it.
 */
export function RunOutcomeBadge({ run }: { run: RunResult }) {
  const outcome = presentRunOutcome(run);
  // The presented label wins, always. Handing a gate to GateBadge let it print
  // its own word instead — so "Pass · ungoverned" was computed and thrown away,
  // and the badge went back to claiming a governed verdict.
  if (outcome.gate) {
    return (
      <ToneBadge tone={OUTCOME_TONES[outcome.kind]} size="sm">
        {outcome.label}
      </ToneBadge>
    );
  }
  return <ToneBadge tone={OUTCOME_TONES[outcome.kind]}>{outcome.label}</ToneBadge>;
}
