// Shape of the Proofgrove backend's payloads: types only, no transport.
//
// Split out of `api.ts` so the clients are readable; `api.ts` re-exports every name
// here, so `@/lib/api` remains the single import site for all of them.

export interface DatasetInfo {
  dataset_id: string;
  name?: string;
  dataset_name?: string;
  tenant_id: string;
  product_id: string;
  status: string;
  version_number: number;
  parent_dataset_name: string | null;
  dqs: number | null;
  change_reason: string | null;
  created_by: string;
  record_count?: number;
  /** Last change to the dataset. Absent on older responses. */
  updated_at?: string | null;
  /**
   * Which of the two required halves — the question to send and the expected output to
   * grade against — the rows do not carry, read from row content by the backend. Empty
   * means usable; absent/null means it was not computed on this response, which is never
   * the same as "missing something".
   */
  missing_row_fields?: string[] | null;
  /** True when an inspected row lacks the response required by a `provided` run. */
  missing_provided_response?: boolean | null;
}

export interface QualityCheck {
  name: string;
  passed: boolean;
  score: number;
  message: string;
  is_blocker: boolean;
}

export interface ValidationResult {
  dqs: number;
  passed: boolean;
  target_status: string;
  blocker_failures: string[];
  checks: QualityCheck[];
}

export interface DatasetRecord {
  /** Stable per-row id. Present on reads; absent on records being written. */
  dataset_record_id?: string;
  inputs: Record<string, unknown>;
  expectations: Record<string, unknown>;
  tags: Record<string, string>;
}

/**
 * Write expected tools onto chosen dataset rows.
 *
 * Not the same claim as `selectedToolIds` on a run. That scopes scoring ("score
 * only these tools"); this states a row expectation ("this row should call
 * these"), and it only ever touches `record_ids`.
 */
export interface WriteExpectedToolsRequest {
  record_ids: string[];
  tools: string[];
  source_agent?: string | null;
  create_version_if_immutable?: boolean;
  created_by?: string;
}

export interface WriteExpectedToolsResult {
  dataset_name: string;
  annotated: number;
  tools: string[];
  /** True when the write landed on a new DRAFT version, not the original. */
  created_version: boolean;
  source_dataset_name: string | null;
  version_number: number | null;
  status: string | null;
}

export interface PromoteRunItemRequest {
  run_id: string;
  example_id: string;
  /**
   * Which captured text becomes the record's expected output. The run's tenant
   * is not carried here on purpose: the destination dataset's own tenant scopes
   * the source lookup server-side, so the two sides cannot disagree.
   */
  expected_source: "output" | "expected" | "reviewer";
  expected_text?: string;
  create_version_if_immutable?: boolean;
  created_by?: string;
}

export interface PromoteRunItemResult {
  dataset_name: string;
  record_id: string;
  /** True when this source item was already promoted here; the record was refreshed. */
  duplicate: boolean;
  /** True when the write landed on a new DRAFT version, not the original. */
  created_version: boolean;
  source_dataset_name: string | null;
  version_number: number | null;
  status: string | null;
}

/**
 * Offset-paged envelope shared by `GET /datasets` and
 * `GET /datasets/{name}/records` when `limit`/`cursor` are passed (same
 * convention as run history). `total` is the honest unpaged match count used
 * for "Showing N of M"; `next_cursor` is an opaque offset cursor that is
 * `null` on the last page. Without paging params both endpoints still return
 * the legacy bare arrays.
 */
export interface DatasetPage {
  items: DatasetInfo[];
  total: number;
  limit: number;
  offset: number;
  next_cursor: string | null;
}

/**
 * Prompt-paged envelope from `GET /platform/prompts` with `paginate_by=prompt`.
 * A page holds whole prompts, so `total` counts prompts while `items` carries
 * every version of the prompts on the page — the index groups them, and a prompt
 * split across two pages would report a partial history on each.
 */
export interface PromptPage {
  items: PromptVersion[];
  total: number;
  limit: number;
  offset: number;
  next_cursor: string | null;
}

/** Aggregate counts from GET /datasets/stats. Published = status PUBLISHED. */
export interface DatasetStats {
  total: number;
  by_status: Record<string, number>;
}

export interface DatasetRecordsPage {
  items: DatasetRecord[];
  total: number;
  limit: number;
  offset: number;
  next_cursor: string | null;
}

export interface DatasetPageQuery {
  limit: number;
  offset?: number;
  cursor?: string;
  status?: string;
  /** Tenant scope. Omitted calls fall back to the gateway tenant header. */
  tenant_id?: string;
}

export interface CsvTemplate {
  csv: string;
  columns: Record<string, string>;
}

export interface GenerateRequest {
  dataset_name: string;
  grounding_url?: string | null;
  grounding_tool?: string;
  seeds: string[];
  num_rows?: number | null;
  domain?: string;
  agent?: string | null;
  product_id?: string;
  model?: string | null;
  model_endpoint?: string | null;
  generation_method?: "llms" | "tools" | "agents" | null;
}

export interface AgentSummary {
  id: string;
  name: string;
  namespace: string;
  display_name: string | null;
  description: string;
  ready: boolean;
  accepted: boolean;
  model: string | null;
  agent_type: string | null;
  revision: string;
  tools: string[];
  grounding_url: string | null;
  /** Local workflow catalog metadata. Availability remains server-owned. */
  execution_mode?: string;
  recommended_dataset_id?: string;
  recommended_metric_ids?: string[];
  example_query?: string;
  availability_message?: string;
  /** Active tenant system Project bound to this logical agent target, when configured. */
  system_project_id?: string | null;
}

export type Scenario = "llm_core" | "rag" | "agentic";

export type GateResult = "pass" | "warn" | "fail";

