import { useId } from "react";
import Link from "next/link";
import { ChevronDown, GitCompareArrows, ListChecks, Pencil, Wrench } from "lucide-react";
import { Button, buttonVariants } from "@evalai/shared/ui/button";
import { cn } from "@evalai/shared/utils";
import { type RunResult } from "@/lib/api";
import {
  evaluateHrefFromRun,
  recommendationDetailForRun,
} from "@/lib/run-recommendation";
import { presentRunOutcome, runCoverageSummary, type PresentedRunOutcome } from "@/lib/run-outcome";
import { barColor, scoreColor, scoringMethodForRun } from "./lib";

type OutcomeAction = {
  id: "review" | "compare" | "run" | "fix" | "inspect";
  label: string;
  icon: typeof ListChecks;
  disabled?: boolean;
  title?: string;
} & ({ href: string; onSelect?: undefined } | { href?: undefined; onSelect: () => void });

/**
 * Resolve one context-sensitive primary action plus the overflow actions from
 * the presented run outcome. The mapping is intentionally narrow: the backend
 * outcome selects the single most useful next step; everything else is overflow.
 */
function outcomeActions(
  kind: PresentedRunOutcome["kind"],
  actions: Record<OutcomeAction["id"], OutcomeAction>,
): { primary: OutcomeAction | null; overflow: OutcomeAction[] } {
  switch (kind) {
    case "fail":
    case "warn":
      return { primary: actions.review, overflow: [actions.compare, actions.run] };
    case "pass":
      return { primary: actions.compare, overflow: [actions.review, actions.run] };
    case "blocked":
      return { primary: actions.fix, overflow: [actions.review] };
    case "diagnostic":
      return { primary: actions.inspect, overflow: [actions.compare, actions.run] };
    case "inconclusive":
    case "not_recorded":
    case "error":
      return { primary: actions.inspect, overflow: [actions.run] };
    case "pending":
    case "running":
    default:
      return { primary: null, overflow: [] };
  }
}

