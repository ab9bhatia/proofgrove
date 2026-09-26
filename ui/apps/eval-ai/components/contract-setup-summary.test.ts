import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SetupCompletionSummary } from "@/app/contracts/new/page";

describe("SetupCompletionSummary", () => {
  it("keeps the saved setup readable and exposes all resolved choices", () => {
    const html = renderToStaticMarkup(
      createElement(SetupCompletionSummary, {
        project: { project_id: "project-1", tenant_id: "tenant-1", name: "Support", system_type: "agent", owner: "Eval", status: "active" },
        target: { target_version_id: "target-version-1", target_id: "support-agent", project_id: "project-1", tenant_id: "tenant-1", name: "Support agent", version: "1.0.0", endpoint: "https://example.com", target_type: "agent", environment: "dev", tool_versions: {}, configuration: {} },
        profile: { profile_id: "quality-1", version: "1.0.0", tenant_id: "tenant-1", project_id: "project-1", name: "Agent quality", status: "approved", scenario: "agentic", metric_ids: ["agent.task_completion"], evidence_requirements: ["input", "final_output"], hard_blocker_metric_ids: [], approver_roles: [] },
        policy: null,
        manifest: { manifest_id: "manifest-1", manifest_hash: "hash-1", tenant_id: "tenant-1", project_id: "project-1", target_version_id: "target-version-1", target_id: "support-agent", target_version: "1.0.0", target_endpoint: "https://example.com", target_type: "agent", environment: "dev", quality_profile_id: "quality-1", quality_profile_version: "1.0.0", gate_policy_id: null, gate_policy_version: null, scenario: "agentic", metric_ids: ["agent.task_completion"], evaluator_refs: {}, metric_pack_refs: [], metric_definitions: [], kpi_threshold_overrides: {}, hard_blocker_metric_ids: [], evidence_requirements: ["input", "final_output"], review_trigger_gates: [], approver_roles: [], judge_config: {}, model_version: null, prompt_version: null, tool_versions: {}, resolved_at: "2026-08-15T00:00:00Z", resolved_by: "proofgrove-ui" },
        onEdit: vi.fn(),
        assignment: {
          assignment_id: "support-assignment",
          version: "1.0.0",
          tenant_id: "tenant-1",
          name: "Support assignment",
          project_id: "project-1",
          target_version_id: "target-version-1",
          profile_id: "quality-1",
          profile_version: "1.0.0",
          run_manifest_id: "manifest-1",
          governance_state: "standardized_evaluation",
        },
      }),
    );

    expect(html).toContain("Saved successfully");
    expect(html).toContain("Assignment saved");
    expect(html).toContain("Quality Profile");
    expect(html).toContain("No Gate Policy");
    expect(html).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(html).toContain("max-w-[42rem]");
    expect(html).toContain("Resolved configuration");
    expect(html).toContain("Evidence required");
    expect(html).toContain("Run evaluation with this Assignment");
    expect(html).toContain("/evaluate?assignment=support-assignment&amp;assignmentVersion=1.0.0");
    expect(html).toContain("View details");
    expect(html).toContain("Copy link");
    expect(html).toContain("Create revision");
    expect(html).toContain("Standardized evaluation");
    expect(html).not.toContain("Release blockers");
  });
});
