import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PreparedAgentEvaluationStarter } from "./prepared-agent-evaluation-starter";
import { PreparedEvaluationStarter } from "./prepared-evaluation-starter";
import { NOVA_AGENT_DEMO } from "@/lib/local-agents";
import { agentsApi, api, evaluationApi, platformApi, type AgentSummary } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  agentsApi: { list: vi.fn(), invokeLocal: vi.fn() },
  api: { getDataset: vi.fn(), tenant: vi.fn(), listTraceProjects: vi.fn() },
  evaluationApi: { listMetrics: vi.fn(), listLlmCatalog: vi.fn(), createRunFromDataset: vi.fn() },
  platformApi: { listPrompts: vi.fn() },
}));

const nova: AgentSummary = {
  id: NOVA_AGENT_DEMO.agentRef, name: "Nova Refunds", display_name: "Nova Refunds", namespace: "local", description: "Refund workflow", ready: true, accepted: true, model: "deepseek-r1:1.5b", agent_type: "local_workflow", revision: "1", tools: ["lookup_order", "check_refund_eligibility"], grounding_url: null,
  execution_mode: "guided_local_workflow", recommended_dataset_id: NOVA_AGENT_DEMO.dataset, recommended_metric_ids: [...NOVA_AGENT_DEMO.metrics],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentsApi.list).mockResolvedValue([nova]);
  vi.mocked(api.getDataset).mockResolvedValue({ dataset_name: NOVA_AGENT_DEMO.dataset, status: "PUBLISHED", record_count: 4, missing_row_fields: [] } as never);
  vi.mocked(evaluationApi.listMetrics).mockResolvedValue(NOVA_AGENT_DEMO.metrics.map((metric_id) => ({ metric_id, name: metric_id, description: "Tool contract", available_in_run: true })));
});

describe("prepared Nova agent entry", () => {
  it("starts an actual agent with four golden cases and no model-only discovery or invocation", async () => {
    render(<PreparedEvaluationStarter />);
    const link = await screen.findByRole("link", { name: "Start Nova agent evaluation" });
    const params = new URL(link.getAttribute("href")!, "http://example.test").searchParams;
    expect(Object.fromEntries(params)).toEqual({ type: "agent", agent: NOVA_AGENT_DEMO.agentRef, dataset: NOVA_AGENT_DEMO.dataset });
    expect(api.getDataset).toHaveBeenCalledWith("agent_nova_refunds_v1");
    expect(screen.getByText(/4 cases · expected answers, tool names and arguments/)).toBeTruthy();
    expect(screen.getByText("deepseek-r1:1.5b")).toBeTruthy();
    expect(screen.getByText("Model-only refund evaluation and offline rehearsal").closest("details")?.open).toBe(false);
    expect(screen.queryByRole("link", { name: "Start model-only evaluation" })).toBeNull();
    expect(evaluationApi.listLlmCatalog).not.toHaveBeenCalled();
    expect(platformApi.listPrompts).not.toHaveBeenCalled();
    expect(agentsApi.invokeLocal).not.toHaveBeenCalled();
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });

  it.each(["DRAFT", "APPROVED"])("keeps an unpublished %s dataset out of the prepared run", async (status) => {
    vi.mocked(api.getDataset).mockResolvedValue({ status, record_count: 4, missing_row_fields: [] } as never);
    render(<PreparedAgentEvaluationStarter />);
    expect(await screen.findByText("Published Nova agent cases unavailable")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Start Nova agent evaluation" })).toBeNull();
  });

  it("does not launch when the actual agent or a required tool check is unavailable", async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([{ ...nova, ready: false }]);
    vi.mocked(evaluationApi.listMetrics).mockResolvedValue(NOVA_AGENT_DEMO.metrics.slice(0, 2).map((metric_id) => ({ metric_id, name: metric_id, description: "Tool contract" })));
    render(<PreparedAgentEvaluationStarter />);
    expect(await screen.findByText("2 of 3 workflow checks available")).toBeTruthy();
    expect(screen.getByText(/Nova agent unavailable/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Start Nova agent evaluation" })).toBeNull();
  });

  it("recovers a failed agent lookup with an explicit read-only retry", async () => {
    vi.mocked(agentsApi.list).mockRejectedValueOnce(new Error("Temporary connection failure"));
    render(<PreparedAgentEvaluationStarter />);
    expect(await screen.findByText(/agent setup could not be fully checked/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Start Nova agent evaluation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry agent setup" }));
    expect(await screen.findByRole("link", { name: "Start Nova agent evaluation" })).toBeTruthy();
    await waitFor(() => expect(agentsApi.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/agent setup could not be fully checked/)).toBeNull();
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });
});
