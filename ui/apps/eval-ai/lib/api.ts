import type { SpanScoreSelection, SpanScorePreview, SpanScoreJob } from "@/lib/api-types";
// Browser-side client for the Proofgrove backend, via the server BFF proxy
// (/api/proofgrove/*). Never calls the backend directly.

import { sessionAwareFetch } from "@evalai/shared/session";
import {
  ApiError,
  apiErrorFromResponse,
} from "@/lib/api-errors";
import type {
  AgentSummary,
  BaselineChange,
  CapturedTraceDetail,
  CapturedTraceSpans,
  CapturedTraceSummary,
  CapturedTracesPage,
  CsvTemplate,
  CustomLlmOnboardRequest,
  DatasetInfo,
  DatasetPage,
  DatasetPageQuery,
  DatasetRecord,
  DatasetRecordsPage,
  DatasetRunRequest,
  DatasetStats,
  EvaluationAssignmentVersion,
  EvaluationProject,
  EvaluationScope,
  EvidenceReadinessResult,
  ExperimentDecision,
  ExperimentDefinition,
  ExperimentSummary,
  ExperimentWorkspacePage,
  Finding,
  JudgeAgreement,
  GenerateRequest,
  IndexedSpansPage,
  JobStatus,
  LlmCatalogEntry,
  ModelProviderId,
  ModelProvidersStatus,
  MetricCatalogEntry,
  PlatformCapabilities,
  PromoteRunItemRequest,
  PromoteRunItemResult,
  PromptPage,
  PromptVersion,
  QualityContractTemplate,
  QualityProfileVersion,
  CaseReplay,
  RegressionCase,
  ReplayCaseRequest,
  ReleaseGatePolicyVersion,
  Remediation,
  ResolvedRunManifest,
  ReviewDecisionRecord,
  ReviewTask,
  RunComparison,
  RunConfigurationSnapshot,
  UsageOverview,
  RunItemDetail,
  RunItemSummary,
  RunItemTraceEvidence,
  RunResult,
  TargetVersion,
  ToolResultArtifactPage,
  ToolServer,
  TraceInvocationOutcome,
  TraceProject,
  ValidationResult,
  WriteExpectedToolsRequest,
  WriteExpectedToolsResult,
} from "@/lib/api-types";

// Every payload type lives in ./api-types; re-exported so `@/lib/api` stays the one
// import site for callers.
export type * from "@/lib/api-types";

const BASE = "/api/proofgrove";

export const spanScoringApi = {
  preview: (project: string, tenant: string, spans: SpanScoreSelection[]) => request<SpanScorePreview>(
    `/tracing/projects/${encodeURIComponent(project)}/span-scoring/preview?tenant_id=${encodeURIComponent(tenant)}`,
    { method: "POST", body: JSON.stringify({ spans }) }),
  start: (project: string, tenant: string, body: { spans: SpanScoreSelection[]; request_id: string; preview_hash: string; metric_ids: string[]; judge_model: string }) => request<SpanScoreJob>(
    `/tracing/projects/${encodeURIComponent(project)}/span-scoring?tenant_id=${encodeURIComponent(tenant)}`,
    { method: "POST", body: JSON.stringify(body) }),
  job: (project: string, tenant: string, id: string) => request<SpanScoreJob>(
    `/tracing/projects/${encodeURIComponent(project)}/span-scoring/${encodeURIComponent(id)}?tenant_id=${encodeURIComponent(tenant)}`),
  history: (project: string, tenant: string, trace: string, span: string) => request<{ jobs: SpanScoreJob[]; limit: number }>(
    `/tracing/projects/${encodeURIComponent(project)}/traces/${encodeURIComponent(trace)}/spans/${encodeURIComponent(span)}/scores?tenant_id=${encodeURIComponent(tenant)}`),
};

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  headers.set("Accept", "application/json");
  if (opts.body && !(opts.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await sessionAwareFetch(`${BASE}${path}`, {
      ...opts,
      cache: "no-store",
      headers,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: "Unable to reach Proofgrove. Check your connection and try again.",
    });
  }

  if (!res.ok) {
    throw apiErrorFromResponse(res.status, await res.text());
  }
  if (res.status === 204) return {} as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError({
      status: 502,
      code: "INVALID_RESPONSE",
      message: "Proofgrove returned an invalid response. Try again shortly.",
    });
  }
}

/* ── Dataset types ─────────────────────────────────────────────── */

export function fullName(ds: DatasetInfo): string {
  return ds.name ?? ds.dataset_name ?? "";
}

/* ── Agent discovery ───────────────────────────────────────────── */

/* ── Evaluation types ──────────────────────────────────────────── */

/* ── API ───────────────────────────────────────────────────────── */

