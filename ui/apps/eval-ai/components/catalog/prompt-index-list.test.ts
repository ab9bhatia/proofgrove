/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { PromptIndexList } from "@/components/catalog/prompt-index-list";
import type { PromptVersion } from "@/lib/api";
import type { GroupedPrompt } from "@/lib/prompts";

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

function group(versions: PromptVersion[], promptId = "support"): GroupedPrompt {
  return { promptId, name: "Support", versions };
}

afterEach(() => {
  cleanup();
});

describe("PromptIndexList", () => {
  it("makes the whole row the link, not just the name", () => {
    // The dataset picker shipped with its button inside one cell, so clicking
    // anywhere else in a row did nothing and every test still passed. Assert the
    // structure: the row's content lives inside the anchor.
    render(createElement(PromptIndexList, { prompts: [group([version()])] }));

    const link = screen.getByRole("link");
    expect(link.textContent).toContain("Support");
    expect(link.textContent).toContain("support");
    expect(link.textContent).toContain("Be concise.");
  });

  it("points at the prompt's own page, with the id escaped", () => {
    render(
      createElement(PromptIndexList, {
        prompts: [group([version({ prompt_id: "a b" })], "a b")],
      }),
    );
    expect(screen.getByRole("link").getAttribute("href")).toBe("/catalog/prompts/a%20b");
  });

  it("names the live version, or says plainly that there is none", () => {
    expect(
      renderToStaticMarkup(
        createElement(PromptIndexList, {
          prompts: [group([version({ version: 3, labels: ["production"] })])],
        }),
      ),
    ).toContain("production · v3");

    expect(
      renderToStaticMarkup(
        createElement(PromptIndexList, { prompts: [group([version()])] }),
      ),
    ).toContain("no production version");
  });

  it("counts the versions behind each prompt", () => {
    const html = renderToStaticMarkup(
      createElement(PromptIndexList, {
        prompts: [group([version({ version: 2 }), version({ version: 1 })])],
      }),
    );
    expect(html).toContain("2 versions");
  });

  it("previews the live version rather than whichever is newest", () => {
    // Production is what an evaluation resolves, so it is the line worth showing.
    const html = renderToStaticMarkup(
      createElement(PromptIndexList, {
        prompts: [
          group([
            version({ version: 3, content: "An unreleased draft." }),
            version({ version: 2, content: "The live one.", labels: ["production"] }),
          ]),
        ],
      }),
    );
    expect(html).toContain("The live one.");
    expect(html).not.toContain("An unreleased draft.");
  });
});

describe("the prompt list names its columns", () => {
  it("renders a header for the grid the rows already use", () => {
    // The rows were a four-column grid with nothing naming the columns, so the
    // layout read as cards and the alignment looked accidental.
    const html = renderToStaticMarkup(
      createElement(PromptIndexList, { prompts: [group([version()])] }),
    );

    for (const column of ["Prompt", "Production", "Versions"]) {
      expect(html).toContain(`>${column}<`);
    }
  });
});
