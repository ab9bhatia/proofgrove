/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContractProjectsPanel, ProjectCreateDialog } from "./contract-projects-panel";

const projects = [{
  project_id: "project-1",
  tenant_id: "tenant-classroom",
  name: "Support agent",
  system_type: "Agent",
  owner: "Evaluation team",
  status: "active" as const,
  tags: {},
}];

afterEach(cleanup);

describe("ContractProjectsPanel", () => {
  it("presents existing Project selection before creation", () => {
    const html = renderToStaticMarkup(createElement(ContractProjectsPanel, {
      projects,
      selectedProjectId: "project-1",
      createOpen: false,
      onSelect: vi.fn(),
      onCreateOpenChange: vi.fn(),
      onSubmit: vi.fn(),
    }));
    expect(html.indexOf("Support agent")).toBeLessThan(html.indexOf("New project"));
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('checked=""');
    expect(html).not.toContain("Archive Support agent");
  });

  it("shows retry guidance without duplicate creation on failure", () => {
    const html = renderToStaticMarkup(createElement(ContractProjectsPanel, {
      projects: [],
      selectedProjectId: "",
      createOpen: false,
      onSelect: vi.fn(),
      onCreateOpenChange: vi.fn(),
      onSubmit: vi.fn(),
      loadState: "error",
    }));
    expect(html).toContain("Projects could not be loaded");
    expect(html).toContain("Refresh to retry");
    expect(html).not.toContain("No projects yet");
    expect(html).not.toContain("New project");
  });

  it("selects from metadata and exposes the row-sized native radio focus target", () => {
    const onSelect = vi.fn();
    render(createElement(ContractProjectsPanel, {
      projects,
      selectedProjectId: "",
      createOpen: false,
      onSelect,
      onCreateOpenChange: vi.fn(),
      onSubmit: vi.fn(),
    }));

    fireEvent.click(screen.getByText("active"));
    expect(onSelect).toHaveBeenCalledWith("project-1");

    const radio = screen.getByRole("radio", { name: "Support agent, Agent, active, owned by Evaluation team" });
    expect(radio.className).toContain("inset-0");
    expect(radio.className).toContain("size-full");
    expect(radio.className).not.toContain("sr-only");
    expect(radio.nextElementSibling?.className).toContain("peer-focus-visible:ring-2");
    expect(radio.nextElementSibling?.className).toContain("peer-focus-visible:ring-ring");
  });
});

describe("ProjectCreateDialog", () => {
  it("keeps the existing minimal create fields", () => {
    // Rendered, not statically stringified: the dialog portals into document.body,
    // and the server renderer refuses portals even though jsdom has a document.
    render(createElement(ProjectCreateDialog, {
      submitting: false,
      actionsDisabled: false,
      onClose: vi.fn(),
      onSubmit: vi.fn(),
    }));
    const html = document.body.innerHTML;
    expect(html).toContain('for="project-name"');
    expect(html).toContain('for="project-owner"');
    expect(html).not.toContain('name="system_type"');
  });
});

describe("ProjectCreateDialog accessible validation", () => {
  afterEach(cleanup);

  it("names the field at fault instead of relying on the browser alone", () => {
    // Native `required` blocks the submit, but the message it shows is not
    // associated with the input, so a screen reader user is told the form is
    // invalid without being told which field to fix.
    const onSubmit = vi.fn();
    render(
      createElement(ProjectCreateDialog, {
        submitting: false,
        actionsDisabled: false,
        onClose: () => {},
        onSubmit,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /create project/i }));

    const name = screen.getByLabelText(/project name/i);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe("project-name-error");
    expect(screen.getByText(/give the project a name/i).getAttribute("role")).toBe("alert");
    // The submit does not reach the caller while the form is incomplete.
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