export function SummaryStat({
  label,
  value,
  detail,
  valueClassName,
  progress,
  compact = false,
}: {
  label: string;
  value: string;
  detail: string;
  valueClassName?: string;
  progress?: number | null;
  compact?: boolean;
}) {
  return (
    <div className="border-b p-4 last:border-b-0 md:border-b-0 sm:p-5">
      <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-2 font-semibold tracking-tight",
          compact ? "text-xl" : "text-3xl",
          valueClassName,
        )}
      >
        {value}
      </p>
      {progress != null ? (
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <div
            className={cn("h-full rounded-full", barColor(progress))}
            style={{ width: `${Math.min(Math.max(progress, 0), 100)}%` }}
          />
        </div>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function RunOutcomeSection({
  run,
  overallScoreLabel,
  overallPct,
  passRate,
  onReviewCases,
  compareHref = null,
  compareDisabledReason = null,
}: {
  run: RunResult;
  overallScoreLabel: string;
  overallPct: number | null;
  passRate: { passed: number; warned: number; total: number; failed: number; notScored: number } | null;
  onReviewCases?: () => void;
  /** Prefill compare deep link; null when disabled. */
  compareHref?: string | null;
  compareDisabledReason?: string | null;
}) {
  const scoringMethod = scoringMethodForRun(run);
  const outcome = presentRunOutcome(run);
  const recommendation = recommendationDetailForRun(run);
  const headline = recommendation.message.split("\n")[0];
  // Never claim "Passed all checks" while a failure or a warning is visible in
  // the cases below. A run can pass its release gate while cases fail a
  // non-gating check — the gate and the cases are different questions, and the
  // headline printed "Passed all checks" in green directly above
  // "0/10 passed · 10 failed" in red.
  const outcomeTitle = runOutcomeTitle({
    kind: outcome.kind,
    passRate,
    label: outcome.label,
    governed: outcome.governed,
  });
  // A 8px dot is a mark, not a surface: the -soft tokens are the pale washes
  // banners sit on, so a passing run drew #ecfdf5 on a white card — no dot at
  // all — while a failing one stayed vivid.
  const outcomeDotClass =
    outcome.kind === "pass"
      ? "bg-gate-pass"
      : outcome.kind === "warn"
        ? "bg-gate-warn"
        : outcome.kind === "fail"
          ? "bg-gate-fail"
          : "bg-muted-foreground";

  const reviewCases: OutcomeAction = {
    id: "review",
    label: "Review cases",
    icon: ListChecks,
    onSelect: onReviewCases ?? (() => {}),
  };
  const inspect: OutcomeAction = {
    id: "inspect",
    label: "Inspect evidence",
    icon: ListChecks,
    onSelect: onReviewCases ?? (() => {}),
  };
  const compareAction: OutcomeAction = compareHref
    ? { id: "compare", label: "Compare", icon: GitCompareArrows, href: compareHref }
    : {
        id: "compare",
        label: "Compare",
        icon: GitCompareArrows,
        onSelect: () => undefined,
        disabled: true,
        title: compareDisabledReason ?? "Compare is unavailable for this run",
      };
  const actions: Record<OutcomeAction["id"], OutcomeAction> = {
    review: reviewCases,
    inspect,
    compare: compareAction,
    run: { id: "run", label: "Run evaluation", icon: Pencil, href: evaluateHrefFromRun(run) },
    fix: { id: "fix", label: "Fix prerequisite", icon: Wrench, href: evaluateHrefFromRun(run) },
  };
  const { primary, overflow } = outcomeActions(outcome.kind, actions);

  return (
    <section
      aria-labelledby="run-outcome-title"
      className="overflow-hidden rounded-xl border bg-card shadow-sm"
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", outcomeDotClass)} aria-hidden="true" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Run outcome
          </p>
        </div>
        <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 id="run-outcome-title" className="text-2xl font-semibold tracking-tight">
              {outcomeTitle}
            </h2>
            <p className="mt-1.5 w-full break-words text-sm leading-6 text-muted-foreground">
              {headline}
            </p>
          </div>
          {primary ? (
            <div className="flex shrink-0 items-center gap-2">
              <PrimaryOutcomeAction action={primary} />
              {overflow.length > 0 ? <OutcomeOverflow actions={overflow} /> : null}
            </div>
          ) : null}
        </div>

        {recommendation.steps.length > 0 ? (
          <details className="group mt-4 rounded-lg border bg-muted/15">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              What to do next
              <ChevronDown
                className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <div className="border-t px-4 py-3">
              <ol className="ml-4 list-decimal space-y-1.5 text-xs leading-5 text-muted-foreground">
                {recommendation.steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
              {recommendation.example ? (
                <p className="mt-3 border-t pt-3 text-xs leading-5 text-muted-foreground">
                  {recommendation.example}
                </p>
              ) : null}
            </div>
          </details>
        ) : null}

        <dl className="mt-5 grid gap-4 border-t pt-5 sm:grid-cols-3 sm:gap-0 sm:divide-x">
          <OutcomeFact
            label={outcome.scoreLabel === "—" && outcome.observedScoreLabel !== "—" ? "Observed KPI composite" : "KPI composite"}
            value={outcome.scoreLabel === "—" ? outcome.observedScoreLabel : overallScoreLabel}
            valueClassName={overallPct == null ? undefined : scoreColor(overallPct)}
            detail={[
              outcome.scoreLabel === "—" && outcome.observedScoreLabel !== "—"
                ? `${outcome.observedScoreLabel} · not gated`
                : "Mean of configured KPI composites; not every evaluator",
              // The denominator excludes unscored checks. Say so when it bites,
              // otherwise 94% over half the checks reads like 94% over all.
              runCoverageSummary(run),
            ]
              .filter(Boolean)
              .join(" · ")}
          />
          <OutcomeFact
            label="Case outcome"
            value={passRate ? `${passRate.passed}/${passRate.total} passed` : "Unavailable"}
            valueClassName={
              passRate
                ? passRate.failed === 0 && passRate.warned === 0 && passRate.notScored === 0
                  ? "text-gate-pass"
                  : passRate.failed > 0
                    ? "text-destructive"
                    : undefined
                : undefined
            }
            detail={
              passRate
                ? `${passRate.failed} failed${passRate.warned > 0 ? ` · ${passRate.warned} warned` : ""} · ${passRate.notScored} not scored`
                : "Case results unavailable"
            }
          />
          <OutcomeFact
            label="Evaluation method"
            value={scoringMethod.label}
            detail={scoringMethod.detail}
          />
        </dl>
      </div>
    </section>
  );
}

function PrimaryOutcomeAction({ action }: { action: OutcomeAction }) {
  const reasonId = `${useId()}-${action.id}-reason`;
  const Icon = action.icon;
  const content = (
    <>
      <Icon className="mr-1.5 size-3.5 shrink-0" aria-hidden="true" />
      {action.label}
    </>
  );
  if (action.disabled) {
    // `aria-disabled` rather than `disabled`: a disabled control leaves the tab
    // order and its `title` is never announced, so the reason would reach a
    // mouse pointer only.
    return (
      <>
        <Button
          type="button"
          size="sm"
          aria-disabled="true"
          aria-describedby={action.title ? reasonId : undefined}
          onClick={(event) => event.preventDefault()}
          title={action.title}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
        >
          {content}
        </Button>
        {action.title ? (
          <span id={reasonId} className="sr-only">
            {action.title}
          </span>
        ) : null}
      </>
    );
  }
  if (action.href) {
    return (
      <Link href={action.href} className={cn(buttonVariants({ size: "sm" }))} title={action.title}>
        {content}
      </Link>
    );
  }
  return (
    <Button type="button" size="sm" onClick={action.onSelect} title={action.title}>
      {content}
    </Button>
  );
}

function OutcomeOverflow({ actions }: { actions: OutcomeAction[] }) {
  const overflowBaseId = useId();
  return (
    <details className="group relative">
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-lg border px-2.5 text-xs font-medium outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring">
        More
        <ChevronDown
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-lg border bg-background p-1 shadow-md">
        {actions.map((action) => {
          const Icon = action.icon;
          const className =
            "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
          if (action.disabled) {
            const reasonId = `${overflowBaseId}-${action.id}-reason`;
            return (
              <div key={action.id}>
                <button
                  type="button"
                  aria-disabled="true"
                  aria-describedby={action.title ? reasonId : undefined}
                  onClick={(event) => event.preventDefault()}
                  title={action.title}
                  className={cn(
                    className,
                    "aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
                  )}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                  {action.label}
                </button>
                {action.title ? (
                  <span id={reasonId} className="sr-only">
                    {action.title}
                  </span>
                ) : null}
              </div>
            );
          }
          return action.href ? (
            <Link key={action.id} href={action.href} className={className} title={action.title}>
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
              {action.label}
            </Link>
          ) : (
            <button
              key={action.id}
              type="button"
              onClick={action.onSelect}
              className={className}
              title={action.title}
            >
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
              {action.label}
            </button>
          );
        })}
      </div>
    </details>
  );
}

function OutcomeFact({
  label,
  value,
  detail,
  valueClassName,
}: {
  label: string;
  value: string;
  detail: string;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0 sm:px-5 sm:first:pl-0 sm:last:pr-0">
      <dt className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd className={cn("mt-1.5 text-lg font-semibold tracking-tight", valueClassName)}>
        {value}
      </dd>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

/**
 * What the run report says happened, in one line.
 *
 * A verdict must not outrun what was actually judged. The gate answers "may this
 * release"; the cases answer "did anything go wrong" — and a gate can pass on a
 * KPI while no case was scored at all. This printed "Passed all checks" in green
 * directly above "0/2 passed · 2 not scored", and before that above
 * "0/10 passed · 10 failed". Failures, warnings and unscored cases are three ways
 * the claim can be false; all three are named.
 */
export function runOutcomeTitle({
  kind,
  passRate,
  label = "",
  governed = true,
}: {
  kind: string;
  passRate: { passed: number; warned: number; failed: number; notScored: number; total: number } | null;
  label?: string;
  /**
   * Whether a quality contract stands behind the gate.
   *
   * This function composes its own headline rather than rendering `label`, so
   * the "· ungoverned" qualifier `presentRunOutcome` computes was being
   * discarded here exactly as it was in the header badge — "Passed all checks",
   * in green, above a run nothing governed. Defaults true so an omitted argument
   * cannot silently add the qualifier to a genuinely governed run.
   */
  governed?: boolean;
}): string {
  const ungoverned = governed ? "" : " · ungoverned";
  if (kind !== "pass") {
    if (kind === "warn") return `Review required${ungoverned}`;
    if (kind === "fail") return `Action required${ungoverned}`;
    return label;
  }
  const failed = passRate?.failed ?? 0;
  const warned = passRate?.warned ?? 0;
  const unscored = passRate?.notScored ?? 0;
  const scored = (passRate?.total ?? 0) - unscored;
  if (failed > 0) return `Gate passed${ungoverned} · ${failed} case${failed === 1 ? "" : "s"} failed a check`;
  if (warned > 0) return `Passed with ${warned} warning${warned === 1 ? "" : "s"}${ungoverned}`;
  if (unscored > 0) {
    return scored === 0
      ? `Gate passed${ungoverned} · no case was scored`
      : `Gate passed${ungoverned} · ${unscored} case${unscored === 1 ? "" : "s"} not scored`;
  }
  return governed ? "Passed all checks" : "Passed all checks · ungoverned";
}
