import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EvaluationWorkbench } from "./workbench";
import { agentsApi, api, evaluationApi, platformApi, type AgentSummary } from "@/lib/api";
import { ApiError } from "@/lib/api-errors";

const entry = vi.hoisted(() => ({ query: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(entry.query),
  usePathname: () => "/evaluate",
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, listDatasetsPage: vi.fn(), tenant: vi.fn(), listTraceProjects: vi.fn(), getDataset: vi.fn() },
    agentsApi: { ...actual.agentsApi, list: vi.fn() },
    evaluationApi: { ...actual.evaluationApi, listMetrics: vi.fn(), listJudgeModels: vi.fn(), listLlmCatalog: vi.fn(), createRunFromDataset: vi.fn(), getRunReadiness: vi.fn() },
    platformApi: { ...actual.platformApi, listQualityContractTemplates: vi.fn(), listPrompts: vi.fn(), capabilities: vi.fn(), listAssignments: vi.fn() },
  };
});

const dataset = { dataset_name: "nova_refunds_golden_v1", version_number: 1, status: "PUBLISHED", record_count: 8, missing_row_fields: [] };

beforeEach(() => {
  vi.clearAllMocks();
  entry.query = "";
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const storage = () => {
    const items = new Map<string, string>();
    return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value), removeItem: (key: string) => items.delete(key), clear: () => items.clear() };
  };
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  vi.mocked(api.listDatasetsPage).mockResolvedValue({ items: [dataset], total: 1, next_cursor: null } as never);
  vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "tenant-local-classroom" } as never);
  vi.mocked(api.listTraceProjects).mockResolvedValue([]);
  vi.mocked(agentsApi.list).mockResolvedValue([]);
  vi.mocked(evaluationApi.listLlmCatalog).mockResolvedValue([]);
  vi.mocked(evaluationApi.listMetrics).mockResolvedValue([{ metric_id: "nlp.f1_score", name: "Token F1", description: "Text overlap", scoring_type: "deterministic", default_adapter: "deterministic" }] as never);
  vi.mocked(evaluationApi.listJudgeModels).mockResolvedValue({ models: [] } as never);
  vi.mocked(platformApi.listQualityContractTemplates).mockResolvedValue([]);
  vi.mocked(platformApi.listPrompts).mockResolvedValue([]);
  vi.mocked(platformApi.capabilities).mockResolvedValue({ actions: {} } as never);
  vi.mocked(platformApi.listAssignments).mockResolvedValue([]);
});

