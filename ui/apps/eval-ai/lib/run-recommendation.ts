import type { RunResult } from "@/lib/api";
import { isQualityGoverned, isReleaseGoverned } from "@/components/report/lib";
import { recallRunForm, recallRunLabel } from "@/lib/run-form-memory";
import { gatedRunScore, presentRunOutcome } from "@/lib/run-outcome";

/** Short recommendation derived from gate + root-cause remediation. */
export function recommendationForRun(run: RunResult): string {
  return recommendationDetailForRun(run).message;
}

export type RecommendationDetail = {
  /** Full recommendation narrative (may exceed 500 characters). */
  message: string;
  /** Numbered remediation steps for the UI. */
  steps: string[];
  /** Concrete example that illustrates the recommended action. */
  example: string;
};

/** Structured recommendation with steps and a supporting example. */
export function recommendationDetailForRun(run: RunResult): RecommendationDetail {
  const outcome = presentRunOutcome(run);
  const remediation = run.root_cause?.recommended_remediation?.trim();
  const failing = run.root_cause?.failing_metrics ?? [];
  const chain = run.root_cause?.causal_chain?.filter(Boolean) ?? [];
  const rootLabel = run.root_cause?.root_cause_label ?? failing[0] ?? null;
  const scenario = scenarioTypeLabel(run.experiment?.scenario, run.run_type);

  // A completed pass is authoritative. Some historical runs retain stale
  // root-cause details from an earlier attempt; those details must not turn a
  // passing outcome into a failure recommendation.
  if (outcome.kind === "fail" && (remediation || failing.length > 0 || chain.length > 0)) {
    const headline =
      remediation ||
      (rootLabel
        ? `Investigate failing metric: ${rootLabel}.`
        : "Review failing evaluation evidence before promoting.");
    const steps = [
      ...(chain.length
        ? chain.slice(0, 4)
        : [
            `Open the Case Details section and filter to rows that failed ${rootLabel || "the gate"}.`,
            "Compare actual vs expected outputs and tool calls for those cases.",
            "Adjust prompts, tools, or retrieval and re-run the same evaluation name as a labeled candidate.",
          ]),
      "Re-run the evaluation and confirm the overall gate returns to Pass before release.",
    ];
    const example = sampleExampleForFailure({
      scenario,
      rootLabel,
      failing,
    });
    return {
      message: [headline, "", "Recommended steps:", ...steps.map((step, i) => `${i + 1}. ${step}`)].join(
        "\n",
      ),
      steps,
      example,
    };
  }

  switch (outcome.kind) {
    case "pass": {
      // Three governance tiers, most-authoritative first:
      //  1. release-governed (gate policy) → may claim promotion.
      //  2. quality-governed only → a valid comparison baseline, but promotion
      //     needs a gate policy; never claim release-safety.
      //  3. ungoverned → observed result only, not release evidence.
      if (isReleaseGoverned(run)) {
        return {
          message:
            "Quality gates passed. Safe to promote or use as baseline.\n\nRecommended steps:\n1. Snapshot this run as the regression baseline.\n2. Attach the same evaluation name to the next release candidate.\n3. Keep quality contracts enabled so regressions surface early.",
          steps: [
            "Snapshot this run as the regression baseline.",
            "Attach the same evaluation name to the next release candidate.",
            "Keep quality contracts enabled so regressions surface early.",
          ],
          example: sampleExampleForPass(scenario),
        };
      }
      if (isQualityGoverned(run)) {
        return {
          message:
            "Quality gates passed — this run is a valid comparison baseline. No release gate policy governs it yet, so it is not promotion evidence. Attach a gate policy and re-run to gate a release.\n\nRecommended steps:\n1. Snapshot this run as the regression baseline.\n2. Attach a gate policy to govern promotion.\n3. Re-run under the gate policy to capture release evidence.",
          steps: [
            "Snapshot this run as the regression baseline.",
            "Attach a gate policy to govern promotion.",
            "Re-run under the gate policy to capture release evidence.",
          ],
          example: sampleExampleForPass(scenario),
        };
      }
      return {
        message:
          // "All selected checks passed" was a claim about the cases, and the
          // gate is not a claim about the cases: a KPI composite clears its
          // threshold on a weighted average, so this sentence sat directly
          // under a headline reading "3 cases failed a check". The gate is what
          // passed; say that.
          "The gated score cleared its threshold, but no quality contract governs this run — it is not release evidence. Attach a contract and re-run to gate a release.\n\nRecommended steps:\n1. Attach a quality contract to the evaluation project.\n2. Re-run under the contract to capture a governed verdict.\n3. Use this run for diagnostic comparison in the meantime.",
        steps: [
          "Attach a quality contract to the evaluation project.",
          "Re-run under the contract to capture a governed verdict.",
          "Use this run for diagnostic comparison in the meantime.",
        ],
        example: sampleExampleForPass(scenario),
      };
    }
    case "warn":
      return {
        message:
          "Marginal scores. Review borderline KPIs before release.\n\nRecommended steps:\n1. Inspect metrics near the warn threshold in Metric averages.\n2. Spot-check Case Details for borderline rationales.\n3. Tighten prompts or retrieval for those weak spots, then re-run.",
        steps: [
          "Inspect metrics near the warn threshold in Metric averages.",
          "Spot-check Case Details for borderline rationales.",
          "Tighten prompts or retrieval for those weak spots, then re-run.",
        ],
        example:
          "Example: faithfulness averaged 72% (warn ≥ 70%). Two cases cited incomplete context from search_documents — increase top-k or re-rank before release.",
      };
    case "fail":
      return {
        message:
          "Quality gate failed. Address failing KPIs before promoting.\n\nRecommended steps:\n1. Identify the lowest KPI and its constituent metrics.\n2. Use Case Details to isolate failing rows and tool traces.\n3. Fix the underlying prompt/tool/retrieval issue and re-run until Pass.",
        steps: [
          "Identify the lowest KPI and its constituent metrics.",
          "Use Case Details to isolate failing rows and tool traces.",
          "Fix the underlying prompt/tool/retrieval issue and re-run until Pass.",
        ],
        example: sampleExampleForFailure({ scenario, rootLabel: null, failing: [] }),
      };
    case "pending":
    case "running":
      return {
          message: "Evaluation is still in progress.",
          steps: ["Wait for the run to complete, then refresh Runs."],
          example: "Example: a running job shows status Running until metric scoring finishes.",
        };
    case "error": {
      const err = run.error_message?.trim() || "Evaluation failed before a quality gate was produced.";
      return {
          message: err,
          steps: [
            "Open the run error details and confirm agent connectivity.",
            "Fix the blocking failure and re-run with the same evaluation name.",
          ],
          example:
            "Example: AGENT_OUTPUT_TOO_LARGE on a document-search row — mark the row failed, keep the experiment, and truncate tool payloads before retrying.",
      };
    }
    case "blocked":
      return {
        message: "Evaluation was blocked before a release verdict could be produced.",
        steps: ["Review readiness and provenance details, correct the blocking prerequisite, and start a new run."],
        example: "Example: the target revision changed after readiness was checked, so execution was blocked without a quality gate.",
      };
    case "inconclusive":
      return {
        message: "Required evidence or scoring is incomplete. This run cannot support a release decision.",
        steps: ["Review evidence coverage and metric states, restore the missing evidence or evaluator, then run again."],
        example: "Example: tool events were observed but their completion was not attested, so the result remains reviewable but not gated.",
      };
    case "diagnostic":
      return {
        message: "Diagnostic run only. Results are exploratory and cannot be used as release evidence.",
        steps: ["Review observed scores, then select a governed Quality Contract when a release verdict is required."],
        example: "Example: NLP similarity metrics can be inspected without contributing to a release gate.",
      };
    case "not_recorded":
    default:
      return {
        message: "Outcome was not recorded for this historical run.",
        steps: ["Review the preserved evidence directly; do not use this run as conclusive release evidence."],
        example: sampleExampleForPass(scenario),
      };
  }
}

