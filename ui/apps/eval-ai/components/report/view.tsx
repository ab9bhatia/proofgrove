"use client";

import Link from "next/link";
import { datasetVersionLabel } from "@/lib/dataset-lineage";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitCompareArrows,
  Loader2,
  Pencil,
  RefreshCw,
} from "lucide-react";
import { Button, buttonVariants } from "@evalai/shared/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@evalai/shared/ui/sonner";
import { cn } from "@evalai/shared/utils";
import {
  api,
  evaluationApi,
  platformApi,
  type PlatformCapabilities,
  type RunItemDetail,
  type RunItemSummary,
  type RunResult,
} from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import {
  compareDisabledReasonFromRunReport,
  compareHrefFromRunReport,
} from "@/lib/comparison-href";
import { ExportMenu } from "@/components/export-menu";
import { RunItemDrawer } from "@/components/run-item-drawer";
import {
  evaluateHrefFromRun,
  formatRunScore,
  recommendationForRun,
  runLabel,
  runScenarioTypeLabel,
} from "@/lib/run-recommendation";
import { RunOutcomeBadge } from "@/components/run-outcome-badge";
import { gatedRunScore, presentCaseOutcome } from "@/lib/run-outcome";
import {
  attentionLabel,
  caseCountsFromMetrics,
  caseEvidencePresentation,
  countLabel,
  formatWhen,
  isQualityGoverned,
  isMeasurement,
  isReleaseGoverned,
  qualityOutcomes,
  runEvidenceContractPresentation,
  runEvidencePresentation,
  metricsNeedingAttention,
  scoreColor,
  scoringMethodForRun,
  judgeLabelForRun,
  summarizeMetricScores,
  type CaseScoreSummary,
} from "./lib";
import {
  FullPageQualitySection,
  QualityCount,
  QualityOutcomeBadge,
  ReleaseDecisionPanel,
  ReleaseEligibilityBanner,
  shouldOfferReleaseDecision,
} from "./governance";
import { RunOutcomeSection } from "./outcome-header";
import { EmbeddedRunDetails, RunEvidenceSection } from "./evidence";
import { scrollIntoPane } from "@/lib/scroll-into-pane";
import {
  EvaluatorOverview,
  CaseDetailsSection,
  EmbeddedMetricSummary,
  ExpectedOutputCard,
  adjacentCaseId,
  filterCases,
  type CaseFilter,
  firstCaseNeedingAttention,
} from "./case-explorer";
import type { MetricSummary } from "./lib";

// Preserve the public API of this module for existing importers.
export {
  CaseDetailsSection,
  EmbeddedMetricSummary,
  ExpectedOutputCard,
  EmbeddedRunDetails,
  caseCountsFromMetrics,
  caseEvidencePresentation,
  runEvidenceContractPresentation,
  runEvidencePresentation,
  scoringMethodForRun,
  summarizeMetricScores,
};
export type { MetricSummary };

type SectionId = "summary" | "evidence" | "details" | "recommendation" | "cases" | "metrics" | "quality";
type EmbeddedReportTab = "overview" | "cases" | "metrics" | "quality" | "details";

const EMBEDDED_REPORT_TABS: Array<{ id: EmbeddedReportTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "cases", label: "Cases" },
  { id: "metrics", label: "Metrics" },
  { id: "quality", label: "Quality" },
  { id: "details", label: "Details" },
];

const EMBEDDED_TAB_SECTIONS: Record<EmbeddedReportTab, SectionId[]> = {
  overview: ["summary", "evidence", "recommendation"],
  cases: ["cases"],
  metrics: ["metrics"],
  quality: ["quality"],
  details: ["details"],
};

const SECTIONS: Array<{ id: SectionId; title: string; description: string }> = [
  {
    id: "summary",
    title: "Summary",
    description: "Individual evaluator outcomes, pass counts, coverage, and errors.",
  },
  {
    id: "evidence",
    title: "Evaluation evidence",
    description: "Scope, verdict, capture completeness, and provenance recorded for this run.",
  },
  {
    id: "recommendation",
    title: "Recommendation",
    description: "Recommended next step based on this run's gate and root-cause evidence.",
  },
  {
    id: "quality",
    title: "Quality Outcome Report",
    description: "Comparison of case outcomes against assigned quality contracts.",
  },
  {
    id: "metrics",
    title: "Metric averages",
    description: "Per-metric average scores across evaluated cases.",
  },
  {
    id: "cases",
    title: "Case details",
    // Stated, not instructed. A failing run now opens on the case that needs
    // attention, so telling the reader to select one was telling them to do
    // what the page had already done.
    description: "Saved output and scoring evidence, case by case.",
  },
  {
    id: "details",
    title: "Run details",
    description: "Dataset, target, judge, and configuration captured for this run.",
  },
];

type SectionSummaryTone = "positive" | "attention" | "neutral";

interface SectionSummary {
  primary: string;
  status?: string;
  tone: SectionSummaryTone;
}

