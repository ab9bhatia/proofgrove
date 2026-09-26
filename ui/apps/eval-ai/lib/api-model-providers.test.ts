import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionAwareFetch } from "@evalai/shared/session";
import { evaluationApi } from "./api";
vi.mock("@evalai/shared/session", () => ({ sessionAwareFetch: vi.fn() }));
const envelope = { providers: [], default: null };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sessionAwareFetch).mockResolvedValue(new Response(JSON.stringify(envelope), { status: 200 }));
});
describe("provider settings API transport", () => {
  it("reads provider status through the BFF", async () => {
    expect(await evaluationApi.getModelProviders()).toEqual(envelope);
    expect(sessionAwareFetch).toHaveBeenCalledWith("/api/proofgrove/evaluation/model-providers", expect.objectContaining({ cache: "no-store" }));
  });
  it("sends an OpenAI secret only in the explicit POST body", async () => {
    await evaluationApi.connectOpenAI({ api_key: "test-private-key", allow_paid_calls: true });
    const [url, options] = vi.mocked(sessionAwareFetch).mock.calls[0]!;
    expect(url).toBe("/api/proofgrove/evaluation/model-providers/openai");
    expect(String(url)).not.toContain("test-private-key");
    expect(options?.method).toBe("POST");
    expect(JSON.parse(options?.body as string)).toEqual({ api_key: "test-private-key", allow_paid_calls: true });
  });
  it("sets the provider-qualified default through the BFF", async () => {
    await evaluationApi.setDefaultModel({ provider: "ollama", model_id: "installed-model" });
    expect(sessionAwareFetch).toHaveBeenCalledWith("/api/proofgrove/evaluation/model-providers/default", expect.objectContaining({ method: "PUT", body: JSON.stringify({ provider: "ollama", model_id: "installed-model" }) }));
  });
  it("disconnects through DELETE and returns updated status", async () => {
    expect(await evaluationApi.disconnectOpenAI()).toEqual(envelope);
    expect(sessionAwareFetch).toHaveBeenCalledWith("/api/proofgrove/evaluation/model-providers/openai", expect.objectContaining({ method: "DELETE" }));
  });
});
