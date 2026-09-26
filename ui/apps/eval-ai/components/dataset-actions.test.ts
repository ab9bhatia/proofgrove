/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/datasets",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  api: { tenant: vi.fn(), createDataset: vi.fn(), uploadCsv: vi.fn(), csvTemplate: vi.fn() },
  agentsApi: { toolServers: vi.fn().mockResolvedValue([]) },
  evaluationApi: {
    listLlmCatalog: vi.fn().mockResolvedValue([]),
    getModelProviders: vi.fn().mockResolvedValue({ providers: [], default: null }),
  },
}));

import { api } from "@/lib/api";
import { DatasetActions } from "./dataset-actions";
import { ApiError } from "@/lib/api-errors";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "tenant-classroom" });
  vi.mocked(api.createDataset).mockResolvedValue({ name: "Evaluation Dataset", record_count: 4 } as Awaited<ReturnType<typeof api.createDataset>>);
});

const csvContent = "Question,Expected Output\n12 times 7?,84";

function openImport(fileName = "math.csv", fileSize?: number) {
  const onCreated = vi.fn();
  render(createElement(DatasetActions, { open: true, onOpenChange: vi.fn(), onCreated }));
  fireEvent.click(screen.getByRole("radio", { name: /Import CSV/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Dataset name" }), { target: { value: "Evaluation Dataset" } });
  const file = new File([csvContent], fileName, { type: "text/csv" });
  Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(csvContent) });
  if (fileSize !== undefined) Object.defineProperty(file, "size", { value: fileSize });
  fireEvent.change(screen.getByLabelText(/Drop a CSV file here/), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Import Draft" }));
  return { file, onCreated };
}

describe("atomic dataset import", () => {
  it("imports without loading generation models or grounding tools", async () => {
    openImport();
    await screen.findByText('Imported 4 records into “Evaluation Dataset” as a Draft dataset.');
    expect(agentsApi.toolServers).not.toHaveBeenCalled();
    expect(evaluationApi.listLlmCatalog).not.toHaveBeenCalled();
    expect(evaluationApi.getModelProviders).not.toHaveBeenCalled();
  });

  it("checks recovery after a connection failure without resubmitting the import", async () => {
    vi.mocked(api.createDataset).mockRejectedValueOnce(new ApiError({ status: 0, code: "NETWORK_ERROR", message: "Unable to reach Proofgrove." }));
    vi.mocked(api.csvTemplate).mockResolvedValueOnce({ csv: csvContent, columns: {} });
    const { onCreated } = openImport();
    fireEvent.click(await screen.findByRole("button", { name: "Check connection" }));
    await screen.findByText(/Connection is available/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("math.csv")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Dataset name" }) as HTMLInputElement).value).toBe("Evaluation Dataset");
    expect(api.createDataset).toHaveBeenCalledOnce();
    expect(api.csvTemplate).toHaveBeenCalledOnce();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("offers the Nova sample without a template API request and requires a name and file", () => {
    render(createElement(DatasetActions, { open: true, onOpenChange: vi.fn(), onCreated: vi.fn() }));
    fireEvent.click(screen.getByRole("radio", { name: /Import CSV/ }));
    expect(screen.getByRole("link", { name: "Download Nova agent sample (4 cases)" }).getAttribute("href")).toBe("/samples/nova-agent-golden.csv");
    expect((screen.getByRole("button", { name: "Import Draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.csvTemplate).not.toHaveBeenCalled();
  });

  it("closes with Escape and preserves form values when reopened", () => {
    const onOpenChange = vi.fn();
    const props = { open: true, onOpenChange, onCreated: vi.fn() };
    const { rerender } = render(createElement(DatasetActions, props));
    expect(screen.getByRole("dialog", { name: "Add dataset" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Import CSV/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Dataset name" }), { target: { value: "Draft dataset" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(createElement(DatasetActions, { ...props, open: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(createElement(DatasetActions, props));
    expect((screen.getByRole("textbox", { name: "Dataset name" }) as HTMLInputElement).value).toBe("Draft dataset");
  });

  it("creates the dataset and records in one request and displays the returned name", async () => {
    vi.mocked(api.createDataset).mockResolvedValue({ name: "Server Dataset", record_count: 4 } as Awaited<ReturnType<typeof api.createDataset>>);
    const { onCreated } = openImport();
    await screen.findByText('Imported 4 records into “Server Dataset” as a Draft dataset.');
    expect(api.createDataset).toHaveBeenCalledWith(expect.objectContaining({
      dataset_name: "Evaluation Dataset", csv_content: csvContent,
    }));
    expect(api.uploadCsv).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("retains the selected file after a failed import so the request can be retried", async () => {
    vi.mocked(api.createDataset).mockRejectedValueOnce(new Error("Import interrupted"));
    const { onCreated } = openImport();
    await screen.findByText("Import interrupted");
    expect(onCreated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Import Draft" }));
    await screen.findByText('Imported 4 records into “Evaluation Dataset” as a Draft dataset.');
    expect(api.createDataset).toHaveBeenCalledTimes(2);
    expect(api.createDataset).toHaveBeenLastCalledWith(expect.objectContaining({
      dataset_name: "Evaluation Dataset", csv_content: csvContent,
    }));
    expect(api.uploadCsv).not.toHaveBeenCalled();
  });

  it("surfaces duplicate-name rejection without attempting a separate upload", async () => {
    vi.mocked(api.createDataset).mockRejectedValueOnce(new Error("A dataset with this name already exists. Choose a new name for the import."));
    const { onCreated } = openImport();
    await screen.findByText("A dataset with this name already exists. Choose a new name for the import.");
    expect(api.uploadCsv).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it.each([
    ["math.txt", 100, "Choose a CSV file."],
    ["math.csv", 20_000_001, "The CSV is too large. Use a file smaller than 20 MB."],
  ])("rejects invalid file %s (%i bytes) before creating a dataset", async (fileName, fileSize, error) => {
    openImport(fileName, fileSize);
    await screen.findByText(error);
    expect(api.createDataset).not.toHaveBeenCalled();
    expect(api.uploadCsv).not.toHaveBeenCalled();
  });
});

vi.mock("@/lib/dataset-generation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/dataset-generation")>(),
  datasetGenerationApi: { start: vi.fn(), get: vi.fn(), cancel: vi.fn() },
}));

import { agentsApi, evaluationApi } from "@/lib/api";
import { datasetGenerationApi } from "@/lib/dataset-generation";
import { modelSelectionId } from "@/lib/model-selection";

const openaiModel = { model_id: "gpt-4o-mini", name: "gpt-4o-mini", source: "openai" as const, endpoint: "https://api.openai.com/v1" };
const ollamaModel = { model_id: "gpt-4o-mini", name: "gpt-4o-mini", source: "ollama" as const, endpoint: "http://127.0.0.1:11434/v1" };

function openGenerate() {
  render(createElement(DatasetActions, { open: true, onOpenChange: vi.fn(), onCreated: vi.fn() }));
  fireEvent.click(screen.getByRole("radio", { name: /^Generate/ }));
  fireEvent.click(screen.getByRole("radio", { name: /^LLMs/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Dataset Name" }), { target: { value: "generated_support" } });
}

describe("provider dataset generation", () => {
  beforeEach(() => {
    vi.mocked(agentsApi.toolServers).mockResolvedValue([]);
    vi.mocked(evaluationApi.listLlmCatalog).mockResolvedValue([openaiModel, ollamaModel]);
    vi.mocked(evaluationApi.getModelProviders).mockResolvedValue({
      providers: [], default: { provider: "ollama", model_id: ollamaModel.model_id, endpoint: ollamaModel.endpoint },
    });
    vi.mocked(datasetGenerationApi.start).mockResolvedValue({ job_id: "generation-test", tenant: "local-classroom", dataset_name: "generated_support", phase: "completed", progress: { done: 1, total: 1 }, error: null, result_dataset_name: "generated_support", created_at: null, updated_at: null });
  });

  it("offers providers and sends the selected model plus endpoint without collisions", async () => {
    openGenerate();
    await screen.findByRole("option", { name: "gpt-4o-mini · OpenAI" });
    expect(screen.getByRole("option", { name: "gpt-4o-mini · Ollama" })).toBeTruthy();
    const picker = screen.getByRole("combobox", { name: /Generation model/ });
    expect((picker as HTMLSelectElement).value).toBe(modelSelectionId(ollamaModel));
    fireEvent.change(picker, { target: { value: modelSelectionId(openaiModel) } });
    fireEvent.click(screen.getByRole("button", { name: "Generate Dataset" }));
    await screen.findByText(/Generated 1 records/);
    expect(datasetGenerationApi.start).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-4o-mini", model_endpoint: openaiModel.endpoint, generation_method: "llms" }));
  });

  it("uses the configured default instead of the first installed model, and Reset restores it", async () => {
    const firstInstalled = { ...ollamaModel, model_id: "bakllava:latest", name: "bakllava:latest" };
    const configured = { ...ollamaModel, model_id: "deepseek-r1:1.5b", name: "deepseek-r1:1.5b" };
    vi.mocked(evaluationApi.listLlmCatalog).mockResolvedValue([firstInstalled, configured, openaiModel]);
    vi.mocked(evaluationApi.getModelProviders).mockResolvedValue({
      providers: [], default: { provider: "ollama", model_id: configured.model_id, endpoint: configured.endpoint },
    });
    openGenerate();
    await screen.findByRole("option", { name: "deepseek-r1:1.5b · Ollama" });
    const picker = screen.getByRole("combobox", { name: /Generation model/ }) as HTMLSelectElement;
    expect(picker.value).toBe(modelSelectionId(configured));
    expect((screen.getByRole("spinbutton", { name: /Size/ }) as HTMLInputElement).value).toBe("5");
    fireEvent.change(picker, { target: { value: modelSelectionId(openaiModel) } });
    fireEvent.change(screen.getByRole("spinbutton", { name: /Size/ }), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByRole("radio", { name: /^LLMs/ }));
    expect((screen.getByRole("combobox", { name: /Generation model/ }) as HTMLSelectElement).value).toBe(modelSelectionId(configured));
    expect((screen.getByRole("spinbutton", { name: /Size/ }) as HTMLInputElement).value).toBe("5");
  });

  it("preserves an explicit model choice on Refresh and uses Size for the request count", async () => {
    openGenerate();
    await screen.findByRole("option", { name: "gpt-4o-mini · OpenAI" });
    const picker = screen.getByRole("combobox", { name: /Generation model/ }) as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: modelSelectionId(openaiModel) } });
    fireEvent.change(screen.getByRole("spinbutton", { name: /Size/ }), { target: { value: "3" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Generation Prompt / Instructions" }), { target: { value: "Draft exactly five refund cases." } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    await waitFor(() => expect(picker.disabled).toBe(false));
    expect(evaluationApi.getModelProviders).toHaveBeenCalledTimes(2);
    expect(picker.value).toBe(modelSelectionId(openaiModel));
    expect(screen.getByText("Size sets the row count, even if your prompt mentions a different number.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate Dataset" }));
    await screen.findByText(/Generated 1 records/);
    expect(datasetGenerationApi.start).toHaveBeenCalledWith(expect.objectContaining({ num_rows: 3, model_endpoint: openaiModel.endpoint }));
  });

  it("requires a deliberate selection if the configured default is unavailable", async () => {
    vi.mocked(evaluationApi.getModelProviders).mockResolvedValue({
      providers: [], default: { provider: "ollama", model_id: "not-installed", endpoint: ollamaModel.endpoint },
    });
    openGenerate();
    await screen.findByRole("option", { name: "gpt-4o-mini · Ollama" });
    const picker = screen.getByRole("combobox", { name: /Generation model/ }) as HTMLSelectElement;
    expect(picker.value).toBe("");
    expect((screen.getByRole("button", { name: "Generate Dataset" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(picker, { target: { value: modelSelectionId(ollamaModel) } });
    expect((screen.getByRole("button", { name: "Generate Dataset" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps manual choices available if provider status cannot be loaded", async () => {
    vi.mocked(evaluationApi.getModelProviders).mockRejectedValueOnce(new Error("Default unavailable"));
    openGenerate();
    await screen.findByRole("option", { name: "gpt-4o-mini · Ollama" });
    const picker = screen.getByRole("combobox", { name: /Generation model/ }) as HTMLSelectElement;
    expect(picker.value).toBe("");
    expect(picker.disabled).toBe(false);
    fireEvent.change(picker, { target: { value: modelSelectionId(ollamaModel) } });
    fireEvent.click(screen.getByRole("button", { name: "Generate Dataset" }));
    await screen.findByText(/Generated 1 records/);
  });

  it("renders the actionable generation error returned by the server", async () => {
    const message = "The selected model did not return valid evaluation cases. Try a different model or a shorter prompt.";
    vi.mocked(datasetGenerationApi.start).mockResolvedValue({
      job_id: "generation-failed", tenant: "local-classroom", dataset_name: "generated_support", phase: "failed",
      progress: { done: 0, total: 5 }, error: message, result_dataset_name: null, created_at: null, updated_at: null,
    });
    openGenerate();
    await screen.findByRole("option", { name: "gpt-4o-mini · Ollama" });
    fireEvent.click(screen.getByRole("button", { name: "Generate Dataset" }));
    await screen.findByText(message);
    expect(screen.getByText("0 of 5 rows")).toBeTruthy();
  });

  it("keeps models usable if unrelated grounding discovery fails", async () => {
    vi.mocked(agentsApi.toolServers).mockRejectedValueOnce(new Error("Grounding unavailable"));
    openGenerate();
    await screen.findByRole("option", { name: "gpt-4o-mini · Ollama" });
    expect((screen.getByRole("button", { name: "Generate Dataset" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Generate Dataset" }));
    await screen.findByText(/Generated 1 records/);
    expect(datasetGenerationApi.start).toHaveBeenCalledWith(expect.objectContaining({ model_endpoint: ollamaModel.endpoint }));
  });

  it("shows catalog failure separately from an empty catalog and supports retry", async () => {
    vi.mocked(evaluationApi.listLlmCatalog).mockRejectedValueOnce(new Error("Backend unavailable"));
    openGenerate();
    await screen.findByText("Could not load generation models. Retry or check the Models page.");
    expect(screen.queryByText("No connected generation models")).toBeNull();
    expect((screen.getByRole("button", { name: "Generate Dataset" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    await screen.findByRole("option", { name: "gpt-4o-mini · OpenAI" });
    expect((screen.getByRole("textbox", { name: "Dataset Name" }) as HTMLInputElement).value).toBe("generated_support");
  });

  it("links to Models when no compatible connected provider exists", async () => {
    vi.mocked(evaluationApi.listLlmCatalog).mockResolvedValue([{ model_id: "custom-only", name: "custom", source: "custom", endpoint: "https://custom.example/v1" }]);
    openGenerate();
    await screen.findByText("No connected generation models");
    expect(screen.getByRole("link", { name: "Models" }).getAttribute("href")).toBe("/catalog/llms");
    expect((screen.getByRole("button", { name: "Generate Dataset" }) as HTMLButtonElement).disabled).toBe(true);
    expect(datasetGenerationApi.start).not.toHaveBeenCalled();
  });
});