export type VersionLifecycle = "draft" | "validated" | "approved" | "retired";

export type EvaluationScope = "final_response" | "tool_interactions" | "full_execution";

export interface EvaluationProject {
  project_id: string;
  tenant_id: string;
  name: string;
  description?: string | null;
  system_type: string;
  owner: string;
  status: "active" | "archived";
  purpose?: "system" | "catalog_registry" | null;
  tags?: Record<string, string>;
  created_by?: string;
  created_at?: string;
}

export interface TargetVersion {
  target_version_id: string;
  target_id: string;
  project_id: string;
  tenant_id: string;
  name: string;
  version: string;
  endpoint: string;
  target_type: "agent" | "application" | "rag_system" | "endpoint";
  environment: string;
  model_version?: string | null;
  prompt_version?: string | null;
  tool_versions: Record<string, string>;
  configuration: Record<string, unknown>;
  created_by?: string;
  created_at?: string;
}

export interface PromptVersion {
  prompt_id: string;
  version: number;
  tenant_id: string;
  name: string;
  description?: string | null;
  content: string;
  content_hash: string;
  labels: string[];
  created_by?: string;
  /** When this version was saved; drives the version history. */
  created_at?: string | null;
  /** Set once retired: gone from the pickers, still resolvable by number. */
  archived_at?: string | null;
}

export interface QualityProfileVersion {
  profile_id: string;
  version: string;
  tenant_id: string;
  project_id?: string | null;
  name: string;
  description?: string | null;
  status: VersionLifecycle;
  scenario?: Scenario | null;
  metric_ids: string[];
  metric_requirements?: Record<string, "required" | "optional">;
  kpi_gate_weights?: Record<string, Record<string, number>>;
  evidence_requirements: string[];
  exact_runtime_identity_required?: boolean;
  hard_blocker_metric_ids: string[];
  approver_roles: string[];
  gate_policy_id?: string | null;
  gate_policy_version?: string | null;
  source_template_id?: string | null;
  source_template_snapshot?: QualityContractTemplate | null;
  test_status?: "not_tested" | "tested" | "overridden";
  tested_at?: string | null;
  test_note?: string | null;
  tested_by?: string | null;
  created_at?: string | null;
  created_by?: string | null;
}

export interface QualityContractTemplate {
  template_id: string;
  metric_id: string;
  name: string;
  description: string;
  domain: string;
  criteria: string;
  evaluation_steps: string[];
  threshold: number;
  evaluation_params: string[];
  tags: string[];
  scenario: Scenario;
}

export interface ReleaseGatePolicyVersion {
  gate_policy_id: string;
  version: string;
  tenant_id: string;
  name: string;
  description?: string | null;
  status: VersionLifecycle;
  required_evidence: string[];
  required_approver_roles: string[];
  hard_blocker_metric_ids: string[];
  created_at?: string | null;
  created_by?: string | null;
}

export type AssignmentGovernanceState = "standardized_evaluation" | "release_governed";

export interface EvaluationAssignmentVersion {
  assignment_id: string;
  version: string;
  tenant_id: string;
  name: string;
  purpose?: string | null;
  owner?: string | null;
  change_note?: string | null;
  project_id: string;
  target_version_id: string;
  profile_id: string;
  profile_version: string;
  gate_policy_id?: string | null;
  gate_policy_version?: string | null;
  run_manifest_id: string;
  parent_assignment_version_id?: string | null;
  archived_at?: string | null;
  created_by?: string;
  created_at?: string;
  governance_state: AssignmentGovernanceState;
  resolved_run_manifest?: ResolvedRunManifest | null;
}

export interface ResolvedRunManifest {
  manifest_id: string;
  manifest_hash: string;
  tenant_id: string;
  project_id: string;
  target_version_id: string;
  target_id: string;
  /** Display name snapshotted at resolve time; absent on manifests resolved before that existed. */
  target_name?: string | null;
  target_version: string;
  target_endpoint: string;
  target_type: TargetVersion["target_type"];
  environment: string;
  quality_profile_id: string;
  quality_profile_version: string;
  gate_policy_id?: string | null;
  gate_policy_version?: string | null;
  benchmark_package_id?: string | null;
  benchmark_package_version?: string | null;
  benchmark_family?: string | null;
  scenario: Scenario;
  metric_ids: string[];
  metric_requirements?: Array<{
    metric_id: string;
    requirement: "required" | "optional";
    source:
      | "quality_contract"
      | "explicit_selection"
      | "legacy_scenario_primary"
      | "legacy_cross_cutting"
      | "catalog_diagnostic_default";
  }>;
  kpi_compositions?: Array<{
    kpi_id: string;
    required_gate_constituents: string[];
    optional_diagnostic_constituents: string[];
    fixed_gate_weights: Record<string, number>;
    thresholds: Record<string, number>;
    hard_blocker_metric_ids: string[];
  }>;
  diagnostic_only?: boolean;
  evaluation_scope?: EvaluationScope | null;
  evaluator_refs: Record<string, string>;
  metric_pack_refs: string[];
  metric_definitions: Array<Record<string, unknown>>;
  metric_evidence_requirements?: Record<string, string[]>;
  effective_evidence_requirements?: string[];
  exact_runtime_identity_required?: boolean;
  kpi_threshold_overrides: Record<string, Record<string, number>>;
  evidence_requirements: string[];
  hard_blocker_metric_ids: string[];
  review_trigger_gates: GateResult[];
  approver_roles: string[];
  judge_config: Record<string, unknown>;
  model_version?: string | null;
  prompt_version?: string | null;
  tool_versions: Record<string, string>;
  source_template_id?: string | null;
  source_template_snapshot?: QualityContractTemplate | null;
  resolved_at: string;
  resolved_by: string;
}

