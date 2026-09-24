import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TargetVersion } from "@/lib/api";
import { AgentCatalogList } from "@/components/catalog/agent-catalog-list";

const agent: TargetVersion = {
  target_version_id: "version-1",
  target_id: "agent-1",
  project_id: "project-1",
  tenant_id: "tenant-classroom",
  name: "Support Assistant",
  version: "kagent-abc123",
  endpoint: "http://agent.example.test/api/a2a/support-assistant",
  target_type: "agent",
  environment: "cluster",
  model_version: "gpt-5.1",
  tool_versions: { search: "discovered" },
  configuration: {
    catalog_source: "kagent_discovery",
    agent_card: {
      description: "Resolves customer support requests.",
      protocolVersion: "kagent-a2a",
      skills: [{ id: "search", name: "Search" }],
    },
  },
};

describe("AgentCatalogList", () => {
  it("leads with agent identity and keeps technical metadata in disclosure details", () => {
    const html = renderToStaticMarkup(createElement(AgentCatalogList, { agents: [agent] }));

    expect(html).toContain('aria-label="Onboarded agents"');
    expect(html).toContain('role="listitem"');
    expect(html).toContain(">Agent<");
    expect(html).toContain(">Model<");
    expect(html).toContain(">Environment<");
    expect(html).toContain("Support Assistant");
    expect(html).toMatch(/<p[^>]*translate="no"[^>]*>agent-1<\/p>/);
    expect(html.indexOf("Support Assistant")).toBeLessThan(
      html.indexOf("http://agent.example.test/api/a2a/support-assistant"),
    );
    // Source is a column now, in the same plain text as Model and Environment.
    // It was a green tick badge in both states, so it marked every row as good
    // and distinguished nothing.
    expect(html).toContain("Source");
    expect(html).toContain("Platform");
    expect(html).not.toContain("Platform synced");
    expect(html).toContain("gpt-5.1");
    expect(html).toContain("Connection details");
    expect(html).toContain("Resolves customer support requests.");
    expect(html).toContain("agent-1");
    expect(html).toContain("kagent-abc123");
    expect(html).toContain("kagent-a2a");
    expect(html).toContain("Search");
    expect(html).toContain("http://agent.example.test/api/a2a/support-assistant");
    expect(html).toContain("min-h-11");
    expect(html).toContain("focus-visible:ring");
    expect(html).toContain("overflow-x-auto");
  });
});
