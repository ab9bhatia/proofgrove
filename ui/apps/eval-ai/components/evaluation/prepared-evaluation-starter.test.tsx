import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PreparedEvaluationStarter } from "./prepared-evaluation-starter";
import { NOVA_PREPARED } from "./prepared-evaluation";
import { agentsApi, api, evaluationApi, platformApi } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  agentsApi: { list: vi.fn() },
  api: { getDataset: vi.fn(), tenant: vi.fn(), listTraceProjects: vi.fn() },
  evaluationApi: { listMetrics: vi.fn(), listLlmCatalog: vi.fn(), createRunFromDataset: vi.fn() },
  platformApi: { listPrompts: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentsApi.list).mockResolvedValue([]);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ live: false, model: null }) }));
  vi.mocked(api.getDataset).mockResolvedValue({ status: "PUBLISHED", record_count: 8, missing_row_fields: [], missing_provided_response: false } as never);
  vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "tenant-classroom" } as never);
  vi.mocked(api.listTraceProjects).mockResolvedValue([{ project_id: NOVA_PREPARED.project, name: "Nova customer operations", status: "active", purpose: "system" }] as never);
  vi.mocked(platformApi.listPrompts).mockResolvedValue([1, 2].map((version) => ({ prompt_id: NOVA_PREPARED.promptId, version, content: "Refund policy" })) as never);
  vi.mocked(evaluationApi.listMetrics).mockResolvedValue(NOVA_PREPARED.metrics.map((metric_id) => ({ metric_id, name: metric_id, description: "Text overlap" })));
  vi.mocked(evaluationApi.listLlmCatalog).mockResolvedValue([]);
});

describe("prepared evaluation starter", () => {
  it("keeps rehearsal collapsed and secondary without invoking anything", async () => {
    render(<PreparedEvaluationStarter />);
    fireEvent.click(screen.getByText("Model-only refund evaluation and offline rehearsal"));
    const summary = await screen.findByText("Offline rehearsal with supplied responses");
    expect(summary.closest("details")?.open).toBe(false);
    expect(screen.getByRole("link", { name: "Open offline rehearsal" }).closest("details")?.open).toBe(false);
    fireEvent.click(summary);
    const start = screen.getByRole("link", { name: "Open offline rehearsal" });
    expect(start.getAttribute("href")).toContain("type=provided&prepared=nova-refunds&dataset=nova_refunds_rehearsal_v1");
    expect(screen.queryByRole("link", { name: "Start model-only evaluation" })).toBeNull();
    expect(screen.getByText(/Versions 1 and 2/)).toBeTruthy();
    expect(screen.getByText(/Not configured · connect a model/)).toBeTruthy();
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });
  it("offers live setup only for the exact configured model", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ live: true, model: "actual-model" }) }));
    vi.mocked(evaluationApi.listLlmCatalog).mockResolvedValue([{ model_id: "actual-model", name: "Live", source: "custom" }]);
    render(<PreparedEvaluationStarter />);
    fireEvent.click(screen.getByText("Model-only refund evaluation and offline rehearsal"));
    const start = await screen.findByRole("link", { name: "Start model-only evaluation" });
    expect(start.getAttribute("href")).toContain("type=llm&prepared=nova-refunds&dataset=nova_refunds_golden_v1");
    expect(screen.getByText(/actual-model · configured; connection and access not yet verified/)).toBeTruthy();
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });
  it("identifies local Ollama generation without presenting a fake cloud agent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ live: true, model: "llama3.2:latest", provider: "ollama", mode: "local" }) }));
    vi.mocked(evaluationApi.listLlmCatalog).mockResolvedValue([{ model_id: "llama3.2:latest", name: "Local Llama", source: "custom" }]);
    render(<PreparedEvaluationStarter />);
    fireEvent.click(screen.getByText("Model-only refund evaluation and offline rehearsal"));
    expect(await screen.findByRole("link", { name: "Start model-only evaluation" })).toBeTruthy();
    expect(screen.getByText("Local model")).toBeTruthy();
    expect(screen.getByText(/configured through Ollama on this Mac; generates fresh answers/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open offline rehearsal" }).closest("details")?.open).toBe(false);
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });
  it("reports a failed artifact check and prevents a misleading ready-to-run link", async () => {
    vi.mocked(evaluationApi.listMetrics).mockRejectedValue(new Error("Unavailable"));
    render(<PreparedEvaluationStarter />);
    fireEvent.click(screen.getByText("Model-only refund evaluation and offline rehearsal"));
    expect(await screen.findByText(/Some artifacts could not be checked/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open offline rehearsal", hidden: true })).toBeNull();
    expect(screen.getByText("0 of 3 text metrics available")).toBeTruthy();
  });
});
