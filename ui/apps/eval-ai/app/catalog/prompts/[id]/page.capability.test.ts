/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/proofgrove-gate", () => ({
  ProofgroveGate: ({ children }: { children: React.ReactNode }) => children,
}));

const query = vi.hoisted(() => ({ value: "" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "support" }),
  useSearchParams: () => new URLSearchParams(query.value),
}));

vi.mock("@/lib/api", () => ({
  api: { tenant: vi.fn() },
  platformApi: {
    listPrompts: vi.fn(),
    capabilities: vi.fn(),
    savePrompt: vi.fn(),
    movePromptLabel: vi.fn(),
    archivePromptVersion: vi.fn(),
  },
}));

import { api, platformApi } from "@/lib/api";
import PromptDetailPage from "./page";

afterEach(() => {
  cleanup();
  query.value = "";
  vi.clearAllMocks();
});

function version(overrides: Record<string, unknown> = {}) {
  return {
    prompt_id: "support",
    version: 2,
    tenant_id: "tenant-classroom",
    name: "Support",
    content: "Be concise.",
    content_hash: "abc",
    labels: [],
    ...overrides,
  };
}

/** `granted: null` stands for a capabilities lookup that fails outright. */
function arrange(granted: boolean | null, versions = [version()]) {
  vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "tenant-classroom" } as never);
  vi.mocked(platformApi.listPrompts).mockResolvedValue(versions as never);
  vi.mocked(platformApi.capabilities).mockImplementation(() =>
    granted === null
      ? Promise.reject(new Error("capabilities unavailable"))
      : (Promise.resolve({ actions: { manage_prompts: granted } }) as never),
  );
}

/**
 * The reading pane. Scoped deliberately: the rail previews every version, so a
 * bare text query matches the open body twice and says nothing about which
 * surface it came from.
 */
async function pane() {
  return (await screen.findByRole("article")).textContent ?? "";
}