describe("evaluation setup source failures", () => {
  it("keeps successful datasets when agent discovery fails and provides a working retry", async () => {
    vi.mocked(agentsApi.list).mockRejectedValueOnce(new ApiError({ message: "Unavailable", status: 502, code: "UPSTREAM_UNAVAILABLE" }));
    render(<EvaluationWorkbench kind="agent" />);
    expect(await screen.findByRole("button", { name: "Choose dataset" })).toBeTruthy();
    expect(screen.getByText(/Agent catalog could not be loaded \(HTTP 502\)/)).toBeTruthy();
    expect(screen.queryByText(/No published datasets yet/)).toBeNull();
    expect(screen.queryByText(/No ready agents are available/)).toBeNull();
    expect(platformApi.listPrompts).toHaveBeenCalledOnce();
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    await waitFor(() => expect(screen.queryByText(/Agent catalog could not be loaded/)).toBeNull());
    expect(await screen.findByRole("button", { name: "Choose dataset" })).toBeTruthy();
    expect(agentsApi.list).toHaveBeenCalledTimes(2);
  });

  it("distinguishes an unreadable dataset catalog from a successfully empty catalog", async () => {
    vi.mocked(api.listDatasetsPage).mockRejectedValueOnce(new Error("Network down"));
    render(<EvaluationWorkbench kind="provided" />);
    expect(await screen.findByText(/Dataset availability could not be checked/)).toBeTruthy();
    expect(screen.queryByText(/No published datasets yet/)).toBeNull();
    vi.mocked(api.listDatasetsPage).mockResolvedValueOnce({ items: [], total: 0, next_cursor: null } as never);
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    expect(await screen.findByText(/No published datasets yet/)).toBeTruthy();
    expect(screen.queryByText(/Dataset availability could not be checked/)).toBeNull();
  });

  it("retains the last dataset page after a failed refresh and marks it as stale", async () => {
    render(<EvaluationWorkbench kind="provided" />);
    expect(await screen.findByRole("button", { name: "Choose dataset" })).toBeTruthy();
    vi.mocked(api.listDatasetsPage).mockRejectedValueOnce(new Error("Network down"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/Showing the last loaded datasets/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose dataset" })).toBeTruthy();
    expect(screen.queryByText(/No published datasets yet/)).toBeNull();
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });

  it("keeps datasets and prompt inventory available during a model catalog failure", async () => {
    vi.mocked(evaluationApi.listLlmCatalog).mockRejectedValueOnce(new Error("Unavailable"));
    render(<EvaluationWorkbench kind="llm" />);
    expect(await screen.findByRole("button", { name: "Choose dataset" })).toBeTruthy();
    expect(screen.getByText(/Model catalog could not be loaded/)).toBeTruthy();
    expect(platformApi.listPrompts).toHaveBeenCalledOnce();
    expect(screen.queryByText(/No published datasets yet/)).toBeNull();
  });
});


describe("agent catalog entry", () => {
  it("prefills a fresh local agent evaluation without requiring rerun=1", async () => {
    entry.query = "type=agent&agent=local:nova-refunds&dataset=nova_refunds_golden_v1";
    vi.mocked(agentsApi.list).mockResolvedValue([{
      id: "local:nova-refunds", name: "Nova refunds", display_name: "Nova refunds", namespace: "local", description: "Refund workflow", ready: true, accepted: true, model: "qwen3:latest", agent_type: "local_workflow", revision: "1", tools: ["lookup_order"], grounding_url: null,
      execution_mode: "guided_local_workflow", recommended_dataset_id: "nova_refunds_golden_v1", recommended_metric_ids: ["nlp.f1_score"],
    }]);
    vi.mocked(evaluationApi.getRunReadiness).mockResolvedValue({ status: "ready", details: [], metric_applicability: [] } as never);
    render(<EvaluationWorkbench kind="agent" />);
    expect(await screen.findByText(/Selected Nova refunds and its available workflow checks/)).toBeTruthy();
    expect(screen.queryByText(/Select an agent from/)).toBeNull();
    await waitFor(() => expect(evaluationApi.getRunReadiness).toHaveBeenCalled());
    const request = vi.mocked(evaluationApi.getRunReadiness).mock.calls.at(-1)?.[1];
    expect(request).toMatchObject({ agent: "local:nova-refunds", evaluation_name: "Nova refunds · baseline", response_source: "agent", evaluation_scope: "tool_interactions", active_metrics: expect.arrayContaining(["nlp.f1_score"]), parallel_requests: 1 });
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });
});


const novaAgent: AgentSummary = {
  id: "local:nova-refunds", name: "Nova refunds", display_name: "Nova refunds", namespace: "local", description: "Refund workflow", ready: true, accepted: true, model: "qwen3:latest", agent_type: "local_workflow", revision: "1", tools: ["lookup_order"], grounding_url: null,
  execution_mode: "guided_local_workflow", recommended_dataset_id: "nova_refunds_golden_v1", recommended_metric_ids: ["nlp.f1_score"],
};
const courseAgent: AgentSummary = { ...novaAgent, id: "local:course-advisor", name: "Course advisor", display_name: "Course advisor", recommended_dataset_id: "agent_course_advisor_v1", tools: ["search_courses"] };

describe("agent setup recovery and target changes", () => {
  it("applies the URL agent after Retry setup recovers agent discovery", async () => {
    entry.query = "type=agent&agent=local:nova-refunds&dataset=nova_refunds_golden_v1";
    vi.mocked(agentsApi.list).mockRejectedValueOnce(new Error("Discovery unavailable")).mockResolvedValue([novaAgent]);
    vi.mocked(evaluationApi.getRunReadiness).mockResolvedValue({ status: "ready", details: [], metric_applicability: [] } as never);
    render(<EvaluationWorkbench kind="agent" />);
    expect(await screen.findByRole("button", { name: "Retry setup" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    expect(await screen.findByText(/Selected Nova refunds and its available workflow checks/)).toBeTruthy();
    await waitFor(() => expect(evaluationApi.getRunReadiness).toHaveBeenCalled());
    expect(vi.mocked(evaluationApi.getRunReadiness).mock.calls.at(-1)?.[1]).toMatchObject({ agent: "local:nova-refunds", project_id: null });
  });

  it("keeps the current dataset on an agent switch until the presenter explicitly adopts the new golden cases", async () => {
    entry.query = "type=agent&agent=local:nova-refunds&dataset=nova_refunds_golden_v1";
    vi.mocked(agentsApi.list).mockResolvedValue([novaAgent, courseAgent]);
    vi.mocked(evaluationApi.getRunReadiness).mockResolvedValue({ status: "ready", details: [], metric_applicability: [] } as never);
    vi.mocked(api.getDataset).mockResolvedValue({ ...dataset, dataset_name: "agent_course_advisor_v1", record_count: 4 } as never);
    render(<EvaluationWorkbench kind="agent" />);
    expect(await screen.findByText(/Selected Nova refunds and its available workflow checks/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit Configure Agent System" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Agent" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Course advisor/ }));
    expect(await screen.findByText(/selected dataset differs from Course advisor/)).toBeTruthy();
    await waitFor(() => expect(vi.mocked(evaluationApi.getRunReadiness).mock.calls.at(-1)?.[1]?.agent).toBe("local:course-advisor"));
    expect(vi.mocked(evaluationApi.getRunReadiness).mock.calls.at(-1)?.[0]).toBe("nova_refunds_golden_v1");
    expect(vi.mocked(evaluationApi.getRunReadiness).mock.calls.at(-1)?.[1]?.evaluation_name).toBe("Course advisor · baseline");
    expect(api.getDataset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use this agent’s golden dataset" }));
    expect(await screen.findByText(/Selected the prepared golden dataset for Course advisor/)).toBeTruthy();
    expect(api.getDataset).toHaveBeenCalledWith("agent_course_advisor_v1");
    await waitFor(() => expect(vi.mocked(evaluationApi.getRunReadiness).mock.calls.at(-1)?.[0]).toBe("agent_course_advisor_v1"));
    expect(screen.queryByText(/selected dataset differs from Course advisor/)).toBeNull();
  });

  it("does not replace a dataset when the recommended version is unpublished", async () => {
    entry.query = "type=agent&agent=local:course-advisor&dataset=nova_refunds_golden_v1";
    vi.mocked(agentsApi.list).mockResolvedValue([courseAgent]);
    vi.mocked(evaluationApi.getRunReadiness).mockResolvedValue({ status: "ready", details: [], metric_applicability: [] } as never);
    vi.mocked(api.getDataset).mockResolvedValue({ ...dataset, dataset_name: "agent_course_advisor_v1", status: "DRAFT" } as never);
    render(<EvaluationWorkbench kind="agent" />);
    fireEvent.click(await screen.findByRole("button", { name: "Use this agent’s golden dataset" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(() => expect(vi.mocked(evaluationApi.getRunReadiness).mock.calls.at(-1)?.[0]).toBe("nova_refunds_golden_v1"));
  });
});


describe("legacy Nova model-only entry", () => {
  it("offers an explicit switch to the actual agent without invoking either target", async () => {
    entry.query = "type=llm&prepared=nova-refunds&dataset=nova_refunds_golden_v1";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ live: false, model: null }) }));
    render(<EvaluationWorkbench kind="llm" />);
    const link = await screen.findByRole("link", { name: "Open Nova agent evaluation" });
    const params = new URL(link.getAttribute("href")!, "http://example.test").searchParams;
    expect(Object.fromEntries(params)).toEqual({ type: "agent", agent: "local:nova-refunds", dataset: "agent_nova_refunds_v1" });
    expect(screen.getByText(/This setup evaluates answers from an LLM using eight refund cases/)).toBeTruthy();
    await waitFor(() => expect(evaluationApi.listLlmCatalog).toHaveBeenCalled());
    expect(agentsApi.list).not.toHaveBeenCalled();
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });
});
