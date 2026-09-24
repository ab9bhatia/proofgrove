import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EvaluationWorkbench } from "./workbench";
import { agentsApi, api, evaluationApi, platformApi } from "@/lib/api";
import { ApiError } from "@/lib/api-errors";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/evaluate",
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, listDatasetsPage: vi.fn(), tenant: vi.fn(), listTraceProjects: vi.fn() },
    agentsApi: { ...actual.agentsApi, list: vi.fn() },
    evaluationApi: { ...actual.evaluationApi, listMetrics: vi.fn(), listJudgeModels: vi.fn(), listLlmCatalog: vi.fn(), createRunFromDataset: vi.fn() },
    platformApi: { ...actual.platformApi, listQualityContractTemplates: vi.fn(), listPrompts: vi.fn(), capabilities: vi.fn(), listAssignments: vi.fn() },
  };
});

const dataset = { dataset_name: "nova_refunds_golden_v1", version_number: 1, status: "PUBLISHED", record_count: 8, missing_row_fields: [] };

beforeEach(() => {
  vi.clearAllMocks();
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
