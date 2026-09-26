import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "run-1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { runLoadErrorMessage, runReportRequest } from "./page";
import { runEvidenceHref } from "@/app/reviews/page";
import { ApiError } from "@/lib/api-errors";

describe("runReportRequest", () => {
  it("decodes the route segment once and reads the item deep-link params", () => {
    const request = runReportRequest(
      "run%2F123",
      new URLSearchParams("item=case-1&caseFilter=attention"),
    );
    expect(request).toEqual({ runId: "run/123", itemId: "case-1", caseFilter: "attention" });
  });

  it("defaults to no item and the unfiltered case view", () => {
    expect(runReportRequest("run-1", new URLSearchParams())).toEqual({
      runId: "run-1",
      itemId: null,
      caseFilter: "all",
    });
    // Unknown filters and blank items must not leak into report state.
    expect(
      runReportRequest("run-1", new URLSearchParams("item=%20%20&caseFilter=bogus")),
    ).toEqual({ runId: "run-1", itemId: null, caseFilter: "all" });
  });

  it("round-trips the reviews page's run-evidence deep link", () => {
    // Regression: review -> case deep link. The href the reviews page builds
    // must parse back to the exact run id + row id the finding referenced,
    // including ids that need percent-encoding.
    const finding = { run_id: "run/xyz+1", row_id: "row 7cfd:501a" };
    const href = runEvidenceHref(finding);
    const url = new URL(href, "https://proofgrove.test");
    const [, , rawId] = url.pathname.split("/");
    const request = runReportRequest(rawId, url.searchParams);
    expect(request.runId).toBe(finding.run_id);
    expect(request.itemId).toBe(finding.row_id);
  });
});

describe("runLoadErrorMessage", () => {
  const notFound = new ApiError({
    status: 404,
    code: "NOT_FOUND",
    message: "The requested item could not be found.",
  });

  it("explains a tenant-scoped 404 on a review deep link instead of the generic copy", () => {
    const message = runLoadErrorMessage(notFound, "case-1");
    expect(message).toContain("not readable in this workspace");
    expect(message).not.toBe("The requested item could not be found.");
  });

  it("explains a 404 without a deep link as a workspace-scoped miss", () => {
    expect(runLoadErrorMessage(notFound, null)).toContain("not found in this workspace");
  });

  it("keeps the standard copy for non-404 failures", () => {
    const unavailable = new ApiError({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Part of Proofgrove is temporarily unavailable. Try again shortly.",
    });
    expect(runLoadErrorMessage(unavailable, "case-1")).toBe(
      "Part of Proofgrove is temporarily unavailable. Try again shortly.",
    );
    expect(runLoadErrorMessage(new Error("boom"), null)).toBeTruthy();
  });
});