function SectionHeaderSummary({ summary }: { summary: SectionSummary }) {
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-3 text-xs">
      <span
        className="max-w-56 truncate font-medium text-foreground"
        title={summary.primary}
      >
        {summary.primary}
      </span>
      {summary.status ? (
        <span
          className={cn(
            "inline-flex items-center gap-1.5 whitespace-nowrap text-muted-foreground",
            summary.tone === "positive" && "text-state-positive",
            summary.tone === "attention" && "text-state-caution",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full bg-muted-foreground/60",
              summary.tone === "positive" && "bg-state-positive",
              summary.tone === "attention" && "bg-state-caution",
            )}
          />
          {summary.status}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Resolve a run-report `?item=` deep link against loaded case summaries.
 *
 * `example_id` is the only accepted identifier: every producer of `?item=`
 * emits one, and it is the run-item primary key. Ordinals are deliberately
 * NOT accepted — the "Case 01" label a reader would copy is
 * `sequence_position + 1`, so any ordinal match would silently open the
 * neighbouring case.
 */
export function resolveDeepLinkedCase(
  items: Array<Pick<RunItemSummary, "example_id">>,
  itemParam: string,
): { status: "matched"; exampleId: string } | { status: "not_found" } {
  const exact = items.find((item) => item.example_id === itemParam);
  if (exact) {
    return { status: "matched", exampleId: exact.example_id };
  }
  return { status: "not_found" };
}

/** InEval-aligned evaluation run report using eval-hub run evidence. */
export function ReportView({
  run,
  embedded = false,
  initialCaseId = null,
  initialCaseFilter = "all",
  initialOpenSections,
}: {
  run: RunResult;
  embedded?: boolean;
  initialCaseId?: string | null;
  initialCaseFilter?: CaseFilter;
  /** Optional overrides for the default collapsed/expanded section state. */
  initialOpenSections?: Partial<Record<SectionId, boolean>>;
}) {
  const router = useRouter();
  const qualityGoverned = isQualityGoverned(run);
  const releaseGoverned = isReleaseGoverned(run);
  // The release affordance requires the backend-granted capability in addition
  // to release governance; until (and unless) the capability resolves as
  // granted, the panel stays hidden entirely — never rendered-then-403.
  const [capabilities, setCapabilities] = useState<PlatformCapabilities | null>(null);
  useEffect(() => {
    if (!releaseGoverned) return;
    let cancelled = false;
    platformApi
      .capabilities()
      .then((granted) => {
        if (!cancelled) setCapabilities(granted);
      })
      .catch(() => {
        // Capability unknown → keep the affordance hidden.
      });
    return () => {
      cancelled = true;
    };
  }, [releaseGoverned]);
  // The embedded tab is mirrored to a `reportTab` search param so it deep-links,
  // matching the item/caseFilter pattern. Read it back on mount (client only).
  const [activeEmbeddedTab, setActiveEmbeddedTab] = useState<EmbeddedReportTab>(() => {
    if (!embedded || typeof window === "undefined") return "overview";
    const requested = new URLSearchParams(window.location.search).get("reportTab");
    const match = EMBEDDED_REPORT_TABS.find((tab) => tab.id === requested);
    if (!match) return "overview";
    if (match.id === "quality" && !qualityGoverned) return "overview";
    return match.id;
  });
  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>(() => {
    // A complete + conclusive run collapses its evidence to a header strip; a
    // partial or non-conclusive run keeps evidence expanded so gaps are visible.
    const evidenceSettled =
      run.evidence_capture_status === "complete" && run.verdict_status === "conclusive";
    return {
      summary: true,
      evidence: !evidenceSettled,
      recommendation: true,
      quality: true,
      metrics: false,
      cases: true,
      details: false,
      ...initialOpenSections,
    };
  });
  const [caseFilter, setCaseFilter] = useState<CaseFilter>(initialCaseFilter);
  const [items, setItems] = useState<RunItemSummary[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [itemsReloadKey, setItemsReloadKey] = useState(0);
  const [expandedCases, setExpandedCases] = useState<Set<string>>(new Set());
  const [detailsById, setDetailsById] = useState<Record<string, RunItemDetail>>({});
  const [detailLoading, setDetailLoading] = useState<Set<string>>(new Set());
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [rescoreBusy, setRescoreBusy] = useState(false);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [compareHref, setCompareHref] = useState<string | null>(null);
  const [compareDisabledReason, setCompareDisabledReason] = useState<string | null>(
    "Loading comparable runs…",
  );
  // Wires the disabled Compare CTA to its reason for assistive technology.
  const compareReasonId = `${useId()}-compare-reason`;
  const autoSelectedCase = useRef(false);
  const [attentionCaseId, setAttentionCaseId] = useState<string | null>(null);
  const loadedCases = useRef(new Set<string>());
  const inflightCases = useRef(new Set<string>());

  // The panel this header counts drops measurements into a band of their own, so
  // counting them here made the header claim "19 metrics - 18 need attention" over
  // a panel reading "14 metrics - 14 need attention". Same filter, same number.
  const metricSummaries = useMemo(
    () => summarizeMetricScores(run, 0).filter((metric) => !isMeasurement(metric.id)),
    [run],
  );
  const caseScoresById = useMemo(() => {
    const scores = new Map<string, number[]>();
    for (const result of run.metric_results || []) {
      if (result.error_message || (result.execution_status && result.execution_status !== "success")) {
        continue;
      }
      if (isMeasurement(result.metric_id) || result.normalised_score === null) continue;
      const rowScores = scores.get(result.row_id) ?? [];
      rowScores.push(result.normalised_score);
      scores.set(result.row_id, rowScores);
    }
    return Object.fromEntries(
      [...scores.entries()].map(([exampleId, values]) => [
        exampleId,
        {
          mean: values.reduce((sum, value) => sum + value, 0) / values.length,
          count: values.length,
        },
      ]),
    ) as Record<string, CaseScoreSummary>;
  }, [run.metric_results]);
  const quality = useMemo(() => qualityOutcomes(run), [run]);
  // Governance gating: the Quality Outcome section only appears when an approved
  // quality contract governs the run. A bare run_manifest_id never enables it.
  const sectionAllowed = useCallback(
    (id: SectionId) => (id === "quality" ? qualityGoverned : true),
    [qualityGoverned],
  );
  const visibleEmbeddedTabs = EMBEDDED_REPORT_TABS.filter(
    (tab) => tab.id !== "quality" || qualityGoverned,
  );
  const visibleSections = embedded
    ? SECTIONS.filter(
        (section) =>
          EMBEDDED_TAB_SECTIONS[activeEmbeddedTab].includes(section.id) &&
          sectionAllowed(section.id),
      )
    : SECTIONS.filter(
        (section) => section.id !== "recommendation" && sectionAllowed(section.id),
      );

  const evaluateHref = evaluateHrefFromRun(run);
  const typeLabel = runScenarioTypeLabel(run);
  const annotation = runLabel(run);
  const versionLabel = run.run_number != null ? `v${run.run_number}` : "—";
  const scoringMethod = scoringMethodForRun(run);
  const recordedTargetVersion =
    run.lineage?.target_version_id || run.experiment?.target_version || null;
  const recordedJudge = judgeLabelForRun(run);
  const recordedManifest =
    run.lineage?.run_manifest_id || run.experiment?.run_manifest_id || null;
  const overallScoreLabel = formatRunScore(run);
  // From the score itself, not by parsing its label back out. This tested the
  // label against "—"; once the formatter started naming the absence instead,
  // the test never matched and an unscored run produced NaN — a NaN progress
  // bar and a NaN colour, because `NaN == null` is false.
  const gatedScore = gatedRunScore(run);
  const overallPct = gatedScore == null ? null : Math.round(gatedScore * 100);

  async function handleRescore() {
    if (rescoreBusy || !run.experiment?.experiment_id) return;
    setRescoreBusy(true);
    try {
      const result = await evaluationApi.createExperimentRescore(run.experiment.experiment_id, {
        source_run_id: run.run_id,
        active_metrics: run.active_metrics || [],
        judge_model: run.experiment.judge_model || undefined,
      });
      router.push(`/runs/${encodeURIComponent(result.run_id)}`);
    } catch (reason) {
      toast.error("Unable to rescore saved evidence", {
        description: userFacingError(reason, "The source evidence could not be rescored."),
      });
      setRescoreBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    setItemsLoading(true);
    api
      .tenant()
      .then(({ tenant_id }) => evaluationApi.listRunItems(run.run_id, tenant_id))
      .then((result) => {
        if (!active) return;
        setItems(result);
        setItemsError(null);
        setExpandedCases(new Set());
        setSelectedCaseId(null);
      })
      .catch((reason) => {
        if (!active) return;
        setItems([]);
        // Rendered verbatim in the cases `role="alert"`, so it goes through the
        // same bounded contract as every other error path in this view.
        setItemsError(
          userFacingError(reason, "The cases for this run could not be loaded. Try again."),
        );
      })
      .finally(() => {
        if (active) setItemsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [itemsReloadKey, run.run_id]);

  const retryLoadCases = useCallback(() => {
    setItemsReloadKey((key) => key + 1);
  }, []);

  const loadCaseDetail = useCallback(async (exampleId: string) => {
    if (loadedCases.current.has(exampleId) || inflightCases.current.has(exampleId)) return;
    inflightCases.current.add(exampleId);
    setDetailLoading((current) => new Set(current).add(exampleId));
    try {
      const { tenant_id: tenantId } = await api.tenant();
      const detail = await evaluationApi.getRunItem(run.run_id, exampleId, tenantId);
      loadedCases.current.add(exampleId);
      setDetailsById((current) => ({ ...current, [exampleId]: detail }));
      setDetailErrors((current) => {
        const next = { ...current };
        delete next[exampleId];
        return next;
      });
    } catch (reason) {
      setDetailErrors((current) => ({
        ...current,
        [exampleId]: userFacingError(
          reason,
          "This case's saved evidence could not be loaded. Try again.",
        ),
      }));
    } finally {
      inflightCases.current.delete(exampleId);
      setDetailLoading((current) => {
        const next = new Set(current);
        next.delete(exampleId);
        return next;
      });
    }
  }, [run.run_id]);

  useEffect(() => {
    for (const exampleId of expandedCases) {
      void loadCaseDetail(exampleId);
    }
  }, [expandedCases, loadCaseDetail]);

  useEffect(() => {
    if (!initialCaseId || itemsLoading) return;
    // Load failure is surfaced via the cases section (retryable copy) — never
    // masquerade it as a missing case.
    if (itemsError) {
      setDeepLinkError(null);
      return;
    }
    const resolved = resolveDeepLinkedCase(items, initialCaseId);
    if (resolved.status === "not_found") {
      setDeepLinkError(`Case ${initialCaseId} was not found in this run.`);
      return;
    }
    const exampleId = resolved.exampleId;
    setDeepLinkError(null);
    setOpenSections((current) => ({ ...current, cases: true }));
    // Keep the deep-linked case reachable: if the requested filter hides it,
    // fall back to the unfiltered set so prev/next still works — and drop the
    // stale filter from the URL so it matches the rendered "all" view.
    if (!filterCases(items, initialCaseFilter).some((item) => item.example_id === exampleId)) {
      setCaseFilter("all");
      const url = new URL(window.location.href);
      url.searchParams.delete("caseFilter");
      window.history.replaceState(null, "", url);
    }
    setSelectedCaseId(exampleId);
    void loadCaseDetail(exampleId);
  }, [initialCaseId, initialCaseFilter, items, itemsError, itemsLoading, loadCaseDetail]);

  // Open the first case needing attention unless the URL names a case.
  useEffect(() => {
    if (initialCaseId || itemsLoading || itemsError || selectedCaseId) return;
    if (autoSelectedCase.current) return;
    // Chosen from the visible set, not from every case. Under
    // ?caseFilter=passed the attention case is hidden, so selecting it opened a
    // case the reader could not see in the list and counted its position
    // against the passed-case total.
    const target = firstCaseNeedingAttention(filterCases(items, caseFilter));
    if (!target) return;
    autoSelectedCase.current = true;
    setOpenSections((current) => ({ ...current, cases: true }));
    setAttentionCaseId(target);
    setSelectedCaseId(target);
    void loadCaseDetail(target);
  }, [caseFilter, initialCaseId, items, itemsError, itemsLoading, selectedCaseId, loadCaseDetail]);

  useEffect(() => {
    const experimentId = run.experiment?.experiment_id;
    if (!experimentId) {
      setCompareHref(null);
      setCompareDisabledReason("This run is not attached to an evaluation");
      return;
    }
    let active = true;
    void evaluationApi
      .listExperimentRuns(experimentId)
      .then((siblings) => {
        if (!active) return;
        setCompareHref(compareHrefFromRunReport(run, siblings));
        setCompareDisabledReason(compareDisabledReasonFromRunReport(run, siblings));
      })
      .catch(() => {
        if (!active) return;
        setCompareHref(null);
        setCompareDisabledReason("Could not load comparable runs for this evaluation");
      });
    return () => {
      active = false;
    };
  }, [run]);

  // Warned cases are fully scored outcomes and are counted separately;
  // "not scored" is reserved for genuinely pending/skipped/unavailable cases.
  const passRate = useMemo(() => {
    // The preference order stays here — it has one caller. The metric-derived
    // half is shared, so the experiment page cannot drift from the report on
    // what counts as a warned case.
    if (!items.length) return caseCountsFromMetrics(run);
    const outcomes = items.map((item) => presentCaseOutcome(item).kind);
    const passed = outcomes.filter((kind) => kind === "pass").length;
    const warned = outcomes.filter((kind) => kind === "warn").length;
    const failed = outcomes.filter((kind) => kind === "fail").length;
    return {
      passed,
      warned,
      failed,
      total: items.length,
      notScored: items.length - passed - warned - failed,
    };
    // `run`, not `run.metric_results`: the shared helper reads the run, and a
    // dep list narrower than what the body closes over is how a memo goes
    // stale without anyone noticing.
  }, [items, run]);
  // Same population and same definition as the panel this header summarises.
  const metricsNeedingAttentionCount = metricsNeedingAttention(metricSummaries).length;
  const allMetricsPassed =
    metricSummaries.length > 0 &&
    metricSummaries.every(
      (metric) => metric.state === "not_applicable" || (metric.state === "scored" && metric.worstGate === "pass"),
    ) &&
    metricSummaries.some((metric) => metric.state === "scored");

  function sectionSummary(id: SectionId): SectionSummary | null {
    if (id === "metrics") {
      return {
        primary: countLabel(metricSummaries.length, "metric"),
        status:
          metricsNeedingAttentionCount > 0
            ? attentionLabel(metricsNeedingAttentionCount)
            : allMetricsPassed
              ? "All passed"
              : metricSummaries.some((metric) => metric.state === "not_applicable")
                ? "No applicable results"
                : "No results",
        tone:
          metricsNeedingAttentionCount > 0
            ? "attention"
            : allMetricsPassed
              ? "positive"
              : "neutral",
      };
    }
    if (id === "cases") {
      return {
        primary: passRate ? countLabel(passRate.total, "case") : "Cases unavailable",
        status: passRate
          ? passRate.failed > 0
            ? attentionLabel(passRate.failed)
            : passRate.warned > 0
              ? `${passRate.warned} warned`
              : passRate.notScored > 0
                ? `${passRate.notScored} not fully scored`
                : "All passed"
          : itemsLoading
            ? "Loading"
            : "No results",
        tone: passRate
          ? passRate.failed > 0 || passRate.warned > 0 || passRate.notScored > 0
            ? "attention"
            : "positive"
          : "neutral",
      };
    }
    if (id === "details") {
      return {
        primary: `Dataset ${datasetVersionLabel(run.experiment?.dataset_version) || "not recorded"}`,
        tone: "neutral",
      };
    }
    if (id === "evidence") {
      const evidence = runEvidencePresentation(run);
      return {
        primary: evidence.scopeLabel,
        status: evidence.captureLabel,
        tone:
          run.evidence_capture_status === "partial" ||
          run.evidence_capture_status === "not_captured"
            ? "attention"
            : "neutral",
      };
    }
    return null;
  }

  // The case inspector paginates through the *filtered* set so prev/next never
  // jump to a case hidden by the active filter.
  const filteredItems = useMemo(() => filterCases(items, caseFilter), [items, caseFilter]);
  const selectedIndex = filteredItems.findIndex((item) => item.example_id === selectedCaseId);

  function toggleSection(id: SectionId) {
    setOpenSections((current) => ({ ...current, [id]: !current[id] }));
  }

  function toggleCase(exampleId: string) {
    setExpandedCases((current) => {
      const next = new Set(current);
      if (next.has(exampleId)) next.delete(exampleId);
      else next.add(exampleId);
      return next;
    });
  }

  function expandAllCases() {
    setExpandedCases(new Set(items.map((item) => item.example_id)));
  }

  function inspectCase(exampleId: string) {
    setSelectedCaseId(exampleId);
    const url = new URL(window.location.href);
    url.searchParams.set("item", exampleId);
    if (caseFilter === "all") url.searchParams.delete("caseFilter");
    else url.searchParams.set("caseFilter", caseFilter);
    window.history.replaceState(null, "", url);
    void loadCaseDetail(exampleId);
  }

  function changeCaseFilter(filter: CaseFilter) {
    setCaseFilter(filter);
    const url = new URL(window.location.href);
    if (filter === "all") url.searchParams.delete("caseFilter");
    else url.searchParams.set("caseFilter", filter);
    window.history.replaceState(null, "", url);
  }

  function closeCaseInspector() {
    setSelectedCaseId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("item");
    window.history.replaceState(null, "", url);
  }

  function changeEmbeddedTab(tab: EmbeddedReportTab) {
    setActiveEmbeddedTab(tab);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (tab === "overview") url.searchParams.delete("reportTab");
    else url.searchParams.set("reportTab", tab);
    window.history.replaceState(null, "", url);
  }

  function openCaseEvidence() {
    if (embedded) {
      changeEmbeddedTab("cases");
      requestAnimationFrame(() => {
        document.getElementById("embedded-report-tab-cases")?.focus();
      });
      return;
    }

    setOpenSections((current) => ({ ...current, cases: true }));
    requestAnimationFrame(() => {
      const casesTrigger = document.getElementById("report-section-trigger-cases");
      scrollIntoPane(casesTrigger, { block: "start" });
      // preventScroll: a plain focus() re-runs the ancestor-walking scroll above.
      casesTrigger?.focus({ preventScroll: true });
    });
  }

  function moveCase(direction: -1 | 1) {
    const nextId = adjacentCaseId(filteredItems, selectedCaseId, direction);
    if (nextId) inspectCase(nextId);
  }

  return (
    <div
      className="min-w-0 space-y-4"
      style={{ boxSizing: "border-box", width: "100%" }}
    >
      {!embedded ? (
        <header className="flex flex-col gap-5 rounded-xl border bg-card p-5 shadow-sm sm:p-6">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Run report
              </span>
              {/* The raw status was here, beside its own humanised twin:
                  "Completed_with_partial_evidence" next to "Completed · partial
                  evidence". `capitalize` cannot fix an underscored enum, and one
                  fact does not need two chips. */}
              {/* Route through RunOutcomeBadge, never GateBadge directly. Handing
                  the gate to GateBadge made it print its own word, so the
                  "· ungoverned" qualifier this page computes was thrown away and
                  the most prominent chip on the report claimed a governed
                  verdict the run could not support. */}
              <RunOutcomeBadge run={run} />
              {/* One fact, one chip — the rule the comment above already states.
                  `RunOutcomeBadge` prints "Diagnostic only" whenever
                  `diagnostic_only` is set, so rendering this beside it put
                  "Diagnostic only" and "Diagnostic" side by side, two names for
                  one state. It still earns its place for a run tagged
                  one-off-diagnostic without the flag, where the badge shows a
                  verdict instead and nothing else says the run is diagnostic. */}
              {run.experiment?.tags?.one_off_diagnostic === "true" && !run.diagnostic_only ? (
                <span className="rounded-full border border-state-caution/30 bg-state-caution-soft px-2.5 py-1 text-xs font-medium text-state-caution">
                  Diagnostic
                </span>
              ) : null}
            </div>
            <h1 className="text-balance break-words text-3xl font-semibold tracking-tight">
              {run.experiment?.name || "Evaluation run"}
            </h1>
            {run.experiment?.experiment_id && run.experiment?.tags?.workspace_kind === "experiment" ? (
              <p className="mt-2 text-sm">
                <Link
                  href={`/evaluations/${encodeURIComponent(run.experiment.experiment_id)}`}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Open attached experiment
                </Link>
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span>{versionLabel}</span>
              <span aria-hidden="true">·</span>
              <span>{typeLabel}</span>
              <span aria-hidden="true">·</span>
              <span>
                Scoring <span className="font-medium text-foreground">{scoringMethod.label}</span>
              </span>
              {annotation ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Label {annotation}</span>
                </>
              ) : null}
            </div>
            <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t pt-3">
              <HeaderProvenanceFact
                label="Dataset version"
                value={datasetVersionLabel(run.experiment?.dataset_version) || "Not recorded"}
              />
              {/* Target version and quality contract render only when the run
                  recorded them. Both are real, backend-written fields, but a
                  run that never bound a registered target or a manifest has
                  nothing to say — and printing "Not recorded" twice turned half
                  this strip into filler. */}
              {recordedTargetVersion ? (
                <HeaderProvenanceFact label="Target version" value={recordedTargetVersion} />
              ) : null}
              <HeaderProvenanceFact label="Judge" value={recordedJudge} />
              {recordedManifest ? (
                <HeaderProvenanceFact label="Quality contract" value="Attached" />
              ) : null}
            </dl>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 border-t pt-4">
            <div className="flex w-full flex-col gap-2 sm:contents">
            <ExportMenu run={run} scope="full" label="Export" />
            {compareHref ? (
              <Link
                href={compareHref}
                title="Compare this run with compatible completed runs"
                // `outline`, matching Export and Rescore. As a `ghost` it drew no
                // border, so the header showed three different weights for what
                // is really one primary action and three secondary ones — and
                // the borderless one read as disabled even when it wasn't.
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full sm:w-auto")}
              >
                <GitCompareArrows className="mr-1.5 size-3.5 shrink-0" aria-hidden="true" />
                Compare
              </Link>
            ) : (
              <>
                {/*
                  The reason appears on hover and on keyboard focus, and is tied
                  to the control by `aria-describedby` so assistive technology
                  announces it either way.

                  It was briefly rendered as always-visible inline text. That
                  read badly: the sentence is long enough to wrap, and it pushed
                  the action buttons onto a second row — reintroducing the exact
                  ragged layout the grouping above exists to prevent.

                  `aria-disabled` rather than `disabled` keeps the control in the
                  tab order, which is what makes the focus trigger reachable at
                  all.
                */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-disabled="true"
                  aria-describedby={compareReasonId}
                  onClick={(event) => event.preventDefault()}
                  title={compareDisabledReason ?? "Compare is unavailable"}
                  className="w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-40 lg:w-auto"
                >
                  <GitCompareArrows className="mr-1.5 size-3.5 shrink-0" aria-hidden="true" />
                  Compare
                </Button>
                <span id={compareReasonId} className="sr-only">
                  {compareDisabledReason ?? "Compare is unavailable"}
                </span>
              </>
            )}
            </div>
            <div className="flex w-full flex-col gap-2 sm:contents">
            <Link
              href={evaluateHref}
              className={cn(
                buttonVariants({ variant: "default", size: "sm" }),
                "order-first w-full sm:order-none sm:w-auto",
              )}
            >
              <Pencil className="mr-1.5 size-3.5 shrink-0" aria-hidden="true" />
              Run evaluation
            </Link>
            {run.experiment?.experiment_id ? <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void handleRescore()}
              disabled={rescoreBusy}
              className="w-full sm:w-auto"
            >
              {rescoreBusy ? (
                <Loader2 className="mr-1.5 size-3.5 shrink-0 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="mr-1.5 size-3.5 shrink-0" aria-hidden="true" />
              )}
              Rescore saved evidence
            </Button> : null}
            </div>
          </div>
            <p className="max-w-3xl text-xs leading-5 text-muted-foreground">Run evaluation invokes the target again. Rescore grades the saved response again and creates a diagnostic result; it does not create new release evidence and may not be comparable with the source run.</p>
        </header>
      ) : null}

      {/*
        Release decision renders ONLY for a release-governed run (resolved gate
        policy) whose caller holds the backend-granted record_release_decision
        capability; otherwise it stays hidden rather than rendering-then-403.
      */}
      {!embedded && releaseGoverned ? <ReleaseEligibilityBanner run={run} /> : null}
      {!embedded && shouldOfferReleaseDecision(run, capabilities) ? (
        <ReleaseDecisionPanel key={`${run.experiment?.experiment_id}:${run.run_id}`} run={run} />
      ) : null}

      {run.lineage?.source_run_id ? <p className="mb-4 rounded-lg border-l-4 border-primary bg-muted/20 p-3 text-sm text-muted-foreground">Rescore of <Link className="text-brand-text underline" href={`/runs/${encodeURIComponent(run.lineage.source_run_id)}`}>source run {run.lineage.source_run_id.slice(0, 8)}</Link>. Uses the source’s saved evidence, without a new target response or new capture. Older rescored runs may not record capture status.</p> : null}
      {deepLinkError ? (
        <div role="alert" className="rounded-lg border border-state-caution/30 bg-state-caution-soft px-4 py-3 text-sm text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution">
          {deepLinkError}
        </div>
      ) : null}

      {embedded ? (
        <Tabs
          value={activeEmbeddedTab}
          onValueChange={(value) => changeEmbeddedTab(value as EmbeddedReportTab)}
          variant="pill"
        >
          <TabsList
            aria-label="Run report sections"
            className="sticky top-0 z-10 overflow-x-auto bg-muted/70 shadow-sm backdrop-blur"
          >
            {visibleEmbeddedTabs.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                id={`embedded-report-tab-${tab.id}`}
                aria-controls="embedded-report-panel"
                className="min-w-20 flex-1 text-xs"
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      ) : null}

      <div
        id={embedded ? "embedded-report-panel" : undefined}
        role={embedded ? "tabpanel" : undefined}
        aria-labelledby={embedded ? `embedded-report-tab-${activeEmbeddedTab}` : undefined}
        className={embedded ? "space-y-3" : "space-y-4"}
      >
        {visibleSections.map((section) => {
          const open = embedded || openSections[section.id];
          const headerSummary = embedded ? null : sectionSummary(section.id);
          if (!embedded && section.id === "summary") {
            return (
              <div key={section.id} className="space-y-4">
                <section aria-label="Evaluator summary" className="rounded-xl border bg-card p-5">
                  <h2 className="mb-3 font-display text-lg font-semibold">Evaluator outcomes</h2>
                  <EvaluatorOverview run={run} totalCases={items.length} />
                </section>
                <RunOutcomeSection
                run={run}
                overallScoreLabel={overallScoreLabel}
                overallPct={overallPct}
                passRate={passRate}
                onReviewCases={openCaseEvidence}
                compareHref={compareHref}
                compareDisabledReason={compareDisabledReason}
                />
              </div>
            );
          }
          if (!embedded && section.id === "quality") {
            return (
              <FullPageQualitySection
                key={section.id}
                run={run}
                quality={quality}
                caseCount={passRate?.total ?? null}
              />
            );
          }
          return (
            <section
              key={section.id}
              className={cn(
                "overflow-hidden rounded-xl border bg-card",
                embedded ? "shadow-none" : "shadow-sm",
              )}
            >
              {embedded ? (
                <div className="px-5 py-4">
                  <h2 className="text-base font-semibold tracking-tight">{section.title}</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">{section.description}</p>
                </div>
              ) : (
                <button
                  id={`report-section-trigger-${section.id}`}
                  type="button"
                  onClick={() => toggleSection(section.id)}
                  className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-muted/30"
                  aria-expanded={open}
                  aria-controls={`report-section-${section.id}`}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <h2 className="text-base font-semibold tracking-tight">{section.title}</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">{section.description}</p>
                    </div>
                    {headerSummary ? <SectionHeaderSummary summary={headerSummary} /> : null}
                  </div>
                  {open ? (
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                </button>
              )}

            {open ? (
              <div
                id={!embedded ? `report-section-${section.id}` : undefined}
                className="border-t px-5 py-5"
              >
                {section.id === "summary" ? (
                  <EvaluatorOverview run={run} totalCases={items.length} />
                ) : null}

                {section.id === "details" ? (
                  <EmbeddedRunDetails run={run} />
                ) : null}

                {section.id === "evidence" ? (
                  <RunEvidenceSection
                    run={run}
                    caseCount={items.length}
                    casesLoading={itemsLoading}
                    casesError={itemsError}
                    onInspectCases={openCaseEvidence}
                  />
                ) : null}

                {section.id === "recommendation" ? (
                  <p className="break-words text-sm leading-6 text-muted-foreground">
                    {recommendationForRun(run)}
                  </p>
                ) : null}

                {section.id === "cases" ? (
                  <CaseDetailsSection
                    items={items}
                    loading={itemsLoading}
                    error={itemsError}
                    embedded={embedded}
                    expanded={expandedCases}
                    detailsById={detailsById}
                    detailLoading={detailLoading}
                    detailErrors={detailErrors}
                    onToggle={toggleCase}
                    onExpandAll={expandAllCases}
                    onInspect={inspectCase}
                    onRetry={retryLoadCases}
                    onRetryDetail={loadCaseDetail}
                    scoresById={caseScoresById}
                    filter={caseFilter}
                    onFilterChange={changeCaseFilter}
                    highlightId={attentionCaseId}
                  />
                ) : null}

                {section.id === "metrics" ? (
                  <EmbeddedMetricSummary
                    key={run.run_id}
                    run={run}
                    totalCases={items.length}
                    items={items}
                  />
                ) : null}

                {section.id === "quality" ? (
                  <div className="space-y-5">
                    {quality.groups.length === 0 ? (
                      <div
                        className="min-w-0 rounded-xl border border-dashed bg-muted/15 px-5 py-8 text-center"
                        style={{ boxSizing: "border-box", width: "100%" }}
                      >
                        <p className="text-sm font-semibold">
                          {qualityGoverned
                            ? "No quality controls recorded"
                            : "No quality contract attached"}
                        </p>
                        <p className="mx-auto mt-1 max-w-lg text-xs leading-5 text-muted-foreground">
                          {qualityGoverned
                            ? "This run is governed by a quality contract, but no quality-control results were recorded. Review its metric results and evidence contract."
                            : "This run can still be reviewed through its cases and metrics. Attach a quality contract to the evaluation project to assess release controls here."}
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium">Contract outcome</p>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                              {quality.groups.length} quality control
                              {quality.groups.length === 1 ? "" : "s"} evaluated across this run.
                            </p>
                          </div>
                          <ExportMenu run={run} scope="quality" label="Export" />
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-muted/10 px-4 py-4 sm:px-5">
                          <div>
                            <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                              Quality score
                            </p>
                            <p
                              className={cn(
                                "mt-1 font-mono text-xl font-semibold",
                                quality.overall == null
                                  ? undefined
                                  : scoreColor(quality.overall * 100),
                              )}
                            >
                              {quality.overall == null
                                ? "—"
                                : `${(quality.overall * 100).toFixed(1)}%`}
                            </p>
                          </div>
                          <dl className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
                            <QualityCount label="Met" value={quality.met} tone="pass" />
                            <QualityCount label="Partial" value={quality.partial} tone="warn" />
                            <QualityCount label="Not met" value={quality.notMet} tone="fail" />
                            <QualityCount label="Unavailable" value={quality.unavailable} tone="neutral" />
                          </dl>
                        </div>

                        <div className="overflow-hidden rounded-xl border bg-background">
                          {quality.groups.map((group) => {
                            const pct = group.mean === null ? null : group.mean * 100;
                            const outcomeLabel =
                              group.gate === "pass"
                                ? "Met"
                                : group.gate === "warn"
                                  ? "Partial"
                                  : group.gate === "fail"
                                    ? "Not met"
                                    : group.state === "not_applicable"
                                      ? "Not applicable"
                                      : group.state === "technical_error"
                                        ? "Technical error"
                                        : "Not scored";
                            const resultCount = group.passes + group.warns + group.fails;
                            return (
                              <details
                                key={group.metricId}
                                className="group border-b last:border-b-0"
                                open={group.gate === "pass" ? undefined : true}
                              >
                                <summary className="grid cursor-pointer list-none gap-3 px-4 py-4 outline-none transition-colors hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:px-5">
                                  <div className="min-w-0">
                                    <p className="text-sm font-semibold capitalize">{group.label}</p>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      {resultCount} case result{resultCount === 1 ? "" : "s"}
                                      {group.passes > 0 ? ` · ${group.passes} met` : ""}
                                      {group.warns > 0 ? ` · ${group.warns} partial` : ""}
                                      {group.fails > 0 ? ` · ${group.fails} not met` : ""}
                                    </p>
                                  </div>
                                  <div className="flex items-center justify-between gap-3 sm:block sm:text-right">
                                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:hidden">
                                      Average score
                                    </p>
                                    <div>
                                      <p className={cn("font-mono text-sm font-semibold", pct === null ? undefined : scoreColor(pct))}>
                                        {pct === null ? "—" : `${pct.toFixed(1)}%`}
                                      </p>
                                      <p className="hidden text-[10px] text-muted-foreground sm:block">
                                        Average score
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex items-center justify-between gap-3 sm:justify-end">
                                    <QualityOutcomeBadge gate={group.gate} label={outcomeLabel} />
                                    <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                                      Why this result
                                      <ChevronDown
                                        className="size-3.5 transition-transform group-open:rotate-180"
                                        aria-hidden="true"
                                      />
                                    </span>
                                  </div>
                                </summary>
                                <div className="border-t bg-muted/15 px-4 py-4 sm:px-5">
                                  {group.rationales.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">
                                      No scorer rationale was captured for this control.
                                    </p>
                                  ) : (
                                    <ul className="space-y-2 text-xs leading-5 text-muted-foreground">
                                      {group.rationales.map((rationale, index) => (
                                        <li key={`${group.metricId}-${index}`} className="flex gap-2">
                                          <span className="font-mono text-[10px] text-foreground" aria-hidden="true">
                                            {String(index + 1).padStart(2, "0")}
                                          </span>
                                          <span>{rationale}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              </details>
                            );
                          })}
                        </div>
                      </>
                    )}

                    <p className="text-xs text-muted-foreground">
                      Generated {formatWhen(run.completed_at || run.started_at)}
                      {passRate ? ` · ${passRate.total} cases evaluated` : ""}
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}
            </section>
          );
        })}
      </div>
      {!embedded && selectedCaseId ? (
        <RunItemDrawer
          variant="dialog"
          exampleId={selectedCaseId}
          item={detailsById[selectedCaseId] ?? null}
          loading={detailLoading.has(selectedCaseId)}
          error={detailErrors[selectedCaseId] ?? null}
          position={Math.max(selectedIndex + 1, 1)}
          total={filteredItems.length}
          kpis={run.kpi_results || []}
          projectId={run.lineage?.project_id || run.experiment?.project_id}
          evaluationScope={run.lineage?.resolved_evaluation_scope ?? run.lineage?.evaluation_scope ?? run.experiment?.evaluation_scope ?? null}
          onClose={closeCaseInspector}
          onRetry={() => void loadCaseDetail(selectedCaseId)}
          onPrevious={selectedIndex > 0 ? () => moveCase(-1) : undefined}
          onNext={
            selectedIndex >= 0 && selectedIndex < filteredItems.length - 1
              ? () => moveCase(1)
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

function HeaderProvenanceFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 max-w-56 truncate text-xs font-medium text-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}