function sampleExampleForPass(scenario: string): string {
  if (scenario === "RAG") {
    return "Example: after grounding improved, faithfulness moved from 61% → 88% and the overall gate flipped to Pass on the same golden dataset.";
  }
  if (scenario === "LLM") {
    return "Example: adding an explicit refusal style guide raised safety from warn to pass without regressing relevance on the baseline set.";
  }
  return "Example: fixing tool-arg schema validation cleared tool_selection failures; the next labeled run passed all agent KPIs on the same evaluation name.";
}

function sampleExampleForFailure(opts: {
  scenario: string;
  rootLabel: string | null;
  failing: string[];
}): string {
  const metric = opts.rootLabel || opts.failing[0] || "the failing metric";
  if (opts.scenario === "RAG") {
    return `Example: cases failing ${metric} often returned answers unsupported by retrieved chunks — verify top-k retrieval and citation prompts, then re-score the same rows.`;
  }
  if (opts.scenario === "LLM") {
    return `Example: ${metric} failures clustered on long multi-turn prompts — shorten context or raise the judge threshold only after fixing the model instructions.`;
  }
  return `Example: when ${metric} fails, inspect tool_calls for oversized payloads or wrong tool choice on a single Case Details row, fix the agent, and re-run that evaluation name with a new label.`;
}