/** How often reviewers agreed with the judge on one metric.
 *
 *  `reviewed` is always shown beside `agreed`: a percentage off two cases is
 *  noise, and this number only becomes meaningful with volume. `ambiguous`
 *  counts cases skipped because the finding named several metrics, so a
 *  rejection could not be attributed to one judge. */
export interface JudgeAgreement {
  metric_id: string;
  /** The scorer that produced the reviewed scores. Counts are split by it:
   *  a metric that moved between frameworks keeps its id, so pooling by metric
   *  alone would let verdicts about the old scorer vouch for the new one. */
  executed_scorer?: string | null;
  agreed: number;
  reviewed: number;
  ambiguous: number;
}

export interface Finding {
  finding_id: string;
  run_id: string;
  experiment_id: string;
  row_id: string;
  metric_ids: string[];
  gate_result: GateResult;
  severity: "low" | "medium" | "high" | "critical";
  root_cause_category?: string | null;
  evidence: Record<string, unknown>;
  status: "open" | "in_review" | "resolved" | "waived" | "promoted";
  created_at: string;
}

export interface ReviewTask {
  task_id: string;
  finding_id: string;
  tenant_id?: string | null;
  assigned_to?: string | null;
  status: Finding["status"];
  created_at: string;
}

/** One entry in a finding's append-only, ordered review-decision history. */
export interface ReviewDecisionRecord {
  decision_id: string;
  finding_id: string;
  task_id: string;
  actor: string;
  outcome: "agree" | "disagree" | "abstain";
  rationale: string;
  score_override?: number | null;
  severity?: Finding["severity"] | null;
  root_cause_category?: string | null;
  timestamp: string;
  superseded: boolean;
  is_current: boolean;
}

