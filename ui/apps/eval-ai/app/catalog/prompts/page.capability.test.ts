/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/eval-hub-gate", () => ({
  EvalHubGate: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/lib/api", () => ({
  api: { tenant: vi.fn() },
  platformApi: {
    listPrompts: vi.fn(),
    listPromptPage: vi.fn(),
    capabilities: vi.fn(),
    savePrompt: vi.fn(),
    movePromptLabel: vi.fn(),
    archivePromptVersion: vi.fn(),
  },
}));

import { api, platformApi } from "@/lib/api";
import PromptCatalogPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const prompt = {
  prompt_id: "support",
  version: 2,
  tenant_id: "tenant-classroom",
  name: "Support",
  content: "Be concise.",
  content_hash: "abc",
  labels: [],
};

/** `granted: null` stands for a capabilities lookup that fails outright. */
function arrange(granted: boolean | null) {
  vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "tenant-classroom" } as never);
  vi.mocked(platformApi.listPromptPage).mockResolvedValue({
    items: [prompt],
    total: 1,
    limit: 50,
    offset: 0,
    next_cursor: null,
  } as never);
  vi.mocked(platformApi.capabilities).mockImplementation(() =>
    granted === null
      ? Promise.reject(new Error("capabilities unavailable"))
      : (Promise.resolve({ actions: { manage_prompts: granted } }) as never),
  );
}

describe("prompt index write affordances", () => {
  it("offers saving to an approver", async () => {
    arrange(true);
    render(createElement(PromptCatalogPage));

    expect(await screen.findByRole("button", { name: /New prompt/ })).toBeTruthy();
  });

  it("keeps promotion and archiving off the index entirely", async () => {
    // Both act on one version, and the index deliberately shows none — they
    // live on the prompt's own page, next to the text they change.
    arrange(true);
    render(createElement(PromptCatalogPage));

    expect(await screen.findByText("Support")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make production" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Archive/ })).toBeNull();
  });

  it("loads a page of prompts and offers the rest", async () => {
    // A page holds whole prompts, so appending can never split one across pages.
    arrange(true);
    vi.mocked(platformApi.listPromptPage).mockResolvedValueOnce({
      items: [prompt],
      total: 3,
      limit: 50,
      offset: 0,
      next_cursor: "50",
    } as never);
    render(createElement(PromptCatalogPage));

    expect(await screen.findByRole("button", { name: /^Next$/ })).toBeTruthy();
    expect(screen.getByText("Page 1 of 1")).toBeTruthy();
  });

  it("says a search only covers what has loaded", async () => {
    // Otherwise a search reports "no matches" for pages it never fetched.
    arrange(true);
    vi.mocked(platformApi.listPromptPage).mockResolvedValueOnce({
      items: [prompt],
      total: 3,
      limit: 50,
      offset: 0,
      next_cursor: "50",
    } as never);
    render(createElement(PromptCatalogPage));

    await screen.findByRole("button", { name: /^Next$/ });
    fireEvent.change(screen.getByLabelText("Search prompts"), { target: { value: "Support" } });
    expect(await screen.findByText("Searching 1 loaded of 3 prompts. Next searches the next batch.")).toBeTruthy();
  });

  it("keeps the load control reachable when a search matches nothing loaded", async () => {
    // The dead end this replaces: "No prompts match this search" with no way to
    // fetch the pages that might hold the match.
    arrange(true);
    vi.mocked(platformApi.listPromptPage).mockResolvedValueOnce({
      items: [prompt],
      total: 3,
      limit: 50,
      offset: 0,
      next_cursor: "50",
    } as never);
    render(createElement(PromptCatalogPage));

    await screen.findByRole("button", { name: /^Next$/ });
    fireEvent.change(screen.getByLabelText("Search prompts"), { target: { value: "zzzz" } });

    expect(await screen.findByText("No prompts match this search")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Next$/ })).toBeTruthy();
    expect(screen.getByText("Only the prompts loaded so far have been searched.")).toBeTruthy();
  });

  it("discards a load-more page that a refresh has already superseded", async () => {
    // Otherwise the stale page appends on top of the refreshed list and replaces
    // the new cursor — duplicating a prompt, or skipping a page entirely.
    arrange(true);
    vi.mocked(platformApi.listPromptPage).mockResolvedValueOnce({
      items: [prompt],
      total: 3,
      limit: 50,
      offset: 0,
      next_cursor: "50",
    } as never);
    render(createElement(PromptCatalogPage));
    await screen.findByRole("button", { name: /^Next$/ });

    // The second page never resolves until after the refresh below has landed.
    let releaseStalePage: (value: unknown) => void = () => {};
    vi.mocked(platformApi.listPromptPage).mockImplementationOnce(
      () => new Promise((resolve) => { releaseStalePage = resolve; }) as never,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

    // A refresh lands first and owns the list.
    vi.mocked(platformApi.listPromptPage).mockResolvedValueOnce({
      items: [{ ...prompt, prompt_id: "fresh", name: "Fresh" }],
      total: 1,
      limit: 50,
      offset: 0,
      next_cursor: null,
    } as never);
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(await screen.findByText("Fresh")).toBeTruthy();

    releaseStalePage({ items: [{ ...prompt, prompt_id: "stale", name: "Stale" }], total: 3, limit: 50, offset: 50, next_cursor: "100" });

    await waitFor(() => expect(screen.queryByText("Stale")).toBeNull());
    // And the refreshed cursor survives: everything is loaded, so no control.
    expect(screen.getByRole("button", { name: /^Next$/ })).toHaveProperty("disabled", true);
  });

  it("hides the load control once everything is loaded", async () => {
    arrange(true);
    render(createElement(PromptCatalogPage));

    expect(await screen.findByText("Support")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Next$/ })).toHaveProperty("disabled", true);
  });

  it("links each row through to the prompt's own page", async () => {
    arrange(true);
    render(createElement(PromptCatalogPage));

    const link = await screen.findByRole("link", { name: /Support/ });
    expect(link.getAttribute("href")).toBe("/catalog/prompts/support");
  });

  it("answers a bad prompt id on the form, without a round trip", async () => {
    arrange(true);
    render(createElement(PromptCatalogPage));

    fireEvent.click(await screen.findByRole("button", { name: /New prompt/ }));
    fireEvent.change(screen.getByLabelText("Prompt id"), { target: { value: "support tone" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Be terse." } });
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    // The commonest mistake is answered here rather than as a generic 422 that
    // says only "some information is invalid".
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("No spaces"),
    );
    expect(platformApi.savePrompt).not.toHaveBeenCalled();
  });

  it("hides both from a caller the API would refuse", async () => {
    arrange(false);
    render(createElement(PromptCatalogPage));

    // The library itself still loads — this is a read-only view, not an error.
    expect(await screen.findByText("Support")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New prompt/ })).toBeNull();
  });

  it("falls back to read-only when the capability lookup itself fails", async () => {
    arrange(null);
    render(createElement(PromptCatalogPage));

    // Degrading to read-only beats blanking a catalog that loaded fine.
    expect(await screen.findByText("Support")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New prompt/ })).toBeNull();
  });
});