export function formatRunScore(run: RunResult): string {
  const score = gatedRunScore(run);
  // Named, not a bare dash — the same absence the Experiments table and the
  // group rows above already name. A complete run can still carry no gated
  // score, so this path is not only the incomplete case.
  if (score == null) return "Not scored";
  return `${(score * 100).toFixed(0)}%`;
}

/** User annotation from the run payload, experiment tags, or local form memory. */
export function runLabel(run: RunResult): string {
  const direct = run.label?.trim();
  if (direct) return direct;
  const tagged = run.experiment?.tags?.label?.trim();
  if (tagged) return tagged;
  return recallRunLabel(run.run_id);
}

/** Evaluation name used to group related runs in Experiments and Runs. */
export function evaluationName(run: RunResult): string {
  const tagged = run.experiment?.tags?.evaluation_name?.trim();
  if (tagged) return tagged;
  const name = run.experiment?.name?.trim();
  if (name) return name;
  const memory = recallRunForm(run.run_id)?.evaluationName?.trim();
  if (memory) return memory;
  return run.experiment?.experiment_id || run.run_type || "Untitled evaluation";
}

/** Option text for run pickers: evaluation name + optional label. */
export function runDisplayName(run: RunResult): string {
  const name = evaluationName(run);
  const label = runLabel(run);
  return label ? `${name} · ${label}` : name;
}

export function scenarioTypeLabel(
  scenario: string | null | undefined,
  runType?: string | null,
  responseSource?: string | null,
): string {
  if (responseSource === "provided") return "Existing responses";
  if (responseSource === "baseline") return "Baseline";
  const value = (scenario || runType || "").toLowerCase();
  if (value.includes("agent")) return "Agent";
  if (value.includes("rag")) return "RAG";
  if (value.includes("llm")) return "LLM";
  if (runType) return runType;
  return "Evaluation";
}

/** Label a complete or in-flight run from its recorded response source first. */
export function runScenarioTypeLabel(run: RunResult): string {
  return scenarioTypeLabel(
    run.experiment?.scenario,
    run.run_type,
    recordedResponseSource(run),
  );
}

export function evaluateHrefForScenario(scenario: string | null | undefined): string {
  const value = (scenario || "").toLowerCase();
  if (value.includes("rag")) return "/evaluate?type=rag";
  if (value.includes("llm")) return "/evaluate?type=llm";
  return "/evaluate?type=agent";
}

/** Open the canonical run page, which shows progress until the report is ready. */
export function runDetailsHref(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}

/** Open the complete run history and highlight the run that was just launched. */
export function evaluationRunsHref(runId: string): string {
  return `/evaluations?highlight=${encodeURIComponent(runId)}`;
}

/** Strip trailing `.vN` from experiment.dataset_version. */
export function parseDatasetNameFromVersion(datasetVersion: string | null | undefined): string {
  if (!datasetVersion) return "";
  return datasetVersion.replace(/\.v\d+$/i, "");
}

export function isQualityMetricId(metricId: string): boolean {
  return metricId.startsWith("quality.");
}

/** Durable response source recorded with the run, when available. */
export function recordedResponseSource(run: RunResult): string {
  const source =
    run.response_source ?? run.lineage?.resolved_target_provenance?.target_type;
  return typeof source === "string" ? source : "";
}

/**
 * Whether this run invoked a system to produce its evaluated response.
 *
 * `null` means the run recorded nothing to answer with — neither a response
 * source nor an endpoint. "Not invoked" is as much a claim about the run as
 * "invoked" is, and a legacy row that never wrote either deserves neither.
 */
export function runInvokesTarget(run: RunResult): boolean | null {
  const source = recordedResponseSource(run);
  if (source === "provided" || source === "baseline") return false;
  if (source === "agent" || source === "llm") return true;
  const endpoint = run.experiment?.target_endpoint;
  if (!endpoint) return null;
  return !endpoint.startsWith("golden-dataset:");
}

/** Best-effort mode for legacy reruns that lack durable launch configuration. */
export function rerunEvaluationKind(
  run: RunResult,
): "agent" | "rag" | "llm" | "provided" | "baseline" {
  const responseSource = recordedResponseSource(run);
  if (
    responseSource === "agent" ||
    responseSource === "llm" ||
    responseSource === "provided" ||
    responseSource === "baseline"
  ) {
    return responseSource;
  }
  const memory = recallRunForm(run.run_id);
  if (memory?.kind) return memory.kind;

  const target = run.experiment?.target_endpoint?.trim() || "";
  if (target.startsWith("llm-catalog:")) return "llm";
  if (target && !target.startsWith("golden-dataset:")) return "agent";

  const scenario = (run.experiment?.scenario || "").toLowerCase();
  if (scenario.includes("rag")) return "rag";
  if (scenario.includes("llm")) return "llm";
  if ((run.active_metrics || []).some((metric) => metric.startsWith("agent."))) return "agent";
  return "agent";
}

