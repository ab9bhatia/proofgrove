/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunItemDrawer } from "@/components/run-item-drawer";
import type { RunItemDetail } from "@/lib/api";

const item = {
  run_id: "run-1",
  example_id: "ex-1",
  sequence_position: 0,
  dataset_version: null,
  input: { question: "What is the refund window?" },
  output: { response: "30 days." },
  expected: { expected_output: "30 days." },
  metadata: null,
  retrieval_snippets: null,
  expected_tools: null,
  tool_calls: null,
  tool_result_artifacts: [],
  execution: { trace_id: null },
  scorer_results: [],
  evidence_ref: "evidence-pack://run-1/items/ex-1",
  evidence_policy: {
    redaction_enabled: false,
    max_persisted_string_size: null,
    retention_policy: "stored_with_run_lifecycle",
  },
  capture_state: "complete",
} as unknown as RunItemDetail;

function datasetRow(name: string, status: string) {
  return {
    dataset_id: `id-${name}`,
    dataset_name: name,
    tenant_id: "tenant-1",
    product_id: "eval-hub",
    status,
    version_number: 1,
    parent_dataset_name: null,
    dqs: null,
    change_reason: null,
    created_by: "test",
  };
}

function stubApi() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init });
    let payload: unknown = {};
    if (href.includes("/tenant")) payload = { tenant_id: "tenant-1" };
    else if (href.includes("/promotions")) {
      payload = {
        dataset_name: "pub-ds_v2",
        record_id: "rid-1",
        duplicate: false,
        created_version: true,
        source_dataset_name: "pub-ds",
        version_number: 2,
        status: "DRAFT",
      };
    } else if (href.includes("/datasets")) {
      payload = {
        items: [datasetRow("draft-ds", "DRAFT"), datasetRow("pub-ds", "PUBLISHED")],
        total: 2,
        limit: 100,
        offset: 0,
        next_cursor: null,
      };
    }
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return calls;
}

function mount(props: Record<string, unknown> = {}) {
  return render(
    createElement(RunItemDrawer, {
      exampleId: "ex-1",
      item,
      loading: false,
      error: null,
      position: 1,
      total: 3,
      kpis: [],
      onClose: vi.fn(),
      ...props,
    } as never),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("promote orchestration", () => {
  it("loads the dataset list when the panel opens", async () => {
    stubApi();
    mount();
    fireEvent.click(screen.getByText("Promote to dataset"));
    await waitFor(() => {
      expect(screen.getByText("draft-ds")).toBeTruthy();
      expect(screen.getByText("pub-ds")).toBeTruthy();
    });
  });

  it("does not carry version consent from one dataset to another", async () => {
    stubApi();
    mount();
    fireEvent.click(screen.getByText("Promote to dataset"));
    await waitFor(() => screen.getByText("pub-ds"));

    fireEvent.click(screen.getByRole("radio", { name: /pub-ds/ }));
    const optIn = await screen.findByRole("checkbox");
    fireEvent.click(optIn);
    expect((optIn as HTMLInputElement).checked).toBe(true);

    // Switching to another dataset must drop the consent, not inherit it.
    fireEvent.click(screen.getByRole("radio", { name: /draft-ds/ }));
    fireEvent.click(screen.getByRole("radio", { name: /pub-ds/ }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("promotes through create-version and clears the outcome when the target changes", async () => {
    const calls = stubApi();
    mount();
    fireEvent.click(screen.getByText("Promote to dataset"));
    await waitFor(() => screen.getByText("pub-ds"));

    fireEvent.click(screen.getByRole("radio", { name: /pub-ds/ }));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByText("Create version and promote"));

    await waitFor(() => screen.getAllByText(/pub-ds_v2/));
    expect(screen.getByText(/validate, approve and publish/)).toBeTruthy();
    const promoteCall = calls.find((call) => call.url.includes("/promotions"));
    expect(promoteCall?.url).toBe("/api/eval-hub/datasets/pub-ds/promotions");
    expect(JSON.parse(String(promoteCall?.init?.body)).create_version_if_immutable).toBe(true);

    // A stale success must not survive picking a different target.
    fireEvent.click(screen.getByRole("radio", { name: /draft-ds/ }));
    expect(screen.queryByText(/validate, approve and publish/)).toBeNull();
  });

  it("resets the panel when navigation moves to another item", async () => {
    stubApi();
    const view = mount();
    fireEvent.click(screen.getByText("Promote to dataset"));
    await waitFor(() => screen.getByText("draft-ds"));

    view.rerender(
      createElement(RunItemDrawer, {
        exampleId: "ex-2",
        item: { ...item, example_id: "ex-2" } as RunItemDetail,
        loading: false,
        error: null,
        position: 2,
        total: 3,
        kpis: [],
        onClose: vi.fn(),
      } as never),
    );
    await waitFor(() => {
      expect(screen.queryByText("draft-ds")).toBeNull();
      expect(screen.getByText("Promote to dataset")).toBeTruthy();
    });
  });
});
