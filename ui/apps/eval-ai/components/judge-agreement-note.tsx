"use client";

// How far to trust this metric's scores: how often reviewers agreed with the
// judge. Counts only, never a reviewer or a rationale.

import type { JudgeAgreement } from "@/lib/api";

/** Plain-language agreement for one metric.
 *
 *  Two things this deliberately does NOT do.
 *
 *  It is not a percentage. Two reviewed cases expressed as "50%" reads like a
 *  measurement; "2 of 3" reads like what it is. A percentage can come later,
 *  when volume makes one honest.
 *
 *  It is never silent. The counts come from `judge_agreement_by_metric`, which
 *  spans every run in the tenant — so an absent number means "nobody has
 *  reviewed this metric", not "this run has no reviews" and not "the judge is
 *  fine". Rendering nothing let a reader supply whichever of those they
 *  already believed. Hence the leading scope and the explicit empty state. */
export function JudgeAgreementNote({
  entry,
  unavailable = false,
}: {
  entry: JudgeAgreement | undefined;
  unavailable?: boolean;
}) {
  // A failed fetch is not an absence of reviews. Both arrive here as an
  // undefined entry, and only one of them is a fact about review history —
  // so the caller has to tell them apart for us.
  if (unavailable) {
    return (
      <p className="text-[11px] leading-4 text-muted-foreground">Agreement unavailable</p>
    );
  }

  const agreed = entry?.agreed ?? 0;
  const reviewed = entry?.reviewed ?? 0;
  const ambiguous = entry?.ambiguous ?? 0;

  return (
    // Not muted like the provenance line above it. How far to trust this score
    // is the finding; the scorer and version are the footnote. Styled the same,
    // the two read as one undifferentiated block of grey metadata.
    <p className="text-[11px] leading-4 text-muted-foreground">
      {reviewed > 0 ? (
        <>
          Across all runs, reviewers agreed with{" "}
          <span className="font-semibold text-foreground">
            {agreed} of {reviewed}
          </span>{" "}
          cases they reviewed
        </>
      ) : (
        "Across all runs, nobody has reviewed this metric yet"
      )}
      {ambiguous > 0 ? (
        <>
          {" · "}
          {ambiguous} case{ambiguous === 1 ? "" : "s"} not counted, because the finding covered more
          than one metric
        </>
      ) : null}
    </p>
  );
}
