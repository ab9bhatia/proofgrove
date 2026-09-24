/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/datasets",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  api: { tenant: vi.fn(), createDataset: vi.fn(), uploadCsv: vi.fn() },
  agentsApi: { toolServers: vi.fn().mockResolvedValue([]) },
  evaluationApi: { listLlmCatalog: vi.fn().mockResolvedValue([]) },
}));

import { api } from "@/lib/api";
import { DatasetActions } from "./dataset-actions";

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
