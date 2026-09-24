import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProjectCard, visibleTraceProjects } from "./page";
import type { TraceProject } from "@/lib/api";

const project: TraceProject = {
  project_id: "project-1",
  tenant_id: "tenant-1",
  name: "Support agent",
  system_type: "agent",
  owner: "quality",
  status: "active",
  purpose: "system",
  trace_count: 2,
  last_activity_at: null,
  classification_state: "classified",
};

describe("project archiving", () => {
  it("filters archived projects by default and restores them on request", () => {
    const archived = { ...project, project_id: "project-2", status: "archived" as const };
    expect(visibleTraceProjects([project, archived], false)).toEqual([project]);
    expect(visibleTraceProjects([project, archived], true)).toEqual([project, archived]);
  });

  it("labels archived projects and only offers archive on active projects", () => {
    const activeHtml = renderToStaticMarkup(createElement(ProjectCard, {
      project,
      onArchive: () => undefined,
    }));
    const archivedHtml = renderToStaticMarkup(createElement(ProjectCard, {
      project: { ...project, status: "archived" },
      onArchive: () => undefined,
    }));

    expect(activeHtml).toContain('aria-label="Archive project Support agent"');
    expect(archivedHtml).toContain("Archived");
    expect(archivedHtml).not.toContain('aria-label="Archive project');
  });
});

describe("archived project actions", () => {
  function render(overrides: Partial<TraceProject>) {
    return renderToStaticMarkup(createElement(ProjectCard, {
      project: { ...project, ...overrides },
      onArchive: () => undefined,
      onRestore: () => undefined,
      onDelete: () => undefined,
    }));
  }

  it("offers restore and delete on an archived project, and neither on an active one", () => {
    const archivedHtml = render({ status: "archived" });
    expect(archivedHtml).toContain('aria-label="Restore project Support agent"');
    expect(archivedHtml).toContain('aria-label="Delete project Support agent"');

    // Delete is reachable only from the archived view, so removing a project
    // is always two decisions rather than one click from the active list.
    const activeHtml = render({ status: "active" });
    expect(activeHtml).toContain('aria-label="Archive project Support agent"');
    expect(activeHtml).not.toContain('aria-label="Delete project');
    expect(activeHtml).not.toContain('aria-label="Restore project');
  });

  it("never offers a lifecycle action on the unassigned project", () => {
    const html = render({ project_id: "unassigned", status: "archived" });
    expect(html).not.toContain('aria-label="Delete project');
    expect(html).not.toContain('aria-label="Restore project');
    expect(html).not.toContain('aria-label="Archive project');
  });
});