/** Build evaluate URL with last-run parameters for Rerun / Rerun - Config. */
export function evaluateHrefFromRun(
  run: RunResult,
  opts?: { includeRunId?: boolean },
): string {
  const memory = recallRunForm(run.run_id);
  const rerunKind = rerunEvaluationKind(run);
  const base = `/evaluate?type=${rerunKind}`;
  const params = new URLSearchParams();
  params.set("rerun", "1");

  const dataset =
    parseDatasetNameFromVersion(run.experiment?.dataset_version) || memory?.datasetName || "";
  if (dataset) params.set("dataset", dataset);

  const target = run.experiment?.target_endpoint?.trim() || memory?.endpoint || memory?.agentId || "";
  if (rerunKind === "agent") {
    const agent = memory?.agentId || (target && !target.startsWith("golden-dataset:") ? target : "");
    if (agent) params.set("agent", agent);
  } else if (rerunKind === "llm") {
    const modelId =
      run.experiment?.target_version?.trim() || memory?.selectedLlmId || memory?.targetModel || "";
    if (modelId) params.set("targetModel", modelId);
  } else if (rerunKind === "rag") {
    if (target && !target.startsWith("golden-dataset:") && !target.startsWith("llm-catalog:")) {
      params.set("endpoint", target);
    }
    const model = run.experiment?.target_version || memory?.targetModel;
    if (model) params.set("targetModel", model);
  }

  const judge = run.experiment?.judge_model || memory?.judgeModel;
  if (judge) params.set("judgeModel", judge);

  const metrics = (
    (run.active_metrics || []).filter((id) => !isQualityMetricId(id)).length
      ? (run.active_metrics || []).filter((id) => !isQualityMetricId(id))
      : memory?.selectedMetrics || []
  ).filter((id) => id && !isQualityMetricId(id));
  if (metrics.length) params.set("metrics", metrics.join(","));

  const qualityMetrics = (run.active_metrics || []).filter(isQualityMetricId);
  if (qualityMetrics.length || memory?.applyContracts) {
    params.set("applyContracts", "1");
    const contractMetrics = qualityMetrics.length
      ? qualityMetrics
      : memory?.selectedContracts || [];
    if (contractMetrics.length) params.set("contractMetrics", contractMetrics.join(","));
  }

  const label = runLabel(run) || memory?.label?.trim() || "";
  if (label) params.set("label", label);

  const evalName = evaluationName(run);
  // Prefer explicit user evaluation name (not the auto dataset fallback pattern).
  const memoryName = memory?.evaluationName?.trim() || "";
  const nameForForm = memoryName || (run.experiment?.tags?.evaluation_name?.trim() || "");
  if (nameForForm) params.set("evaluationName", nameForForm);
  else if (evalName && !/^.+\s+\((baseline|provided|agent|llm)\)$/i.test(evalName)) {
    params.set("evaluationName", evalName);
  }

  if (memory?.enableJudge === false) params.set("enableJudge", "0");
  if (memory?.humanReview) params.set("humanReview", "1");
  if (memory?.parallelRequests) params.set("parallelRequests", String(memory.parallelRequests));

  const promptRef = run.lineage?.target_prompt_ref || memory?.systemPromptRef || "";
  if (promptRef) params.set("promptRef", promptRef);

  const evaluationScope =
    run.lineage?.resolved_evaluation_scope ||
    run.lineage?.evaluation_scope ||
    run.experiment?.evaluation_scope ||
    memory?.evaluationScope;
  if (evaluationScope) params.set("evaluationScope", evaluationScope);

  // Selected-tools level: replay the run's named-tool selection so the
  // workbench restores the same scoped tool picker. Absent = whole tool layer.
  const selectedTools =
    run.lineage?.selected_tool_ids ??
    run.experiment?.selected_tool_ids ??
    memory?.selectedToolIds ??
    null;
  if (selectedTools && selectedTools.length) {
    params.set("tools", selectedTools.join(","));
  }

  // Preserve trace continuity on rerun: the source run's tracing Project must
  // travel with the URL, otherwise the workbench reopens "Leave this run
  // unassigned" and the rerun silently drops out of the Project's trace stream.
  const projectId =
    run.experiment?.project_id || run.lineage?.project_id || memory?.projectId || "";
  if (projectId) params.set("project", projectId);

  if (opts?.includeRunId && run.run_id) params.set("run", run.run_id);
  if (run.run_id) params.set("fromRun", run.run_id);

  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${params.toString()}`;
}