describe("prompt detail page", () => {
  it("asks the API for this prompt alone, not the whole catalog", async () => {
    arrange(true);
    render(createElement(PromptDetailPage));

    await waitFor(() => expect(platformApi.listPrompts).toHaveBeenCalledWith("support", true));
  });

  it("shows the prompt text in full rather than a clamped preview", async () => {
    const body = "Be concise.\n\nAlways cite the source paragraph.";
    arrange(true, [version({ content: body })]);
    render(createElement(PromptDetailPage));

    // The whole body is on the page, selectable — the reason the split exists.
    expect(await pane()).toContain(body);
  });

  it("leads with the live version, not the newest", async () => {
    arrange(true, [
      version({ version: 3, content: "An unreleased draft." }),
      version({ version: 2, content: "The live one.", labels: ["production"] }),
    ]);
    render(createElement(PromptDetailPage));

    expect(await pane()).toContain("The live one.");
    expect(await pane()).not.toContain("An unreleased draft.");
  });

  it("swaps the reading pane to whichever version is chosen", async () => {
    arrange(true, [
      version({ version: 3, content: "The newest draft." }),
      version({ version: 2, content: "An older one." }),
    ]);
    render(createElement(PromptDetailPage));

    expect(await pane()).toContain("The newest draft.");
    fireEvent.click(screen.getByRole("button", { name: /v2/ }));
    await waitFor(async () => expect(await pane()).toContain("An older one."));
  });

  it("offers promotion only for a version that is not already live", async () => {
    arrange(true, [version({ version: 2, labels: ["production"] })]);
    render(createElement(PromptDetailPage));

    expect(await pane()).toContain("Be concise.");
    expect(screen.queryByRole("button", { name: "Make production" })).toBeNull();
    // Retiring the live version is still legitimate; the server drops the label.
    expect(screen.getByRole("button", { name: /Archive/ })).toBeTruthy();
  });

  it("moves the production label to the open version", async () => {
    arrange(true);
    vi.mocked(platformApi.movePromptLabel).mockResolvedValue(version() as never);
    render(createElement(PromptDetailPage));

    fireEvent.click(await screen.findByRole("button", { name: "Make production" }));
    await waitFor(() =>
      expect(platformApi.movePromptLabel).toHaveBeenCalledWith("support", "production", {
        tenant_id: "tenant-classroom",
        version: 2,
      }),
    );
  });

  it("archives only after the confirm step, then re-reads", async () => {
    arrange(true);
    vi.mocked(platformApi.archivePromptVersion).mockResolvedValue({
      ...version(),
      archived_at: "2026-08-27T00:00:00Z",
    } as never);
    render(createElement(PromptDetailPage));

    fireEvent.click(await screen.findByRole("button", { name: /Archive version 2/ }));
    // Archiving is one-way from here, so the click alone must not do it.
    expect(platformApi.archivePromptVersion).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "Archive version" }));
    await waitFor(() =>
      expect(platformApi.archivePromptVersion).toHaveBeenCalledWith(
        "support",
        2,
        "tenant-classroom",
      ),
    );
    await waitFor(() => expect(vi.mocked(platformApi.listPrompts).mock.calls.length).toBe(2));
  });

  it("saves a new version against this prompt, whatever is typed", async () => {
    arrange(true);
    vi.mocked(platformApi.savePrompt).mockResolvedValue(version({ version: 3 }) as never);
    render(createElement(PromptDetailPage));

    fireEvent.click(await screen.findByRole("button", { name: /New version/ }));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Be terse." } });
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    await waitFor(() =>
      expect(platformApi.savePrompt).toHaveBeenCalledWith({
        tenant_id: "tenant-classroom",
        prompt_id: "support",
        name: "Support",
        content: "Be terse.",
      }),
    );
  });

  it("edits by seeding the next version, never by overwriting the open one", async () => {
    // Runs cite `prompt-id@version` for provenance, so a version is immutable.
    // Editing must produce a new version carrying the edited text.
    arrange(true, [version({ version: 2, content: "Be concise." })]);
    vi.mocked(platformApi.savePrompt).mockResolvedValue(version({ version: 3 }) as never);
    render(createElement(PromptDetailPage));

    fireEvent.click(await screen.findByRole("button", { name: "Edit version 2" }));
    // The form opens holding the text being edited, not an empty box.
    const field = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    expect(field.value).toBe("Be concise.");
    // And it says plainly that the original survives.
    expect(screen.getByText(/Version 2 is left as it is/)).toBeTruthy();

    fireEvent.change(field, { target: { value: "Be concise. Cite sources." } });
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    await waitFor(() =>
      expect(platformApi.savePrompt).toHaveBeenCalledWith({
        tenant_id: "tenant-classroom",
        prompt_id: "support",
        name: "Support",
        content: "Be concise. Cite sources.",
      }),
    );
    // No update/delete call exists for a version, and none is invented here.
    expect(platformApi.archivePromptVersion).not.toHaveBeenCalled();
  });

  it("opens a blank form for a fresh version, not the last one edited", async () => {
    arrange(true, [version({ version: 2, content: "Be concise." })]);
    render(createElement(PromptDetailPage));

    fireEvent.click(await screen.findByRole("button", { name: "Edit version 2" }));
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Be concise.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: /New version/ }));
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("");
  });

  it("hides every write from a caller the API would refuse", async () => {
    arrange(false);
    render(createElement(PromptDetailPage));

    // The prompt still reads fine — this is a read-only view, not an error.
    expect(await pane()).toContain("Be concise.");
    expect(screen.queryByRole("button", { name: /New version/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make production" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Archive/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit version/ })).toBeNull();
    // Copying is reading, not writing — it survives read-only access.
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeTruthy();
  });

  it("falls back to read-only when the capability lookup itself fails", async () => {
    arrange(null);
    render(createElement(PromptDetailPage));

    expect(await pane()).toContain("Be concise.");
    expect(screen.queryByRole("button", { name: /New version/ })).toBeNull();
  });

  it("says so plainly when the id in the address matches nothing", async () => {
    arrange(true, []);
    render(createElement(PromptDetailPage));

    expect(await screen.findByText("No such prompt")).toBeTruthy();
  });
});


it("opens read-only comparison from version history, including archived versions", async () => {
  arrange(false, [version(), version({ version: 1, content: "Be detailed.", archived_at: "2026-09-01" })]);
  render(createElement(PromptDetailPage));
  fireEvent.click(await screen.findByRole("button", { name: "Compare version 1" }));
  expect(screen.getByRole("region", { name: "Compare prompt versions" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Base version" })).toHaveProperty("value", "1");
  expect(screen.getAllByRole("option", { name: "Version 1 · Archived" })).toHaveLength(2);
  expect(platformApi.savePrompt).not.toHaveBeenCalled();
});

it("opens the saved replay version from a comparison link", async () => {
  query.value = "compare=1";
  arrange(false, [version(), version({version: 1, content: "Older prompt"})]);
  render(createElement(PromptDetailPage));
  await screen.findByRole("region", {name: "Compare prompt versions"});
  expect(screen.getByRole("combobox", {name: "Base version"})).toHaveProperty("value", "1");
  fireEvent.click(screen.getByRole("button", {name: "Close comparison"}));
  expect(screen.queryByRole("region", {name: "Compare prompt versions"})).toBeNull();
});
