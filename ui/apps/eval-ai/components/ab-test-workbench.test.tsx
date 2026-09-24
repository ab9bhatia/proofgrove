import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { AbTestWorkbench } from "./ab-test-workbench";
import { api, agentsApi, evaluationApi, platformApi } from "@/lib/api";
import type { LabConfiguration } from "@/lib/ab-test";
import { rememberLaunch } from "@/lib/bakeoff-store";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a> }));
vi.mock("@/lib/api", () => ({ api: { tenant: vi.fn(), listDatasets: vi.fn() }, agentsApi: { list: vi.fn() }, platformApi: { listPrompts: vi.fn() }, evaluationApi: { getRunReadiness: vi.fn(), createRunFromDataset: vi.fn() } }));
vi.mock("@/lib/bakeoff-store", () => ({ readLaunches: vi.fn(() => []), rememberLaunch: vi.fn() }));
vi.mock("@/lib/bakeoff-grouping", () => ({ refreshTargets: vi.fn() }));
vi.mock("@/lib/bakeoff", () => ({ completedComparisonHref: () => null, isTerminalRunStatus: (status: string | null) => status === "completed" }));

const connected: LabConfiguration = {
  mode: "local", live: true, provider: "ollama", model: "local-model",
  profiles: [
    { id: "local", name: "Local model", model: "local-model", provider: "ollama", endpoint: "http://127.0.0.1:11434/v1" },
    { id: "cloud", name: "OpenAI model", model: "cloud-model", provider: "openai", endpoint: "https://api.openai.com/v1" },
  ],
};
const disconnected: LabConfiguration = { mode: "local", live: false, model: null, profiles: [] };
const response = (configuration: LabConfiguration) => ({ ok: true, json: async () => configuration });
function consent() { return screen.getByRole("checkbox", { name: /I understand this requests/ }) as HTMLInputElement; }
function runButton() { return screen.getByRole("button", { name: "Run A/B test" }) as HTMLButtonElement; }
async function setup(configuration = connected) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(configuration)));
  render(<AbTestWorkbench />);
  await waitFor(() => expect(screen.queryByText("Loading golden datasets and prompts…")).toBeNull());
}

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.clearAllMocks();
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => saved.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => saved.set(key, value)),
    removeItem: vi.fn((key: string) => saved.delete(key)),
  });
  vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "tenant-classroom" } as never);
  vi.mocked(api.listDatasets).mockResolvedValue([{ dataset_id: "refund-cases", dataset_name: "nova_refunds_golden_v1", status: "PUBLISHED", record_count: 8 }] as never);
  vi.mocked(platformApi.listPrompts).mockResolvedValue([1, 2].map((version) => ({ prompt_id: "nova-refund-assistant", name: "Refund policy", version, content: `Policy version ${version}` })) as never);
  vi.mocked(agentsApi.list).mockResolvedValue([{ id: "agent-a", namespace: "sandbox", name: "baseline", display_name: "Baseline agent" }, { id: "agent-b", namespace: "sandbox", name: "candidate", display_name: "Candidate agent" }] as never);
  vi.mocked(evaluationApi.getRunReadiness).mockResolvedValue({ status: "ready", details: [] } as never);
  vi.mocked(evaluationApi.createRunFromDataset).mockReset().mockResolvedValueOnce({ run_id: "run-a", status: "completed" }).mockResolvedValueOnce({ run_id: "run-b", status: "completed" });
});

describe("A/B launch consent and provider readiness", () => {
  it("requires renewed cost acknowledgement after switching from local to OpenAI", async () => {
    await setup();
    expect(screen.getByText(/responses are generated locally with no paid API calls/)).toBeTruthy();
    fireEvent.click(consent());
    expect(runButton().disabled).toBe(false);
    fireEvent.change(screen.getAllByRole("combobox", { name: "Model" })[0]!, { target: { value: "cloud" } });
    expect(consent().checked).toBe(false);
    expect(runButton().disabled).toBe(true);
    expect(screen.getByText(/retries may add calls and cost/)).toBeTruthy();
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });
  it("requires renewed acknowledgement when the number of cases changes", async () => {
    await setup();
    fireEvent.click(consent());
    fireEvent.change(screen.getByRole("spinbutton", { name: "Cases per side (maximum 8)" }), { target: { value: "8" } });
    expect(consent().checked).toBe(false);
    expect(runButton().disabled).toBe(true);
    expect(screen.getByText(/up to 16 target responses across two runs/)).toBeTruthy();
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });
  it("can run ready registered agent endpoints in local mode without a connected model provider", async () => {
    await setup(disconnected);
    fireEvent.change(screen.getByRole("combobox", { name: "What changes between A and B?" }), { target: { value: "agents" } });
    const picks = screen.getAllByRole("combobox", { name: "Registered agent" });
    fireEvent.change(picks[0]!, { target: { value: "sandbox/baseline" } });
    fireEvent.change(picks[1]!, { target: { value: "sandbox/candidate" } });
    fireEvent.click(consent());
    expect(runButton().disabled).toBe(false);
    fireEvent.click(runButton());
    await waitFor(() => expect(evaluationApi.createRunFromDataset).toHaveBeenCalledTimes(2));
    expect(evaluationApi.getRunReadiness).toHaveBeenCalledTimes(2);
    expect(vi.mocked(evaluationApi.getRunReadiness).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(evaluationApi.createRunFromDataset).mock.invocationCallOrder[0]!);
    expect(evaluationApi.createRunFromDataset).toHaveBeenNthCalledWith(1, "nova_refunds_golden_v1", expect.objectContaining({ response_source: "agent", agent: "sandbox/baseline", enable_llm_judge: false }));
    expect(evaluationApi.createRunFromDataset).toHaveBeenNthCalledWith(2, "nova_refunds_golden_v1", expect.objectContaining({ response_source: "agent", agent: "sandbox/candidate" }));
    await waitFor(() => expect(rememberLaunch).toHaveBeenCalledTimes(1));
  });
  it("keeps prompt and model comparisons disabled without connected model profiles", async () => {
    await setup(disconnected);
    fireEvent.click(consent());
    expect(runButton().disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "What changes between A and B?" }), { target: { value: "models" } });
    fireEvent.click(consent());
    expect(runButton().disabled).toBe(true);
    fireEvent.click(runButton());
    expect(evaluationApi.getRunReadiness).not.toHaveBeenCalled();
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });
  it("rechecks current model connectivity before readiness or either launch", async () => {
    await setup();
    vi.mocked(fetch).mockResolvedValueOnce(response(disconnected) as Response);
    fireEvent.click(consent());
    fireEvent.click(runButton());
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Comparison could not start. Existing run links are preserved.");
    expect(evaluationApi.getRunReadiness).not.toHaveBeenCalled();
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });
  it("rejects a selected model with no connected endpoint before launch", async () => {
    await setup({ ...connected, profiles: connected.profiles.map((profile) => ({ ...profile, endpoint: undefined })) });
    fireEvent.click(consent());
    fireEvent.click(runButton());
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Comparison could not start. Existing run links are preserved.");
    expect(evaluationApi.getRunReadiness).not.toHaveBeenCalled();
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });
});
