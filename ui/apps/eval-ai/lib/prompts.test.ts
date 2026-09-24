import { describe, expect, it } from "vitest";

import type { PromptVersion } from "@/lib/api";
import type { GroupedPrompt } from "@/lib/prompts";
import {
  decodePromptId,
  groupPromptVersions,
  leadVersion,
  productionVersion,
  promptIdProblem,
  promptPreview,
  promptRef,
} from "@/lib/prompts";

function version(overrides: Partial<PromptVersion> & { version: number }): PromptVersion {
  return {
    prompt_id: "support",
    tenant_id: "tenant-classroom",
    name: "Support",
    content: "Be concise.",
    content_hash: "abc",
    labels: [],
    ...overrides,
  };
}

describe("groupPromptVersions", () => {
  it("puts the newest version first", () => {
    const [group] = groupPromptVersions([version({ version: 1 }), version({ version: 3 })]);
    expect(group.versions.map((entry) => entry.version)).toEqual([3, 1]);
  });

  it("takes the name from the newest version, so a rename does not rewrite history", () => {
    const [group] = groupPromptVersions([
      version({ version: 1, name: "Old name" }),
      version({ version: 2, name: "New name" }),
    ]);
    expect(group.name).toBe("New name");
  });

  it("filters on id, name and the prompt text", () => {
    const versions = [
      version({ version: 1, prompt_id: "support", content: "Be concise." }),
      version({ version: 1, prompt_id: "sales", name: "Sales", content: "Be persuasive." }),
    ];
    expect(groupPromptVersions(versions, "persuasive")).toHaveLength(1);
    expect(groupPromptVersions(versions, "support")).toHaveLength(1);
    expect(groupPromptVersions(versions, "be ")).toHaveLength(2);
  });
});

describe("promptRef", () => {
  it("is the form the API resolves", () => {
    expect(promptRef(version({ version: 4 }))).toBe("support@4");
  });
});

describe("promptPreview", () => {
  it("flattens whitespace so a multi-line prompt reads as one row", () => {
    expect(promptPreview("Be\n  concise.\n\nAlways.")).toBe("Be concise. Always.");
  });

  it("truncates past the limit and leaves shorter text alone", () => {
    expect(promptPreview("x".repeat(200), 10)).toBe("xxxxxxxxx…");
    expect(promptPreview("short", 10)).toBe("short");
  });
});

describe("promptIdProblem", () => {
  it("accepts the shapes the server accepts", () => {
    expect(promptIdProblem("support-tone")).toBeNull();
    expect(promptIdProblem("support.tone_2")).toBeNull();
  });

  it("names the spaces case specifically, since the field reads like a name", () => {
    expect(promptIdProblem("support tone")).toContain("No spaces");
  });

  it("rejects an empty id and one that cannot start the key", () => {
    expect(promptIdProblem("   ")).toBe("Give the prompt an id.");
    expect(promptIdProblem("-leading")).toContain("starting with a letter or number");
    expect(promptIdProblem("has@at")).toContain("letters, numbers");
  });
});

describe("which version leads", () => {
  function version(overrides: Partial<PromptVersion> = {}): PromptVersion {
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
  const group = (versions: PromptVersion[]): GroupedPrompt => ({
    promptId: "support",
    name: "Support",
    versions,
  });

  it("finds the labelled version, or null", () => {
    expect(productionVersion(group([version({ version: 3, labels: ["production"] })]))).toBe(3);
    expect(productionVersion(group([version({ version: 1, labels: ["staging"] })]))).toBeNull();
    expect(productionVersion(group([]))).toBeNull();
  });

  it("leads with production when it is set", () => {
    // Not the newest: production is the version an evaluation actually resolves.
    const prompt = group([version({ version: 3 }), version({ version: 2, labels: ["production"] })]);
    expect(leadVersion(prompt)?.version).toBe(2);
  });

  it("falls back to the newest when nothing is live", () => {
    expect(leadVersion(group([version({ version: 3 }), version({ version: 1 })]))?.version).toBe(3);
    expect(leadVersion(group([]))).toBeNull();
  });
});

describe("decoding a prompt id from the address", () => {
  it("decodes an escaped id", () => {
    expect(decodePromptId("support%20tone")).toBe("support tone");
  });

  it("survives a malformed escape instead of throwing", () => {
    // `decodeURIComponent` raises URIError here, and a throw during render
    // blanks the page. An unreadable id should land on "no such prompt".
    expect(decodePromptId("%")).toBe("%");
    expect(decodePromptId("a%zz")).toBe("a%zz");
  });
});

describe("searching the prompt library", () => {
  function v(overrides: Partial<PromptVersion> & { version: number }): PromptVersion {
    return {
      prompt_id: "support",
      tenant_id: "tenant-classroom",
      name: "Support",
      content: "",
      content_hash: "abc",
      labels: [],
      ...overrides,
    };
  }

  it("keeps the whole prompt when any version matches", () => {
    // Filtering versions rather than prompts hid the live version: a search
    // matching only v1 produced a group that reported no production version.
    const groups = groupPromptVersions(
      [
        v({ version: 1, content: "Explain the refund policy." }),
        v({ version: 2, content: "Be concise.", labels: ["production"] }),
      ],
      "refund",
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.versions.map((entry) => entry.version)).toEqual([2, 1]);
    expect(productionVersion(groups[0]!)).toBe(2);
    expect(leadVersion(groups[0]!)?.version).toBe(2);
  });

  it("drops prompts where nothing matches", () => {
    expect(groupPromptVersions([v({ version: 1, content: "Be concise." })], "refund")).toEqual([]);
  });
});