export const api = {
  listDatasets: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return request<DatasetInfo[]>(`/datasets${qs}`);
  },

  // Server-paged dataset list. `total` is the honest tenant-wide match count;
  // pass `next_cursor` back as `cursor` to fetch the next page.
  getDatasetStats: (params?: { tenant_id?: string; product_id?: string }) => {
    const qs = new URLSearchParams();
    if (params?.tenant_id) qs.set("tenant_id", params.tenant_id);
    if (params?.product_id) qs.set("product_id", params.product_id);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<DatasetStats>(`/datasets/stats${suffix}`);
  },

  listDatasetsPage: (opts: DatasetPageQuery) => {
    const qs = new URLSearchParams({ limit: String(opts.limit) });
    if (opts.offset) qs.set("offset", String(opts.offset));
    if (opts.cursor) qs.set("cursor", opts.cursor);
    if (opts.status) qs.set("status", opts.status);
    // Same scope the status chips read from GET /datasets/stats, so `total`
    // and the chip counts can never describe different populations.
    if (opts.tenant_id) qs.set("tenant_id", opts.tenant_id);
    return request<DatasetPage>(`/datasets?${qs.toString()}`);
  },

  getDataset: (name: string) => request<DatasetInfo>(`/datasets/${encodeURIComponent(name)}`),

  getRecords: (name: string) =>
    request<DatasetRecord[]>(`/datasets/${encodeURIComponent(name)}/records`),

  // Server-paged dataset records. Unknown datasets are a 404 (never a fake
  // empty page); `total` is the honest record count for "Showing N of M".
  getRecordsPage: (name: string, opts: Omit<DatasetPageQuery, "status">) => {
    const qs = new URLSearchParams({ limit: String(opts.limit) });
    if (opts.offset) qs.set("offset", String(opts.offset));
    if (opts.cursor) qs.set("cursor", opts.cursor);
    return request<DatasetRecordsPage>(
      `/datasets/${encodeURIComponent(name)}/records?${qs.toString()}`,
    );
  },

  csvTemplate: () => request<CsvTemplate>("/datasets/csv-template"),

  uploadCsv: async (name: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await sessionAwareFetch(
      `${BASE}/datasets/${encodeURIComponent(name)}/upload-csv`,
      {
        method: "POST",
        body: form,
        cache: "no-store",
        headers: { Accept: "application/json" },
      },
    );
    if (!res.ok) {
      throw apiErrorFromResponse(res.status, await res.text());
    }
    return res.json() as Promise<{ merged: number; dataset_name: string; source: string }>;
  },

  createDataset: (body: {
    csv_content?: string;
    dataset_name: string;
    tenant_id: string;
    product_id: string;
    created_by: string;
  }) => request<DatasetInfo>("/datasets", { method: "POST", body: JSON.stringify(body) }),

  createVersion: (
    sourceName: string,
    body: {
      source_dataset_name: string;
      new_dataset_name: string;
      change_reason: string;
      created_by: string;
    },
  ) =>
    request<DatasetInfo>(`/datasets/${encodeURIComponent(sourceName)}/versions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  restoreDataset: (name: string, createdBy: string) =>
    request<DatasetInfo>(`/datasets/${encodeURIComponent(name)}/restore`, {
      method: "POST",
      body: JSON.stringify({ created_by: createdBy }),
    }),

  writeExpectedTools: (name: string, body: WriteExpectedToolsRequest) =>
    request<WriteExpectedToolsResult>(
      `/datasets/${encodeURIComponent(name)}/expected-tools`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  promoteRunItem: (name: string, body: PromoteRunItemRequest) =>
    request<PromoteRunItemResult>(
      `/datasets/${encodeURIComponent(name)}/promotions`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  mergeRecords: (name: string, records: DatasetRecord[]) =>
    request<{ merged: number; dataset_name: string }>(
      `/datasets/${encodeURIComponent(name)}/records`,
      { method: "POST", body: JSON.stringify({ records }) },
    ),

  tenant: () => request<{ tenant_id: string }>("/tenant"),

  listTraceProjects: (tenantId: string) =>
    request<TraceProject[]>(`/tracing/projects?tenant_id=${encodeURIComponent(tenantId)}`),

  listProjectTraces: (projectId: string, tenantId: string, limit = 50, offset = 0) =>
    request<CapturedTraceSummary[]>(
      `/tracing/projects/${encodeURIComponent(projectId)}/traces?tenant_id=${encodeURIComponent(tenantId)}&limit=${limit}&offset=${offset}`,
    ),

  // Keyset-paged traces list. Stable cursor paging: pass the previous page's
  // `next_cursor` to advance. `total` is the honest distinct-trace count.
  listProjectTracesPage: (
    projectId: string,
    tenantId: string,
    options: {
      limit?: number;
      cursor?: string | null;
      /** Case-insensitive substring over trace id / evaluation name / example id. */
      search?: string;
      /** Exact evaluation run id. */
      runId?: string;
      /** Invocation outcome filter, applied server-side. */
      status?: TraceInvocationOutcome;
      /** Inclusive ISO datetime bounds on the captured-at sort key. */
      since?: string;
      until?: string;
      includeHidden?: boolean;
    } = {},
  ) => {
    const { limit = 50, cursor = null, search, runId, status, since, until, includeHidden } = options;
    const query = new URLSearchParams({ tenant_id: tenantId, limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    const trimmedSearch = search?.trim();
    if (trimmedSearch) query.set("search", trimmedSearch);
    const trimmedRunId = runId?.trim();
    if (trimmedRunId) query.set("run_id", trimmedRunId);
    if (status) query.set("status", status);
    if (since) query.set("since", since);
    if (until) query.set("until", until);
    if (includeHidden) query.set("include_hidden", "true");
    return request<CapturedTracesPage>(
      `/tracing/projects/${encodeURIComponent(projectId)}/traces/page?${query.toString()}`,
    );
  },

  hideProjectTrace: (projectId: string, traceId: string, tenantId: string) =>
    request<{ trace_id: string; hidden: boolean }>(
      `/tracing/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}/hide?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: "POST" },
    ),

  unhideProjectTrace: (projectId: string, traceId: string, tenantId: string) =>
    request<{ trace_id: string; hidden: boolean }>(
      `/tracing/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}/unhide?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: "POST" },
    ),

  // Project-wide archived-span summaries from the collector-confirmed span
  // index (one row per span; payloads stay in the archive). Keyset paging like
  // listProjectTracesPage. Pass "unassigned" to list spans of traces without a
  // Project home.
  listProjectSpansPage: (
    projectId: string,
    tenantId: string,
    options: {
      limit?: number;
      cursor?: string | null;
      /** Case-insensitive substring over span name / trace id. */
      search?: string;
      /** Archived OTLP status filter. */
      status?: "ok" | "error" | "unset";
      since?: string;
      until?: string;
    } = {},
  ) => {
    const { limit = 50, cursor = null, search, status, since, until } = options;
    const query = new URLSearchParams({ tenant_id: tenantId, limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    const trimmedSearch = search?.trim();
    if (trimmedSearch) query.set("search", trimmedSearch);
    if (status) query.set("status", status);
    if (since) query.set("since", since);
    if (until) query.set("until", until);
    return request<IndexedSpansPage>(
      `/tracing/projects/${encodeURIComponent(projectId)}/spans/page?${query.toString()}`,
    );
  },

  // Deprecated: fetches summary and spans together, so an archive outage 503s
  // the whole trace page. Prefer getProjectTraceSummary + getProjectTraceSpans.
  getProjectTrace: (projectId: string, traceId: string, tenantId: string) =>
    request<CapturedTraceDetail>(
      `/tracing/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}?tenant_id=${encodeURIComponent(tenantId)}`,
    ),

  // Header/summary/scores source. Never reads the archive, so it cannot 503.
  getProjectTraceSummary: (projectId: string, traceId: string, tenantId: string) =>
    request<CapturedTraceDetail>(
      `/tracing/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}/summary?tenant_id=${encodeURIComponent(tenantId)}`,
    ),

  // Archived spans only. May 503 alone when the span archive is unavailable.
  getProjectTraceSpans: (projectId: string, traceId: string, tenantId: string) =>
    request<CapturedTraceSpans>(
      `/tracing/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}/spans?tenant_id=${encodeURIComponent(tenantId)}`,
    ),

  generate: (body: GenerateRequest) =>
    request<JobStatus>("/datasets/generate", { method: "POST", body: JSON.stringify(body) }),

  validate: (name: string) =>
    request<ValidationResult>(`/datasets/${encodeURIComponent(name)}/validate`, { method: "POST" }),

  approve: (name: string, approved_by: string) =>
    request<DatasetInfo>(`/datasets/${encodeURIComponent(name)}/approve`, {
      method: "POST",
      body: JSON.stringify({ approved_by }),
    }),

  reject: (name: string, decidedBy: string, note?: string) =>
    request<DatasetInfo>(`/datasets/${encodeURIComponent(name)}/reject`, {
      method: "POST",
      body: JSON.stringify({ decided_by: decidedBy, note: note || null }),
    }),

  reopen: (name: string, decidedBy: string) =>
    request<DatasetInfo>(`/datasets/${encodeURIComponent(name)}/reopen`, {
      method: "POST",
      body: JSON.stringify({ decided_by: decidedBy }),
    }),

  publish: (name: string) =>
    request<DatasetInfo>(`/datasets/${encodeURIComponent(name)}/publish`, { method: "POST" }),

  deprecate: (name: string) =>
    request<DatasetInfo>(`/datasets/${encodeURIComponent(name)}/deprecate`, { method: "POST" }),

  retire: (name: string) =>
    request<DatasetInfo>(`/datasets/${encodeURIComponent(name)}/retire`, { method: "POST" }),

  deleteDataset: (name: string) =>
    request<void>(`/datasets/${encodeURIComponent(name)}`, { method: "DELETE" }),

  getHistory: (name: string) =>
    request<Record<string, unknown>[]>(`/datasets/${encodeURIComponent(name)}/history`),
};

export const agentsApi = {
  list: (readyOnly = false) =>
    request<AgentSummary[]>(`/agents${readyOnly ? "?ready_only=true" : ""}`),

  toolServers: () => request<ToolServer[]>("/agents/mcp-servers"),

  catalog: () => request<TargetVersion[]>("/agents/catalog"),

  invokeLocal: (agentRef: string, query: string) =>
    request<{ response: string; tool_calls: unknown[]; invocation_id: string; trace_id: string; model: string }>(
      `/agents/local/${encodeURIComponent(agentRef.replace(/^local:/, ""))}/invoke`,
      { method: "POST", body: JSON.stringify({ query }) },
    ),

  testAndOnboard: (endpoint: string) =>
    request<TargetVersion>("/agents/catalog", {
      method: "POST",
      body: JSON.stringify({ endpoint }),
    }),
};

export const platformApi = {
  /** Actions the calling identity may perform, derived from its roles. */
  capabilities: (tenantId?: string) =>
    request<PlatformCapabilities>(
      `/platform/capabilities${tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : ""}`,
    ),

  listQualityContractTemplates: () =>
    request<QualityContractTemplate[]>("/platform/quality-contract-templates"),

  instantiateQualityContractTemplate: (
    templateId: string,
    body: {
      tenant_id: string;
      project_id?: string;
      profile_id?: string;
      version?: string;
      name?: string;
      description?: string;
      created_by?: string;
    },
  ) =>
    request<QualityProfileVersion>(
      `/platform/quality-contract-templates/${encodeURIComponent(templateId)}/instantiate`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  listProjects: (tenantId: string) =>
    request<EvaluationProject[]>(`/platform/projects?tenant_id=${encodeURIComponent(tenantId)}`),

  createProject: (body: EvaluationProject) =>
    request<EvaluationProject>("/platform/projects", { method: "POST", body: JSON.stringify(body) }),

  archiveProject: (projectId: string, tenantId: string) =>
    request<EvaluationProject>(
      `/platform/projects/${encodeURIComponent(projectId)}/archive?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: "POST" },
    ),

  restoreProject: (projectId: string, tenantId: string) =>
    request<EvaluationProject>(
      `/platform/projects/${encodeURIComponent(projectId)}/restore?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: "POST" },
    ),

  /** Permanent. Removes the Project and its captured trace index rows; archived
   *  span payloads are not pruned per Project and age out under archive retention. */
  deleteProject: (projectId: string, tenantId: string) =>
    request<{ project_id: string; deleted_traces: number }>(
      `/platform/projects/${encodeURIComponent(projectId)}?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: "DELETE" },
    ),

  listTargetVersions: (projectId: string, tenantId: string) =>
    request<TargetVersion[]>(
      `/platform/projects/${encodeURIComponent(projectId)}/target-versions?tenant_id=${encodeURIComponent(tenantId)}`,
    ),

  createTargetVersion: (projectId: string, body: TargetVersion) =>
    request<TargetVersion>(`/platform/projects/${encodeURIComponent(projectId)}/target-versions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listPrompts: (promptId?: string, includeArchived = false) =>
    request<PromptVersion[]>(
      `/platform/prompts?${new URLSearchParams({ ...(promptId ? { prompt_id: promptId } : {}), ...(includeArchived ? { include_archived: "true" } : {}) })}`,
    ),

  /**
   * One page of whole prompts, newest version first within each. Paging is by
   * prompt rather than by version so a prompt is never split across pages.
   */
  listPromptPage: (limit: number, cursor?: string | null) => {
    const query = new URLSearchParams({ limit: String(limit), paginate_by: "prompt" });
    if (cursor) query.set("cursor", cursor);
    return request<PromptPage>(`/platform/prompts?${query.toString()}`);
  },

  /** Saves the next version; the version number is allocated server-side. */
  savePrompt: (body: {
    tenant_id: string;
    prompt_id: string;
    name: string;
    content: string;
    description?: string;
  }) =>
    request<PromptVersion>("/platform/prompts", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Points a label at a version. Moving it back is how a rollback happens. */
  movePromptLabel: (promptId: string, label: string, body: { tenant_id: string; version: number }) =>
    request<PromptVersion>(
      `/platform/prompts/${encodeURIComponent(promptId)}/labels/${encodeURIComponent(label)}`,
      { method: "PUT", body: JSON.stringify(body) },
    ),

  /**
   * Retires a version. Deliberately not a delete — runs cite `prompt-id@version`
   * and an exact rerun replays it, so the row has to outlive its usefulness.
   */
  archivePromptVersion: (promptId: string, version: number, tenantId: string) =>
    request<PromptVersion>(
      `/platform/prompts/${encodeURIComponent(promptId)}/versions/${version}?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: "DELETE" },
    ),

  listProfiles: (tenantId: string, projectId?: string) => {
    const query = new URLSearchParams({ tenant_id: tenantId });
    if (projectId) query.set("project_id", projectId);
    return request<QualityProfileVersion[]>(`/platform/quality-profiles?${query.toString()}`);
  },

  createProfile: (body: QualityProfileVersion) =>
    request<QualityProfileVersion>("/platform/quality-profiles", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  transitionProfile: (profileId: string, version: string, tenantId: string, action: "validate" | "approve" | "retire" | "reinstate") =>
    request<QualityProfileVersion>(
      `/platform/quality-profiles/${encodeURIComponent(profileId)}/versions/${encodeURIComponent(version)}/${action}?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: "POST" },
    ),

  markProfileTested: (
    profileId: string,
    version: string,
    tenantId: string,
    body: { mode: "tested" | "overridden"; note?: string; source_run_id?: string; dataset_name?: string },
  ) =>
    request<QualityProfileVersion>(
      `/platform/quality-profiles/${encodeURIComponent(profileId)}/versions/${encodeURIComponent(version)}/mark-tested?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  listGatePolicies: (tenantId: string) =>
    request<ReleaseGatePolicyVersion[]>(`/platform/gate-policies?tenant_id=${encodeURIComponent(tenantId)}`),

  createGatePolicy: (body: ReleaseGatePolicyVersion) =>
    request<ReleaseGatePolicyVersion>("/platform/gate-policies", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  transitionGatePolicy: (policyId: string, version: string, tenantId: string, action: "validate" | "approve" | "retire" | "reinstate") =>
    request<ReleaseGatePolicyVersion>(
      `/platform/gate-policies/${encodeURIComponent(policyId)}/versions/${encodeURIComponent(version)}/${action}?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: "POST" },
    ),

  resolveManifest: (body: {
    tenant_id: string;
    project_id: string;
    target_version_id: string;
    profile_id: string;
    profile_version: string;
    gate_policy_id?: string;
    gate_policy_version?: string;
    benchmark_package_id?: string;
    benchmark_package_version?: string;
    benchmark_family?: string;
    judge_config?: Record<string, unknown>;
    evaluation_scope?: EvaluationScope;
    resolved_by?: string;
  }) => request<ResolvedRunManifest>("/platform/run-manifests", { method: "POST", body: JSON.stringify(body) }),

  getManifest: (manifestId: string, tenantId: string) =>
    request<ResolvedRunManifest>(
      `/platform/run-manifests/${encodeURIComponent(manifestId)}?tenant_id=${encodeURIComponent(tenantId)}`,
    ),

  listManifests: (tenantId: string, projectId?: string) => {
    const query = new URLSearchParams({ tenant_id: tenantId });
    if (projectId) query.set("project_id", projectId);
    return request<ResolvedRunManifest[]>(`/platform/run-manifests?${query.toString()}`);
  },

  archiveManifest: (manifestId: string, tenantId: string) =>
    request<{ manifest_id: string; archived: boolean }>(
      `/platform/run-manifests/${encodeURIComponent(manifestId)}/archive?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: "POST" },
    ),

  bindManifest: (experimentId: string, manifestId: string) =>
    request<ExperimentDefinition>(`/platform/experiments/${encodeURIComponent(experimentId)}/run-manifest`, {
      method: "POST",
      body: JSON.stringify({ manifest_id: manifestId }),
    }),

  listAssignments: (
    tenantId: string,
    query: {
      projectId?: string;
      targetVersionId?: string;
      assignmentId?: string;
      q?: string;
      includeArchived?: boolean;
    } = {},
  ) => {
    const params = new URLSearchParams({ tenant_id: tenantId });
    if (query.projectId) params.set("project_id", query.projectId);
    if (query.targetVersionId) params.set("target_version_id", query.targetVersionId);
    if (query.assignmentId) params.set("assignment_id", query.assignmentId);
    if (query.q) params.set("q", query.q);
    if (query.includeArchived) params.set("include_archived", "true");
    return request<EvaluationAssignmentVersion[]>(`/platform/assignments?${params.toString()}`);
  },

  createAssignment: (body: Record<string, unknown>) =>
    request<EvaluationAssignmentVersion>("/platform/assignments", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getAssignment: (assignmentId: string, version: string, tenantId: string, includeManifest = false) => {
    const params = new URLSearchParams({ tenant_id: tenantId });
    if (includeManifest) params.set("include_manifest", "true");
    return request<EvaluationAssignmentVersion>(
      `/platform/assignments/${encodeURIComponent(assignmentId)}/versions/${encodeURIComponent(version)}?${params.toString()}`,
    );
  },

  archiveAssignment: (assignmentId: string, version: string, tenantId: string) =>
    request<EvaluationAssignmentVersion>(
      `/platform/assignments/${encodeURIComponent(assignmentId)}/versions/${encodeURIComponent(version)}/archive?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: "POST" },
    ),

  restoreAssignment: (assignmentId: string, version: string, tenantId: string) =>
    request<EvaluationAssignmentVersion>(
      `/platform/assignments/${encodeURIComponent(assignmentId)}/versions/${encodeURIComponent(version)}/restore?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: "POST" },
    ),

  /** How often reviewers agreed with the judge, per metric. Aggregate counts
   *  only — never a reviewer, a rationale or a case. */
  judgeAgreement: (tenantId: string, projectId?: string) => {
    const query = new URLSearchParams({ tenant_id: tenantId });
    if (projectId) query.set("project_id", projectId);
    return request<JudgeAgreement[]>(`/platform/judge-agreement?${query.toString()}`);
  },

  /** Put one scored case in front of a reviewer, whether the judge passed or
   *  failed it. Records no verdict — the reviewer still decides normally.
   *
   *  No tenant argument: the server derives it from the run, because a tenant
   *  the caller supplies proves nothing about a run id the caller also supplied. */
  openCaseForReview: (body: { run_id: string; row_id: string; metric_id: string }) =>
    request<{ finding: Finding; created: boolean }>("/platform/review-cases", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listFindings: (tenantId: string, params: { run_id?: string; experiment_id?: string } = {}) => {
    const query = new URLSearchParams();
    if (tenantId.trim()) query.set("tenant_id", tenantId.trim());
    if (params.run_id) query.set("run_id", params.run_id);
    if (params.experiment_id) query.set("experiment_id", params.experiment_id);
    const suffix = query.toString();
    return request<Finding[]>(`/platform/findings${suffix ? `?${suffix}` : ""}`);
  },

  listReviewTasks: (findingId: string) =>
    request<ReviewTask[]>(`/platform/findings/${encodeURIComponent(findingId)}/review-tasks`),

  listReviewDecisionHistory: (findingId: string) =>
    request<ReviewDecisionRecord[]>(
      `/platform/findings/${encodeURIComponent(findingId)}/review-decisions`,
    ),

  recordReviewDecision: (body: {
    finding_id: string;
    task_id: string;
    reviewer: string;
    outcome: "agree" | "disagree" | "abstain";
    rationale: string;
    severity?: Finding["severity"];
    root_cause_category?: string;
  }) => request<Record<string, unknown>>("/platform/review-decisions", { method: "POST", body: JSON.stringify(body) }),

  createRemediation: (findingId: string, body: {
    finding_id: string;
    owner: string;
    description: string;
    due_at?: string;
  }) => request<Remediation>(`/platform/findings/${encodeURIComponent(findingId)}/remediations`, { method: "POST", body: JSON.stringify(body) }),

  listRemediations: (findingId?: string) =>
    request<Remediation[]>(`/platform/remediations${findingId ? `?finding_id=${encodeURIComponent(findingId)}` : ""}`),

  updateRemediation: (remediationId: string, status: Remediation["status"]) =>
    request<Remediation>(`/platform/remediations/${encodeURIComponent(remediationId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  createWaiver: (findingId: string, body: {
    finding_id: string;
    approved_by: string;
    rationale: string;
    expires_at: string;
  }) => request<Record<string, unknown>>(
    `/platform/findings/${encodeURIComponent(findingId)}/waivers`,
    { method: "POST", body: JSON.stringify(body) },
  ),

  promoteRegression: (findingId: string, kind: "regression" | "holdout" = "regression") =>
    request<RegressionCase>(`/platform/findings/${encodeURIComponent(findingId)}/promote-regression`, {
      method: "POST",
      body: JSON.stringify({ kind }),
    }),

  listRegressions: (tenantId?: string) =>
    request<RegressionCase[]>(
      `/platform/regressions${tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : ""}`,
    ),

  replayRegression: (regressionCaseId: string, body: {
    experiment_id: string;
    created_by?: string;
    dry_run?: boolean;
    seed?: number;
  }) => request<RunResult>(
    `/platform/regressions/${encodeURIComponent(regressionCaseId)}/replay`,
    { method: "POST", body: JSON.stringify({ dry_run: true, ...body }) },
  ),
};

export const evaluationApi = {
  getModelProviders: () => request<ModelProvidersStatus>("/evaluation/model-providers"),
  connectOpenAI: (body: { api_key: string; allow_paid_calls: true }) =>
    request<ModelProvidersStatus>("/evaluation/model-providers/openai", {
      method: "POST", body: JSON.stringify(body),
    }),
  disconnectOpenAI: () => request<ModelProvidersStatus>("/evaluation/model-providers/openai", { method: "DELETE" }),
  setDefaultModel: (body: { provider: ModelProviderId; model_id: string }) =>
    request<ModelProvidersStatus>("/evaluation/model-providers/default", {
      method: "PUT", body: JSON.stringify(body),
    }),

  listMetrics: () => request<MetricCatalogEntry[]>("/evaluation/metrics"),

  getJudgeConfig: () =>
    request<{
      judge_mode: string;
      effective_mode: string;
      judge_provider: string;
      judge_model: string;
      base_url: string;
      has_api_key: boolean;
    }>("/evaluation/judge-config"),

  listJudgeModels: () =>
    request<{ provider: string; models: string[]; fallback: boolean }>(
      "/evaluation/judge-models",
    ),

  listLlmCatalog: () => request<LlmCatalogEntry[]>("/evaluation/llm-catalog"),

  onboardCustomLlm: (body: CustomLlmOnboardRequest) =>
    request<LlmCatalogEntry>("/evaluation/llm-catalog", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Runs that executed under one manifest, counted in SQL rather than a page slice. */
  listRunsForManifest: (tenantId: string, runManifestId: string) =>
    request<{ items: RunResult[]; total: number }>(
      `/evaluation/run-history?tenant_id=${encodeURIComponent(tenantId)}&run_manifest_id=${encodeURIComponent(runManifestId)}&limit=50`,
    ),
  listRuns: (tenantId: string) =>
    request<RunResult[]>(`/evaluation/runs?tenant_id=${encodeURIComponent(tenantId)}`),

  createRunFromDataset: (name: string, opts: DatasetRunRequest = {}) =>
    request<JobStatus>(`/evaluation/runs/from-dataset/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  getRunReadiness: (name: string, opts: DatasetRunRequest = {}) =>
    request<EvidenceReadinessResult>(
      `/evaluation/runs/from-dataset/${encodeURIComponent(name)}/readiness`,
      {
        method: "POST",
        body: JSON.stringify(opts),
      },
    ),

  getRun: (runId: string, tenantId: string) =>
    request<RunResult | JobStatus>(
      `/evaluation/runs/${encodeURIComponent(runId)}?tenant_id=${encodeURIComponent(tenantId)}`,
    ),

  getUsage: (tenantId: string, opts: { days?: number; window?: string; targetModel?: string | null } = {}) => {
    const query = new URLSearchParams({ tenant_id: tenantId });
    if (opts.window) query.set("window", opts.window);
    else if (opts.days) query.set("days", String(opts.days));
    if (opts.targetModel) query.set("target_model", opts.targetModel);
    return request<UsageOverview>(`/evaluation/usage?${query.toString()}`);
  },

  getRunConfiguration: (runId: string, tenantId: string) =>
    request<RunConfigurationSnapshot>(
      `/evaluation/runs/${encodeURIComponent(runId)}/configuration?tenant_id=${encodeURIComponent(tenantId)}`,
    ),

  cancelRun: (runId: string, tenantId: string) =>
    request<{ run_id: string; status: "cancelled" }>(
      `/evaluation/runs/${encodeURIComponent(runId)}/cancel?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: "POST" },
    ),

  listRunItems: (runId: string, tenantId: string) =>
    request<RunItemSummary[]>(
      `/evaluation/runs/${encodeURIComponent(runId)}/items?tenant_id=${encodeURIComponent(tenantId)}`,
    ),

  getRunItem: (runId: string, exampleId: string, tenantId: string) =>
    request<RunItemDetail>(
      `/evaluation/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(exampleId)}?tenant_id=${encodeURIComponent(tenantId)}`,
    ),

  replayRunItem: (runId: string, exampleId: string, tenantId: string, body: ReplayCaseRequest) =>
    request<CaseReplay>(
      `/evaluation/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(exampleId)}/replays?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  listRunItemReplays: (runId: string, exampleId: string, tenantId: string) =>
    request<CaseReplay[]>(
      `/evaluation/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(exampleId)}/replays?tenant_id=${encodeURIComponent(tenantId)}`,
    ),

  getRunItemTrace: (runId: string, exampleId: string, tenantId: string) =>
    request<RunItemTraceEvidence>(
      `/evaluation/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(exampleId)}/trace?tenant_id=${encodeURIComponent(tenantId)}`,
    ),

  getToolResultArtifact: (
    runId: string,
    exampleId: string,
    artifactId: string,
    tenantId: string,
    offset = 0,
  ) => {
    const query = new URLSearchParams({ tenant_id: tenantId, offset: String(offset) });
    return request<ToolResultArtifactPage>(
      `/evaluation/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(exampleId)}/artifacts/${encodeURIComponent(artifactId)}?${query.toString()}`,
    );
  },

  getReport: (runId: string, tenantId: string) =>
    request<Record<string, unknown>>(
      `/evaluation/runs/${encodeURIComponent(runId)}/report?tenant_id=${encodeURIComponent(tenantId)}`,
    ),

  listExperiments: () => request<ExperimentDefinition[]>("/evaluation/experiments"),

  listExperimentWorkspaces: (
    tenantId: string,
    opts: { includeDrafts?: boolean; archived?: boolean; query?: string; limit?: number; offset?: number } = {},
  ) => {
    const query = new URLSearchParams({
      tenant_id: tenantId,
      limit: String(opts.limit ?? 100),
    });
    if (opts.offset) query.set("offset", String(opts.offset));
    if (opts.includeDrafts) query.set("include_drafts", "true");
    if (opts.archived) query.set("archived", "true");
    if (opts.query?.trim()) query.set("q", opts.query.trim());
    return request<ExperimentWorkspacePage>(
      `/evaluation/experiments/workspaces?${query.toString()}`,
    );
  },

  createExperimentWorkspace: (body: {
    tenant_id: string;
    name: string;
    description?: string;
    objective?: string;
    hypothesis?: string;
    owner?: string;
    created_by?: string;
    tags?: Record<string, string>;
  }) =>
    request<ExperimentSummary>("/evaluation/experiments/workspaces", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  createExperimentFromRuns: (body: {
    tenant_id: string;
    name: string;
    run_ids: string[];
    baseline_run_id: string;
    description?: string;
    objective?: string;
    hypothesis?: string;
    owner?: string;
    created_by?: string;
  }) =>
    request<ExperimentSummary>("/evaluation/experiments/from-runs", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  attachExperimentRuns: (experimentId: string, tenantId: string, runIds: string[]) =>
    request<ExperimentSummary>(
      `/evaluation/experiments/${encodeURIComponent(experimentId)}/runs/attach`,
      {
        method: "POST",
        body: JSON.stringify({ tenant_id: tenantId, run_ids: runIds }),
      },
    ),

  /**
   * Partial update of a workspace's governance fields.
   *
   * `tags` REPLACES the non-reserved tag map rather than merging into it — the
   * backend rebuilds it as `{...incoming, ...reserved}`, so any existing tag
   * not re-sent here is dropped. Send the full desired map, and never name a
   * platform-reserved tag (that is a 422).
   */
  patchExperiment: (
    id: string,
    body: {
      tenant_id?: string;
      name?: string;
      description?: string;
      objective?: string;
      hypothesis?: string;
      owner?: string;
      status?: string;
      tags?: Record<string, string>;
    },
  ) =>
    request<ExperimentDefinition>(`/evaluation/experiments/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  getExperiment: (id: string) =>
    request<ExperimentDefinition>(`/evaluation/experiments/${encodeURIComponent(id)}`),

  getExperimentSummary: (id: string) =>
    request<ExperimentSummary>(`/evaluation/experiments/${encodeURIComponent(id)}/summary`),

  listExperimentRuns: (id: string) =>
    request<RunResult[]>(`/evaluation/experiments/${encodeURIComponent(id)}/runs`),

  createExperimentRun: (
    id: string,
    opts: { row_count?: number; run_type?: string; created_by?: string } = {},
  ) =>
    request<RunResult>(`/evaluation/experiments/${encodeURIComponent(id)}/runs`, {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  createExperimentRescore: (
    id: string,
    opts: { source_run_id: string; active_metrics?: string[]; judge_model?: string; created_by?: string },
  ) =>
    request<{ run_id: string; status: string; classification: "diagnostic_only"; source_run_id: string; target_invoked: false }>(
      `/evaluation/experiments/${encodeURIComponent(id)}/rescores`,
      { method: "POST", body: JSON.stringify(opts) },
    ),

  /**
   * Legacy role promotion (champion, release evidence, …). Baseline moves must
   * NOT use this — they go through {@link promoteBaseline} so every baseline
   * change lands in the audit trail.
   */
  promoteRun: (experimentId: string, runId: string, role: string) =>
    request<Record<string, unknown>>(
      `/evaluation/experiments/${encodeURIComponent(experimentId)}/runs/${encodeURIComponent(runId)}/promote`,
      { method: "POST", body: JSON.stringify({ role }) },
    ),

  /** Audited baseline promotion: records who changed the baseline, and from/to which run. */
  promoteBaseline: (experimentId: string, runId: string) =>
    request<BaselineChange>(
      `/evaluation/experiments/${encodeURIComponent(experimentId)}/baseline`,
      { method: "POST", body: JSON.stringify({ run_id: runId }) },
    ),

  /** Baseline-change audit trail for an experiment, newest first. */
  listBaselineHistory: (experimentId: string) =>
    request<BaselineChange[]>(
      `/evaluation/experiments/${encodeURIComponent(experimentId)}/baseline/history`,
    ),

  /** Revert the baseline to the previous run; the undo is itself audited. */
  undoBaseline: (experimentId: string) =>
    request<BaselineChange>(
      `/evaluation/experiments/${encodeURIComponent(experimentId)}/baseline/undo`,
      { method: "POST" },
    ),

  compareRuns: (
    experimentId: string,
    baseRunId: string,
    candidateRunId: string,
    tenantId: string,
    metricId?: string,
  ) =>
    request<RunComparison>(
      `/evaluation/experiments/${encodeURIComponent(experimentId)}/compare?base_run_id=${encodeURIComponent(baseRunId)}&candidate_run_id=${encodeURIComponent(candidateRunId)}&tenant_id=${encodeURIComponent(tenantId)}${metricId ? `&metric_id=${encodeURIComponent(metricId)}` : ""}`,
    ),

  createDecision: (
    experimentId: string,
    body: {
      run_id: string;
      decision: ExperimentDecision["decision"];
      approved_by: string;
      reason?: string;
    },
  ) =>
    request<ExperimentDecision>(
      `/evaluation/experiments/${encodeURIComponent(experimentId)}/decisions`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  listDecisions: (experimentId: string) =>
    request<ExperimentDecision[]>(
      `/evaluation/experiments/${encodeURIComponent(experimentId)}/decisions`,
    ),

  archiveExperiment: (id: string) =>
    request<ExperimentDefinition>(`/evaluation/experiments/${encodeURIComponent(id)}/archive`, {
      method: "POST",
    }),

  restoreExperiment: (id: string) =>
    request<ExperimentDefinition>(`/evaluation/experiments/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    }),
};
