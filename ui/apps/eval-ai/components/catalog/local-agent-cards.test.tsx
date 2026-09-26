import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { agentsApi, type TargetVersion } from "@/lib/api";
import { LocalAgentCards } from "./local-agent-cards";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, agentsApi: { ...actual.agentsApi, invokeLocal: vi.fn() } };
});
const target = {
  target_version_id: "nova-v1", target_id: "target-nova", name: "Nova refunds", model_version: "qwen3:latest",
  configuration: { ready: true, catalog_source: "local_workflow", agent_ref: "local:nova-refunds", recommended_dataset_id: "agent_nova_refunds_v1", description: "Checks a refund against the order and policy.", example_query: "Can I return order 7734?", tools: ["lookup_order", "check_refund_policy"] },
} as unknown as TargetVersion;

beforeEach(() => vi.clearAllMocks());

describe("local agent cards", () => {
  it("starts a real invocation only after the user selects Try example and shows returned evidence", async () => {
    vi.mocked(agentsApi.invokeLocal).mockResolvedValue({ response: "Return the headphones for AED 250.", tool_calls: [{ name: "lookup_order", arguments: { order_id: "7734" } }], trace_id: "trace-1", invocation_id: "invoke-1", model: "qwen3:latest" });
    render(<LocalAgentCards agents={[target]} />);
    expect(agentsApi.invokeLocal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try Nova refunds" }));
    expect(await screen.findByText("Return the headphones for AED 250.")).toBeTruthy();
    expect(agentsApi.invokeLocal).toHaveBeenCalledWith("local:nova-refunds", "Can I return order 7734?");
    expect(screen.getByText("View tool evidence")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Evaluate Nova refunds" }).getAttribute("href")).toContain("agent=local%3Anova-refunds");
  });

  it("does not present unavailable agents as runnable", () => {
    render(<LocalAgentCards agents={[{ ...target, configuration: { ...target.configuration, ready: false, availability_message: "The default model is unavailable." } }]} />);
    expect((screen.getByRole("button", { name: "Try Nova refunds" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: "Evaluate Nova refunds" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Models" })).toBeTruthy();
    expect(screen.getByText(/The default model is unavailable/)).toBeTruthy();
  });

  it("shows invocation failures rather than a fabricated response", async () => {
    vi.mocked(agentsApi.invokeLocal).mockRejectedValue(new Error("Model stopped"));
    render(<LocalAgentCards agents={[target]} />);
    fireEvent.click(screen.getByRole("button", { name: "Try Nova refunds" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Fresh agent response")).toBeNull();
  });
});
