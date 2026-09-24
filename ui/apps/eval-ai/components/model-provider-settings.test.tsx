import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluationApi, type ModelProvidersStatus } from "@/lib/api";
import { ModelProviderSettings } from "./model-provider-settings";

vi.mock("@/lib/api", () => ({ evaluationApi: { getModelProviders: vi.fn(), connectOpenAI: vi.fn(), disconnectOpenAI: vi.fn(), setDefaultModel: vi.fn(), createRunFromDataset: vi.fn() } }));
const localEndpoint = "http://127.0.0.1:11434/v1";
const openaiEndpoint = "https://api.openai.com/v1";
function status(connected = false): ModelProvidersStatus {
  return { providers: [
    { id: "openai", name: "OpenAI", connected, models: connected ? [{ model_id: "shared-name", name: "Shared model", source: "openai", endpoint: openaiEndpoint }] : [] },
    { id: "ollama", name: "Ollama", connected: true, models: [{ model_id: "shared-name", name: "Shared local model", source: "ollama", endpoint: localEndpoint }, { model_id: "local-second", name: "Second local model", source: "ollama", endpoint: localEndpoint }] },
  ], default: { provider: "ollama", model_id: "shared-name", endpoint: localEndpoint } };
}
async function setup(value = status(), onChange = vi.fn()) {
  vi.mocked(evaluationApi.getModelProviders).mockResolvedValue(value);
  render(<ModelProviderSettings onChange={onChange} />);
  await screen.findByLabelText("Ollama model");
  return onChange;
}
function keyField() { return screen.getByLabelText("OpenAI API key") as HTMLInputElement; }
function submitKey(key: string, consent: boolean) {
  fireEvent.change(keyField(), { target: { value: key } });
  if (consent) fireEvent.click(screen.getByRole("checkbox", { name: /OpenAI evaluation calls may incur charges/ }));
  fireEvent.submit(keyField().closest("form")!);
}
beforeEach(() => vi.clearAllMocks());

describe("model provider settings", () => {
  it("shows OpenAI without a key and installed local models without invoking generation", async () => {
    await setup();
    expect(screen.getByText("Needs API key")).toBeTruthy();
    expect(keyField().type).toBe("password");
    expect((screen.getByLabelText("Ollama model") as HTMLSelectElement).value).toBe(JSON.stringify([localEndpoint, "shared-name"]));
    expect(evaluationApi.connectOpenAI).not.toHaveBeenCalled();
    expect(evaluationApi.setDefaultModel).not.toHaveBeenCalled();
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
  });
  it("requires a key and explicit cost acknowledgement before connection", async () => {
    await setup();
    submitKey("", false);
    expect(screen.getByRole("alert").textContent).toContain("Enter an OpenAI API key");
    submitKey("test-secret-no-consent", false);
    expect(keyField().value).toBe("");
    expect(screen.getByRole("alert").textContent).toContain("Confirm that OpenAI evaluation calls may incur charges");
    expect(evaluationApi.connectOpenAI).not.toHaveBeenCalled();
  });
  it("clears a submitted key immediately, saves through the API and never uses browser storage", async () => {
    const store = vi.spyOn(Storage.prototype, "setItem");
    let resolve!: (value: ModelProvidersStatus) => void;
    vi.mocked(evaluationApi.connectOpenAI).mockReturnValue(new Promise((done) => { resolve = done; }));
    const changed = await setup();
    submitKey("test-secret-for-connection", true);
    expect(keyField().value).toBe("");
    expect(evaluationApi.connectOpenAI).toHaveBeenCalledWith({ api_key: "test-secret-for-connection", allow_paid_calls: true });
    expect(store).not.toHaveBeenCalled();
    await act(async () => resolve(status(true)));
    expect(await screen.findByText(/OpenAI connection saved on the backend/)).toBeTruthy();
    expect(screen.getByLabelText("OpenAI model")).toBeTruthy();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(evaluationApi.createRunFromDataset).not.toHaveBeenCalled();
    store.mockRestore();
  });
  it("keeps failed provider responses and secrets out of visible validation messages", async () => {
    vi.mocked(evaluationApi.connectOpenAI).mockRejectedValue(new Error("Provider rejected test-secret-for-error"));
    await setup();
    submitKey("test-secret-for-error", true);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("OpenAI connection could not be verified"));
    expect(keyField().value).toBe("");
    expect(document.body.textContent).not.toContain("test-secret-for-error");
  });
  it("keeps same-name models distinct by provider and endpoint when setting the default", async () => {
    const next = status(true); next.default = { provider: "openai", model_id: "shared-name", endpoint: openaiEndpoint };
    vi.mocked(evaluationApi.setDefaultModel).mockResolvedValue(next);
    await setup(status(true));
    const cloud = screen.getByLabelText("OpenAI model") as HTMLSelectElement;
    expect(cloud.value).toBe(JSON.stringify([openaiEndpoint, "shared-name"]));
    expect(cloud.value).not.toBe((screen.getByLabelText("Ollama model") as HTMLSelectElement).value);
    fireEvent.click(within(cloud.closest("article")!).getByRole("button", { name: "Use for new evaluations" }));
    await waitFor(() => expect(evaluationApi.setDefaultModel).toHaveBeenCalledWith({ provider: "openai", model_id: "shared-name" }));
    expect(await screen.findByText(/is selected for new evaluations/)).toBeTruthy();
    expect(within(cloud.closest("article")!).getByRole("button", { name: "Default model" }).getAttribute("disabled")).not.toBeNull();
  });
  it("selects an installed local model only after the explicit default action", async () => {
    const next = status(); next.default = { provider: "ollama", model_id: "local-second", endpoint: localEndpoint };
    vi.mocked(evaluationApi.setDefaultModel).mockResolvedValue(next);
    await setup();
    const picker = screen.getByLabelText("Ollama model");
    fireEvent.change(picker, { target: { value: JSON.stringify([localEndpoint, "local-second"]) } });
    expect(evaluationApi.setDefaultModel).not.toHaveBeenCalled();
    fireEvent.click(within(picker.closest("article")!).getByRole("button", { name: "Use for new evaluations" }));
    await waitFor(() => expect(evaluationApi.setDefaultModel).toHaveBeenCalledWith({ provider: "ollama", model_id: "local-second" }));
  });
  it("refreshes the catalog and shell only after an explicit successful provider refresh", async () => {
    const listener = vi.fn();
    window.addEventListener("proofgrove:providers-changed", listener);
    try {
      const changed = await setup();
      expect(changed).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Refresh providers" }));
      await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(evaluationApi.getModelProviders).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("proofgrove:providers-changed", listener);
    }
  });
  it("disconnects OpenAI without removing the available Ollama models", async () => {
    vi.mocked(evaluationApi.disconnectOpenAI).mockResolvedValue(status());
    const changed = await setup(status(true));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect OpenAI" }));
    expect(await screen.findByText("Needs API key")).toBeTruthy();
    expect(screen.getByLabelText("Ollama model")).toBeTruthy();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