export interface Remediation {
  remediation_id: string;
  finding_id: string;
  owner: string;
  description: string;
  status: "open" | "in_progress" | "completed" | "cancelled";
  due_at?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface RegressionCase {
  regression_case_id: string;
  tenant_id?: string | null;
  kind: "regression" | "holdout";
  status: string;
  finding_id: string;
  source_run_id: string;
  source_target_version_id?: string | null;
  record?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  created_by?: string;
  created_at: string;
}

export interface ExperimentDefinition {
  experiment_id?: string;
  name: string;
  dataset_version: string;
  target_endpoint: string;
  scenario: Scenario | "";
  domain?: string | null;
  market: string;
  judge_model: string;
  judge_temperature: number;
  has_ground_truth: boolean;
  row_count?: number;
  description?: string | null;
  objective?: string | null;
  hypothesis?: string | null;
  tenant_id?: string | null;
  product_id?: string | null;
  owner?: string | null;
  status?: string;
  tags?: Record<string, string>;
  target_id?: string | null;
  target_version?: string | null;
  target_version_id?: string | null;
  environment?: string | null;
  quality_profile_id?: string | null;
  quality_profile_version?: string | null;
  project_id?: string | null;
  gate_policy_id?: string | null;
  gate_policy_version?: string | null;
  run_manifest_id?: string | null;
  evaluation_scope?: EvaluationScope | null;
  /** Selected-tools level: named tools a tool_interactions run was scoped to (null = whole tool layer). */
  selected_tool_ids?: string[] | null;
  created_at?: string | null;
}

export interface TraceProject extends EvaluationProject {
  classification_state?: "classified" | "unclassified_historical";
  trace_count: number;
  last_activity_at: string | null;
}

export type TraceCaptureState = "captured" | "partial" | "unknown";

export type TraceAttestationState = "attested" | "not_attested" | "unknown";

export type TraceInvocationOutcome = "succeeded" | "error" | "unknown";

/**
 * Honest collector-confirmed lifecycle of an indexed trace: `requested` (trace
 * id recorded, archive never checked), `pending_export` (archive checked,
 * nothing landed yet), `archive_confirmed` (spans genuinely found; counts are
 * real), `archive_unavailable` (last archive check errored).
 */
export type TraceLifecycleState =
  | "requested"
  | "pending_export"
  | "archive_confirmed"
  | "archive_unavailable";

export interface CapturedTraceSummary {
  /** Null on index-served rows without a Project home ("Unassigned"). */
  project_id: string | null;
  trace_id: string;
  trace_provider: string | null;
  /** Null for non-evaluation traces served from the collector-confirmed index. */
  run_id: string | null;
  /** Optional user-facing label for the evaluation run. */
  run_name?: string | null;
  /** Persisted version number within the evaluation's run history. */
  run_number?: number | null;
  example_id: string | null;
  evaluation_name: string | null;
  input_summary?: string | null;
  evaluation_status?: "evaluated" | "not_evaluated";
  target_revision?: string | null;
  captured_at: string | null;
  capture_state: TraceCaptureState;
  attestation_state: TraceAttestationState;
  invocation_outcome: TraceInvocationOutcome;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost: number | null;
  run_status: string | null;
  verdict_status: string | null;
  overall_gate: GateResult | null;
  // Index extensions (present when the page is served from the
  // collector-confirmed trace index; span statistics are null until spans
  // were genuinely read from the archive — never fabricated).
  lifecycle_state?: TraceLifecycleState;
  span_count?: number | null;
  error_count?: number | null;
  root_span_name?: string | null;
  root_span_kind?: string | null;
  model?: string | null;
  duration_ms?: number | null;
  is_evaluated?: boolean;
  last_checked_at?: string | null;
  hidden?: boolean;
}

/**
 * Keyset-paged envelope for the project traces list
 * (`GET /tracing/projects/{id}/traces/page`). `total` is the honest distinct
 * trace count used for "showing N of M"; `next_cursor` is an opaque keyset
 * cursor that is `null` on the last page, and `has_more` mirrors that.
 */
export interface CapturedTracesPage {
  items: CapturedTraceSummary[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
  hidden_count?: number;
  /**
   * Where the page came from: the collector-confirmed trace index, or the
   * legacy eval-derived projection (fallback while the index is empty).
   */
  source?: "index" | "projection";
}

/** One archived-span summary row from the collector-confirmed span index. */
export interface IndexedSpanSummary {
  project_id: string | null;
  trace_id: string;
  /** Evaluation identity is resolved from the span's trace, when linked. */
  run_id?: string | null;
  run_name?: string | null;
  run_number?: number | null;
  evaluation_name?: string | null;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  /** OTLP transport kind. Orthogonal to `semantic_kind` — neither replaces the other. */
  kind: string | null;
  /**
   * What the span did — `llm` / `agent` / `tool` / … — derived server-side when
   * the trace was indexed. Transport spans are never listed, so this is set on
   * every row the endpoint returns.
   */
  semantic_kind: string | null;
  /** Bounded preview of the recorded input; null when the span recorded none. */
  input_preview: string | null;
  /** Bounded preview of the recorded output; null when the span recorded none. */
  output_preview: string | null;
  llm_token_count_prompt: number | null;
  llm_token_count_completion: number | null;
  /** List-rate USD from tokens + model, or a producer-stamped cost. Null when unpriced. */
  estimated_cost_usd: number | null;
  started_at: string | null;
  duration_ms: number | null;
  status: "ok" | "error" | "unset";
}

/** Keyset-paged envelope for `GET /tracing/projects/{id}/spans/page`. */
export interface IndexedSpansPage {
  items: IndexedSpanSummary[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
}

export interface CapturedTraceSpan {
  span_id: string | null;
  parent_span_id: string | null;
  name: string;
  run_id: string;
  example_id: string;
  latency_ms: number | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  retrieval_snippets: string[];
  tool_calls: Record<string, unknown>[];
  usage: Record<string, unknown> | null;
  invocation_error: string | null;
  evidence_ref: string | null;
  redaction_enabled: boolean;
  truncated: boolean;
}

/** Trace summary; collector traces may have no evaluation identity. */
export interface CapturedTraceDetail
  extends Omit<
    CapturedTraceSummary,
    "run_id" | "example_id" | "evaluation_name" | "run_status" | "lifecycle_state"
  > {
  run_id: string | null;
  example_id: string | null;
  evaluation_name: string | null;
  run_status: string | null;
  spans: ArchivedTraceSpan[];
  tree_available: boolean;
  lifecycle_state?: "available" | "archive_unavailable" | "unknown";
  lifecycle_message?: string | null;
  archive_truncated?: boolean;
}

/** Archived-span payload from the standalone `/spans` endpoint (may 503 alone). */
export interface CapturedTraceSpans {
  spans: ArchivedTraceSpan[];
  tree_available: boolean;
  lifecycle_state?: "available" | "archive_unavailable" | "unknown";
  lifecycle_message?: string | null;
  archive_truncated?: boolean;
}

export interface ConstituentScore {
  metric_id: string;
  weight: number;
  raw_score: number;
  normalised_score: number;
  sample_size: number;
}

export interface KpiResult {
  kpi_id: string;
  run_id: string;
  composite_score: number | null;
  gate_result: GateResult | null;
  observed_score?: number | null;
  constituent_scores: ConstituentScore[];
  threshold_pass: number;
  threshold_warn: number;
  threshold_fail: number;
  evaluated_target: string;
  required_applicable_pair_count?: number;
  required_scored_count?: number;
  required_unscored_count?: number;
  required_technical_error_count?: number;
  required_coverage_percentage?: number | null;
  coverage_label?: "complete" | "partial" | "incomplete" | null;
  optional_applicable_pair_count?: number;
  optional_scored_count?: number;
  optional_coverage_percentage?: number | null;
}

export type MetricRequirement = "required" | "optional";

export type MetricApplicability = "applicable" | "not_applicable";

export type MetricStatus = "scored" | "unscored" | "technical_error";

export interface MetricResult {
  metric_id: string;
  evaluator_instance_id: string;
  run_id: string;
  row_id: string;
  metric_requirement?: MetricRequirement;
  metric_requirement_source?: string | null;
  metric_applicability?: MetricApplicability;
  metric_status?: MetricStatus | null;
  unscored_reason?: "input_missing" | "evidence_unavailable" | "evaluator_abstained" | "telemetry_not_captured" | "incomplete_trace" | "simulated" | null;
  error_details?: Record<string, unknown> | null;
  score: number | null;
  normalised_score: number | null;
  label: string | null;
  passed: boolean | null;
  rationale: string | null;
  error_message: string | null;
  threshold: number;
  threshold_result: GateResult | null;
  trace_id: string | null;
  span_id?: string | null;
  target_trace_id?: string | null;
  target_span_id?: string | null;
  evaluator_trace_id?: string | null;
  evaluator_span_id?: string | null;
  feedback_scope?: "span" | "trace";
  annotator_kind?: "LLM" | "CODE" | "HUMAN" | null;
  evaluation_identifier?: string | null;
  prompt_version: string;
  judge_prompt_tokens: number | null;
  judge_completion_tokens: number | null;
  judge_total_tokens: number | null;
  judge_model: string | null;
  evaluator_id: string | null;
  evaluator_version: string | null;
  execution_status: string;
  execution_metadata: Record<string, unknown>;
  requested_scorer?: string | null;
  executed_scorer?: string | null;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  output: unknown;
}

export interface ToolResultArtifactReference {
  artifact_id: string;
  artifact_ref: string;
  tool_name: string;
  tool_call_index: number;
  content_type: string;
  size_bytes: number;
  preview: string;
  preview_bytes: number;
}

export interface ToolResultArtifactPage {
  artifact: ToolResultArtifactReference;
  offset: number;
  limit: number;
  content: string;
  next_offset: number | null;
  complete: boolean;
}

export interface RunItemSummary {
  run_id: string;
  example_id: string;
  query: string | null;
  sequence_position: number;
  dataset_version: string | null;
  worst_gate: GateResult | null;
  metric_count: number;
  /** Required metrics that failed. This is what decides the case's verdict. */
  failing_count: number;
  /** Optional metrics that failed. Reported, but not a verdict on the case. */
  failing_optional_count?: number;
  error_count: number;
  scored_count?: number;
  unscored_count?: number;
  /** Unscored metrics that were required. Only these mean the case went
   *  partly unanswered; an optional metric with nothing to measure does not. */
  unscored_required_count?: number;
  not_applicable_count?: number;
  evaluation_state: "evaluated" | "technical_error" | "not_evaluated" | "output_too_large";
  latency_ms: number | null;
  trace_available: boolean;
  evidence_ref: string;
  capture_state: "complete" | "partial" | "unknown";
  error_type?: string | null;
  artifact_count: number;
}

export interface RunItemExecution {
  invocation_id: string | null;
  kagent_session_id: string | null;
  latency_ms: number | null;
  usage: Record<string, unknown> | null;
  invocation_error: string | null;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id?: string | null;
  trace_provider?: string | null;
  tool_evidence_completion_attested?: boolean;
  tool_evidence_provenance_status?:
    | "attested"
    | "self_reported"
    | "unavailable"
    | "not_applicable";
  tool_evidence_source?: string | null;
}

export interface EvidencePolicy {
  redaction_enabled: boolean | null;
  max_persisted_string_size: number | null;
  retention_policy: "stored_with_run_lifecycle";
}

export interface RunItemDetail {
  run_id: string;
  example_id: string;
  sequence_position: number;
  dataset_version: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  expected: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  retrieval_snippets: string[] | null;
  expected_tools: string[] | null;
  tool_calls: ToolCall[] | null;
  tool_result_artifacts: ToolResultArtifactReference[];
  execution: RunItemExecution;
  scorer_results: MetricResult[];
  evidence_ref: string;
  evidence_policy: EvidencePolicy;
  capture_state: "complete" | "partial" | "unknown";
}

export interface ArchivedTraceSpan {
  semantic_kind?: string | null;
  semantic_kind_source?: "openinference" | "telemetry_compatibility" | null;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: number | null;
  start_time_unix_nano: string | null;
  end_time_unix_nano: string | null;
  duration_ms: number | null;
  status: Record<string, unknown> | null;
  attributes: Record<string, unknown>;
  resource_attributes: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  /** List-rate USD attached at read time; not stored on the archive object. */
  estimated_cost_usd?: number | null;
}

export interface RunItemTraceEvidence {
  state: "available" | "pending" | "not_found" | "not_configured";
  trace_id: string | null;
  spans: ArchivedTraceSpan[];
  object_refs: string[];
  pagination_complete: boolean;
  lifecycle_complete: boolean;
  evidence_complete: boolean;
  truncated: boolean;
  message: string | null;
}

export interface RootCauseDiagnosis {
  root_cause_metric_id: string | null;
  root_cause_label: string | null;
  causal_chain: string[];
  failing_metrics: string[];
  recommended_remediation: string | null;
  has_ground_truth: boolean;
}

export interface ReviewQueueItem {
  row_id: string;
  query: string;
  response: string;
  trace_id: string | null;
  failing_metrics: string[];
  gate_result: GateResult;
  rationale: string | null;
}

export interface RunLineageSnapshot {
  source_run_id?: string | null;
  source_evidence_snapshot?: string | null;
  rescore_configuration?: Record<string, unknown> | null;
  project_id?: string | null;
  service_version?: string | null;
  prompt_version?: string | null;
  experiment_version_id?: string | null;
  comparison_basis_hash?: string | null;
  judge_model?: string | null;
  evaluation_scope?: EvaluationScope | null;
  requested_evaluation_scope?: EvaluationScope | null;
  resolved_evaluation_scope?: EvaluationScope | null;
  scope_promotion_reasons?: Array<{
    source_type: string;
    source_id: string;
    evidence_category: string;
  }>;
  /**
   * Named tools this tool_interactions run was scoped to (the selected-tools
   * evaluation level). null / absent = the whole tool layer was evaluated.
   * Runs with different selections share no comparison basis.
   */
  selected_tool_ids?: string[] | null;
  run_manifest_id?: string | null;
  run_manifest_hash?: string | null;
  quality_profile_id?: string | null;
  quality_profile_version?: string | null;
  gate_policy_id?: string | null;
  gate_policy_version?: string | null;
  run_configuration_id?: string | null;
  run_configuration_hash?: string | null;
  metric_requirements?: Array<{
    metric_id: string;
    requirement: "required" | "optional";
    source: "quality_contract" | "explicit_selection" | "legacy_scenario_primary" | "legacy_cross_cutting" | "catalog_diagnostic_default";
  }>;
  kpi_compositions?: Array<{
    kpi_id: string;
    required_gate_constituents: string[];
    optional_diagnostic_constituents: string[];
    fixed_gate_weights: Record<string, number>;
    thresholds: Record<string, number>;
    hard_blocker_metric_ids: string[];
  }>;
  metric_evidence_requirements?: Record<string, string[]>;
  effective_evidence_requirements?: string[];
  target_version_id?: string | null;
  model_version?: string | null;
  target_prompt_version?: string | null;
  target_prompt_ref?: string | null;
  tool_versions?: Record<string, string>;
  requested_target_provenance?: Record<string, unknown>;
  resolved_target_provenance?: Record<string, unknown>;
  observed_target_provenance?: Record<string, unknown>;
  exact_runtime_identity_required?: boolean;
  target_identity_status?: "matched" | "mismatched" | "unverified" | "not_applicable";
  captured_at?: string | null;
}

/** Per-depth capture availability, as reported by the readiness endpoint. */
export interface EvaluationScopeOption {
  scope: EvaluationScope;
  available: boolean;
  reason?: string | null;
  caveat?: string | null;
}

export interface EvidenceReadinessResult {
  status: "ready" | "blocked" | "unsupported" | "unknown";
  /** Absent on a backend predating per-depth availability; see `scopeOptionsFrom`. */
  scope_options?: EvaluationScopeOption[];
  evaluation_scope: EvaluationScope;
  requested_evaluation_scope: EvaluationScope;
  resolved_evaluation_scope: EvaluationScope;
  scope_promotion_reasons: Array<{
    source_type: string;
    source_id: string;
    evidence_category: string;
  }>;
  effective_evidence_requirements: string[];
  metric_evidence_requirements?: Record<string, string[]>;
  metric_requirements?: Array<{
    metric_id: string;
    requirement: "required" | "optional";
    source: "quality_contract" | "explicit_selection" | "legacy_scenario_primary" | "legacy_cross_cutting" | "catalog_diagnostic_default";
  }>;
  metric_applicability: Array<{
    metric_id: string;
    applicability: "known_applicable" | "potentially_applicable" | "known_not_applicable";
    reason?: string | null;
  }>;
  details: Array<{ code: string; message: string; evidence_category?: string | null }>;
  requested_provenance: Record<string, unknown>;
  resolved_provenance: Record<string, unknown>;
  /** Declared tool inventory of the resolved agent target (null until resolved / unknowable). */
  agent_tools?: string[] | null;
  /** Echo of the caller's named-tool selection (null = whole tool layer). */
  selected_tool_ids?: string[] | null;
}

export interface EvidenceCategorySummary {
  category: string;
  required: boolean;
  status: "captured" | "partial" | "not_captured" | "unknown" | "not_required";
  record_count: number;
  completeness_attested: boolean;
  provenance_status: "attested" | "self_reported" | "unavailable" | "not_applicable";
  provenance_source?: string | null;
  diagnostic?: "root_span_missing" | "completion_marker_missing" | string | null;
}

export interface RunResult {
  run_id: string;
  experiment?: ExperimentDefinition;
  status: string;
  error_message?: string | null;
  /** Optional user annotation from Agent / RAG / LLM Evaluation. */
  label?: string | null;
  /** The manifest this run executed under; set only for a governed run. */
  run_manifest_id?: string | null;
  metric_results: MetricResult[];
  kpi_results: KpiResult[];
  verdict_status?: "conclusive" | "inconclusive" | "blocked" | null;
  overall_gate: GateResult | null;
  diagnostic_only?: boolean;
  evidence_readiness?: EvidenceReadinessResult | null;
  evidence_capture_status?: "complete" | "partial" | "not_captured" | "unknown";
  evidence_categories?: EvidenceCategorySummary[];
  root_cause: RootCauseDiagnosis | null;
  review_queue: ReviewQueueItem[];
  active_metrics: string[];
  started_at: string;
  completed_at: string | null;
  run_number?: number | null;
  run_type?: string;
  /** Present directly on in-flight run-list items; completed runs record it in lineage. */
  response_source?: "baseline" | "provided" | "agent" | "llm" | null;
  role?: string | null;
  experiment_version_id?: string | null;
  lineage?: RunLineageSnapshot | null;
  created_by?: string;
  /**
   * Governed-run lineage surfaced on the response. A run is *governed* only
   * when an approved quality profile / gate policy resolves it — a bare
   * `run_manifest_id` never makes a run governed. These stay `null` for
   * ungoverned runs.
   */
  quality_profile_id?: string | null;
  quality_profile_version?: string | null;
  gate_policy_id?: string | null;
  gate_policy_version?: string | null;
  /**
   * Backend-derived release eligibility. Never computed in the UI.
   * Present on completed run/report payloads; absent on in-flight job status.
   */
  release_eligibility?: ReleaseEligibility | null;
}

export interface ReleaseEligibility {
  status: "eligible" | "ineligible";
  code: string | null;
  message: string | null;
}

export interface ExperimentDecision {
  decision_id?: string;
  experiment_id: string;
  run_id: string;
  decision: "approved" | "rejected" | "approved_with_exception";
  reason?: string | null;
  approved_by: string;
  expires_at?: string | null;
  created_at?: string;
}

export interface ExperimentSummary {
  experiment: ExperimentDefinition;
  run_count: number;
  latest_run_id: string | null;
  latest_score: number | null;
  latest_gate: GateResult | null;
  latest_completed_at: string | null;
  baseline_run_id: string | null;
  champion_run_id: string | null;
  release_evidence_run_id: string | null;
  failed_kpis_latest: string[];
  latest_decision: ExperimentDecision | null;
  /** Named governance workspace vs auto-grouped lineage draft (#2671). */
  kind?: "experiment" | "draft";
}

/**
 * Offset-paged envelope for `GET /evaluation/experiments/workspaces` when
 * `limit`/`cursor` are passed (same convention as datasets and run history).
 * `total` is the unpaged count of listed workspaces + drafts.
 */
export interface ExperimentWorkspacePage {
  items: ExperimentSummary[];
  total: number;
  limit: number;
  offset: number;
  next_cursor: string | null;
}

/**
 * Audit record for a single baseline promotion or undo, mirroring the backend's
 * `BaselineChange` model. Returned by the audited baseline endpoints.
 */
export interface BaselineChange {
  baseline_change_id: string;
  experiment_id: string;
  tenant_id: string | null;
  actor: string;
  action: "promote" | "undo";
  previous_baseline_run_id: string | null;
  new_baseline_run_id: string | null;
  created_at: string;
}

export interface RunComparison {
  experiment_id: string;
  base_run_id: string;
  candidate_run_id: string;
  base_gate: GateResult;
  candidate_gate: GateResult;
  kpi_deltas: Array<{
    kpi_id: string;
    base_score: number | null;
    candidate_score: number | null;
    delta: number | null;
    base_gate: string | null;
    candidate_gate: string | null;
  }>;
  sample_deltas: Array<{
    row_id: string;
    base_score: number | null;
    candidate_score: number | null;
    delta: number | null;
    result: "improved" | "regressed" | "same" | "unavailable";
  }>;
  /** Operational measurements compared on their captured values.
   *
   *  These carry no verdict and so no normalised score, which is why
   *  `sample_deltas` leaves them out entirely — and why "did this run cost
   *  more tokens than that one" had no answer. The delta is signed and
   *  deliberately unjudged: more tokens is a fact, not a failure. */
  measurement_deltas?: Array<{
    metric_id: string;
    base: number | null;
    candidate: number | null;
    delta: number | null;
    base_sample_size: number;
    candidate_sample_size: number;
  }>;
  base_quality_score: number | null;
  candidate_quality_score: number | null;
  quality_delta: number | null;
  base_latency_ms: number | null;
  candidate_latency_ms: number | null;
  latency_delta_percent: number | null;
  sample_counts: { improved: number; regressed: number; same: number; unavailable: number };
  metric_failures: { new: string[]; fixed: string[]; persistent: string[] };
  metadata_diff: Record<string, { base: unknown; candidate: unknown }>;
}

/** Async run/generate job status returned while pending/running/failed. */
export interface JobStatus {
  run_id?: string;
  job_id?: string;
  status: string;
  error_message?: string | null;
  completed_at?: string | null;
  dataset_name?: string;
  agent?: string | null;
  label?: string | null;
  evaluation_name?: string | null;
  judge_model?: string | null;
  response_source?: "baseline" | "provided" | "agent" | "llm" | null;
  target_endpoint?: string | null;
  target_model?: string | null;
  active_metrics?: string[];
  resolved_active_metrics?: string[];
  run_configuration_hash?: string | null;
  scenario?: string | null;
  dataset_version?: string | null;
  evaluation_scope?: EvaluationScope | null;
  selected_tool_ids?: string[] | null;
  evidence_readiness?: EvidenceReadinessResult | null;
}

/** Immutable form-facing inputs recorded when an evaluation run was launched. */
/** One day (or the window total) of evaluation activity for the usage dashboard. */
export interface UsageBucket {
  runs: number;
  failed_runs: number;
  cases: number;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms_p50: number | null;
  latency_ms_p90: number | null;
  /** List-rate estimate over priceable cases; null when nothing could be priced. */
  estimated_cost_usd: number | null;
  unpriced_cases: number;
  /** Cases that carried no token measurements at all — counted, never zeroed in. */
  cases_without_usage: number;
  prompt_measured_cases: number;
  completion_measured_cases: number;
}

export interface UsageDay extends UsageBucket {
  /** ISO date for day buckets, `YYYY-MM-DDTHH:00` for hour buckets. */
  date: string;
}

export interface UsageTopModelRow {
  name: string;
  runs: number;
  cases: number;
  tokens: number;
  /** Cases the rate book could not price — disclosed beside the estimate. */
  unpriced_cases: number;
  estimated_cost_usd: number | null;
}

/** Dataset/agent rows count launch ATTEMPTS (any status) — a different denominator from completed runs. */
export interface UsageTopRow {
  name: string;
  attempts: number;
  failed_attempts: number;
}

export interface UsageTopList<Row> {
  rows: Row[];
  /** How many entries fell below the top-N cut — shown, never silently dropped. */
  others: number;
}

export interface UsageRunLink {
  run_id: string;
  name: string;
  dataset: string;
  model: string | null;
  status: string;
  started_at: string;
}

export interface UsageOverview {
  window: string;
  window_days: number;
  bucket: "hour" | "day";
  target_model: string | null;
  models: string[];
  totals: UsageBucket;
  /** Same aggregation over the equal-length period before the window; deltas compare against it. */
  previous_totals: UsageBucket;
  recent_runs: UsageRunLink[];
  failed_launches: UsageRunLink[];
  days: UsageDay[];
  /** Breakdowns follow the same model and time filters as the totals. */
  top_models: UsageTopList<UsageTopModelRow>;
  top_datasets: UsageTopList<UsageTopRow>;
  top_agents: UsageTopList<UsageTopRow>;
}

export interface RunConfigurationSnapshot {
  span_scoring_counts?: Record<string, number>;
  span_scoring_enabled?: boolean;
  run_id: string;
  dataset_name: string;
  response_source: "baseline" | "provided" | "agent" | "llm";
  agent?: string | null;
  evaluation_name?: string | null;
  label?: string | null;
  judge_model?: string | null;
  target_endpoint?: string | null;
  target_model?: string | null;
  system_prompt?: string | null;
  prompt_version_ref?: string | null;
  active_metrics: string[];
  enable_llm_judge: boolean;
  parallel_requests: number;
  run_human_review: boolean;
  quality_contract_ids: string[];
  evaluation_scope: EvaluationScope;
  selected_tool_ids?: string[] | null;
  project_id?: string | null;
  assignment_id?: string | null;
  assignment_version?: string | null;
  run_manifest_id?: string | null;
  /** Whether the server can resolve a chat-completions base URL for this
   *  run's target — the one replay-eligibility fact a client cannot compute.
   *  Absent on older backends. */
  llm_endpoint_resolvable?: boolean;
}

/** One-case re-invocation with a different prompt (#3317). Exactly one of
 *  the two fields is supplied. */
export interface ReplayCaseRequest {
  prompt_version_ref?: string | null;
  system_prompt?: string | null;
}

/** Isolated replay evidence for one case — never part of the run's results. */
export interface CaseReplay {
  replay_id: string;
  tenant_id: string;
  run_id: string;
  example_id: string;
  prompt_version_ref: string | null;
  prompt_hash: string | null;
  system_prompt: string | null;
  target_model: string;
  target_endpoint: string | null;
  response: string | null;
  latency_ms: number | null;
  target_usage: Record<string, unknown> | null;
  invocation_error: string | null;
  invocation_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  created_at: string;
  created_by: string;
  /** List-rate estimate computed at read time; null when the model is not priceable. */
  estimated_cost_usd: number | null;
}

export interface DatasetRunRequest {
  /** Every label on the run. `label` remains the first entry so existing readers
   *  of a single label are unaffected. */
  labels?: string[];
  /** User-facing name used to group related runs in Experiments and Runs. */
  evaluation_name?: string | null;
  /** Optional user annotation shown with one execution in Runs. */
  label?: string | null;
  /** Back-compat alias for ``label``. */
  name?: string | null;
  response_source?: "baseline" | "provided" | "agent" | "llm";
  agent?: string | null;
  target_endpoint?: string | null;
  target_model?: string | null;
  judge_model?: string | null;
  row_count?: number | null;
  active_metrics?: string[];
  /** A system prompt sent ahead of the row's question. */
  system_prompt?: string | null;
  /** `prompt-id@version` or `prompt-id@label` from the prompt library. */
  prompt_version_ref?: string | null;
  enable_llm_judge?: boolean;
  parallel_requests?: number;
  run_human_review?: boolean;
  quality_contract_ids?: string[];
  evaluation_scope?: EvaluationScope;
  /**
   * Selected-tools level: evaluate ONLY these named tools. Only meaningful
   * with evaluation_scope "tool_interactions" (any other depth is a 422); the
   * ids must be a subset of the agent's declared tools. null = whole tool layer.
   */
  selected_tool_ids?: string[] | null;
  project_id?: string | null;
  assignment_id?: string | null;
  assignment_version?: string | null;
}

export type LlmSource = "openai" | "ollama" | "compass" | "custom";

export type ModelProviderId = "openai" | "ollama";
export interface ModelProviderStatus {
  id: ModelProviderId;
  name: string;
  /** Successful model catalog read; does not claim a generation was completed. */
  connected: boolean;
  models: LlmCatalogEntry[];
  message?: string | null;
}
export interface ModelProvidersStatus {
  providers: ModelProviderStatus[];
  default: { provider: ModelProviderId; model_id: string; endpoint: string } | null;
}

export interface LlmCatalogEntry {
  model_id: string;
  name: string;
  source: LlmSource;
  description?: string | null;
  endpoint?: string | null;
  target_version_id?: string | null;
  created_at?: string | null;
}

export interface CustomLlmOnboardRequest {
  model_id: string;
  name?: string | null;
  endpoint: string;
  description?: string | null;
}

export interface ToolServer {
  name: string;
  namespace: string;
  url: string;
  tools: string[];
}

/**
 * Role-derived actions the current caller may perform, from
 * `GET /platform/capabilities`. Honest capability discovery: an action is
 * `true` only when the corresponding write endpoint would accept the caller's
 * roles, so the UI hides affordances instead of rendering-then-403.
 */
export interface PlatformCapabilities {
  actions: {
    record_release_decision?: boolean;
    /** Saving a prompt version and moving a prompt label. */
    manage_prompts?: boolean;
    author_governance?: boolean;
    approve_governance?: boolean;
    [action: string]: boolean | undefined;
  };
}

export interface MetricCatalogEntry {
  span_kinds?: string[];
  metric_id: string;
  name: string;
  description: string;
  scenario?: string | null;
  scoring_type?: string;
  requires_ground_truth?: boolean;
  score_range?: [number, number] | null;
  kpi_ids?: string[];
  default_adapter?: "native" | "deterministic" | "trace" | "ragas" | "deepeval" | "custom" | "mock";
  adapter_class?: string;
  requires_trace?: boolean;
  required_evidence_categories?: string[];
  execution_mode?: "inline" | "batch";
  available_in_run?: boolean;
  availability_note?: string | null;
  catalog_diagnostic_default?: boolean;
}

export interface SpanScoreSelection { trace_id: string; span_id: string; expected_response?: string | null }
export interface SpanScorePreview {
  preview_hash: string;
  items: Array<{ trace_id: string; span_id: string; name: string; span_kind: string | null;
    input: string; output: string; context?: string[]; expected_response: string | null;
    checks: Array<{ metric_id: string; name: string; description: string; available: boolean; unavailable_reason: string | null; scoring_type: string }> }>;
}
export interface SpanScoreJob {
  job_id: string; status: string; error: string | null; span_count: number; metric_ids: string[];
  results: Array<{ trace_id: string; span_id: string; metric_id: string; score: number | null;
    normalised_score: number | null; threshold_result: string | null; metric_status: string | null;
    rationale: string | null; error_message: string | null; judge_model: string | null; executed_scorer: string | null }>;
}