it("moves between whole prompt pages and resets to the first page on search", async () => {
  arrange(false);
  const first = Array.from({length: 20}, (_, i) => ({...prompt, prompt_id: `a${String(i).padStart(2, "0")}`, name: `Prompt ${i}`}));
  vi.mocked(platformApi.listPromptPage)
    .mockResolvedValueOnce({items: first, total: 21, next_cursor: "20"} as never)
    .mockResolvedValueOnce({items: [{...prompt, prompt_id: "0-late", name: "Last prompt"}], total: 21, next_cursor: null} as never);
  render(createElement(PromptCatalogPage));
  await screen.findByText("Prompt 0");
  fireEvent.click(screen.getByRole("button", {name: "Next"}));
  expect(await screen.findByText("Last prompt")).toBeTruthy();
  expect(screen.queryByText("Prompt 0")).toBeNull();
  expect(platformApi.listPromptPage).toHaveBeenLastCalledWith(20, "20");
  fireEvent.click(screen.getByRole("button", {name: "Previous"}));
  expect(await screen.findByText("Prompt 0")).toBeTruthy();
  expect(platformApi.listPromptPage).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText("Search prompts"), {target: {value: "Last prompt"}});
  expect(await screen.findByText("Last prompt")).toBeTruthy();
  expect(screen.getByRole("button", {name: "Previous"})).toHaveProperty("disabled", true);
});

it("fills a partial search page before advancing into newly fetched matches", async () => {
  arrange(false);
  const first = Array.from({length: 20}, (_, i) => ({...prompt, prompt_id: `a${i}`, name: i < 5 ? `Match ${i}` : `Other ${i}`}));
  const second = Array.from({length: 20}, (_, i) => ({...prompt, prompt_id: `b${i}`, name: `Match ${i + 5}`}));
  vi.mocked(platformApi.listPromptPage)
    .mockResolvedValueOnce({items: first, total: 40, next_cursor: "20"} as never)
    .mockResolvedValueOnce({items: second, total: 40, next_cursor: null} as never);
  render(createElement(PromptCatalogPage));
  await screen.findByText("Match 0");
  fireEvent.change(screen.getByLabelText("Search prompts"), {target: {value: "Match"}});
  fireEvent.click(screen.getByRole("button", {name: "Next"}));
  expect(await screen.findByText("Match 5")).toBeTruthy();
  expect(screen.getByText("Match 19")).toBeTruthy();
  expect(screen.queryByText("Match 20")).toBeNull();
  expect(screen.getByText("Page 1 of 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name: "Next"}));
  expect(await screen.findByText("Match 20")).toBeTruthy();
  expect(platformApi.listPromptPage).toHaveBeenCalledTimes(2);
});
