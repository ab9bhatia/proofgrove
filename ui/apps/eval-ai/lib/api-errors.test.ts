import { describe, expect, it } from "vitest";
import {
  ApiError,
  apiErrorFromResponse,
  classifyProofgroveGate,
  proofgroveGateCopy,
  publicApiError,
  publicApiErrorFromUpstream,
  userFacingError,
} from "./api-errors";

describe("publicApiError", () => {
  it("returns bounded status copy and a request id", () => {
    expect(publicApiError(403, "request-1")).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "You do not have permission to perform this action.",
        request_id: "request-1",
      },
    });
  });
});

describe("publicApiErrorFromUpstream", () => {
  it("summarises a readiness-style dict whose reasons live only in details", () => {
    const body = publicApiErrorFromUpstream(
      422,
      JSON.stringify({
        detail: {
          status: "blocked",
          details: [
            { code: "evidence_missing", message: "Tool call spans were not captured." },
            { code: "scope_unsupported", message: "The dataset has no tool interactions." },
          ],
          evidence_source: "internal-archive",
        },
      }),
      "request-9",
    );

    expect(body.error.message).toBe(
      "Tool call spans were not captured. The dataset has no tool interactions.",
    );
    expect(body.error.details).toEqual([
      { code: "evidence_missing", message: "Tool call spans were not captured." },
      { code: "scope_unsupported", message: "The dataset has no tool interactions." },
    ]);
    expect(body.error.request_id).toBe("request-9");
    expect(JSON.stringify(body)).not.toContain("internal-archive");
  });

  it("forwards per-run attach incompatibility details", () => {
    const body = publicApiErrorFromUpstream(
      422,
      JSON.stringify({
        detail: {
          code: "experiment_runs_incompatible",
          message: "One or more runs cannot join this experiment.",
          details: [
            {
              code: "comparison_basis_mismatch",
              field: "run-bad",
              message: "Run run-bad does not share the comparison basis",
            },
          ],
        },
      }),
      "request-attach",
    );
    expect(body.error.code).toBe("experiment_runs_incompatible");
    expect(body.error.message).toContain("cannot join");
    expect(body.error.details).toEqual([
      {
        code: "comparison_basis_mismatch",
        field: "run-bad",
        message: "Run run-bad does not share the comparison basis",
      },
    ]);
  });

  it("caps the number of forwarded details", () => {
    const body = publicApiErrorFromUpstream(
      422,
      JSON.stringify({
        detail: Array.from({ length: 30 }, (_, index) => ({
          loc: ["body", `field_${index}`],
          msg: `Problem ${index}`,
          type: "value_error",
        })),
      }),
    );
    expect(body.error.details).toHaveLength(8);
  });

  it("falls back to generic copy for non-object bodies and unknown shapes", () => {
    expect(publicApiErrorFromUpstream(422, "not json").error.message).toBe(
      "Some information is invalid. Review the highlighted fields and try again.",
    );
    expect(publicApiErrorFromUpstream(422, JSON.stringify({ detail: 42 })).error.message).toBe(
      "Some information is invalid. Review the highlighted fields and try again.",
    );
    expect(publicApiErrorFromUpstream(422, JSON.stringify({ detail: "  " })).error.message).toBe(
      "Some information is invalid. Review the highlighted fields and try again.",
    );
  });
});

describe("apiErrorFromResponse", () => {
  it("accepts the public BFF error contract", () => {
    const error = apiErrorFromResponse(
      409,
      JSON.stringify(publicApiError(409, "request-2")),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("CONFLICT");
    expect(error.requestId).toBe("request-2");
  });

  it("never reflects raw upstream text", () => {
    const error = apiErrorFromResponse(
      500,
      "postgresql://admin:secret@database/proofgrove stack trace",
    );
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain("postgresql");
    expect(error.message).toBe(
      "Proofgrove could not complete the request. Try again shortly.",
    );
  });

  it("keeps generic copy for arbitrary FastAPI string details", () => {
    const body = publicApiErrorFromUpstream(
      422,
      JSON.stringify({ detail: "database row tenant-secret failed validation" }),
      "request-string",
    );
    expect(body.error.message).toBe(
      "Some information is invalid. Review the highlighted fields and try again.",
    );
    expect(JSON.stringify(body)).not.toContain("tenant-secret");
  });

  it("surfaces the forwarded code, field, recovery, and details", () => {
    const error = apiErrorFromResponse(
      422,
      JSON.stringify({
        error: {
          code: "exact_rerun_scope_mismatch",
          message: "evaluation_scope must not be chosen by the caller.",
          recovery: "Omit evaluation_scope to replay the recorded scope.",
          field: "evaluation_scope",
          request_id: "request-4",
          details: [
            { code: "missing", field: "project_id", message: "Field required" },
          ],
        },
      }),
    );

    expect(error.code).toBe("exact_rerun_scope_mismatch");
    expect(error.message).toBe("evaluation_scope must not be chosen by the caller.");
    expect(error.recovery).toBe("Omit evaluation_scope to replay the recorded scope.");
    expect(error.field).toBe("evaluation_scope");
    expect(error.requestId).toBe("request-4");
    expect(error.details).toEqual([
      { code: "missing", field: "project_id", message: "Field required" },
    ]);
  });

  it("bounds forwarded details and drops malformed entries", () => {
    const error = apiErrorFromResponse(
      422,
      JSON.stringify({
        error: {
          code: "VALIDATION_FAILED",
          message: "Some information is invalid.",
          details: [
            ...Array.from({ length: 20 }, (_, index) => ({
              message: `Problem ${index}`,
            })),
            { field: "no_message_here" },
            "not an object",
          ],
        },
      }),
    );
    expect(error.details.length).toBeLessThanOrEqual(8);
    expect(error.details.every((detail) => typeof detail.message === "string")).toBe(true);
  });
});

describe("userFacingError", () => {
  it("renders ApiError copy", () => {
    expect(
      userFacingError(
        new ApiError({ status: 404, code: "NOT_FOUND", message: "Not found" }),
      ),
    ).toBe("Not found");
  });

  it("replaces technical exceptions with contextual fallback copy", () => {
    expect(
      userFacingError(new Error("ECONNREFUSED 10.0.0.1"), "Unable to load runs."),
    ).toBe("Unable to load runs.");
  });

  it("appends recovery guidance to the specific message when present", () => {
    expect(
      userFacingError(
        new ApiError({
          status: 422,
          code: "exact_rerun_source_required",
          message: "exact_rerun requires source_run_id.",
          recovery: "Pick a source run and try again.",
        }),
      ),
    ).toBe("exact_rerun requires source_run_id. Pick a source run and try again.");
  });
});

describe("classifyProofgroveGate", () => {
  it("maps a 403 to permission-denied with distinct recovery copy", () => {
    const state = classifyProofgroveGate({ status: 403 });
    expect(state).toBe("permission-denied");
    expect(proofgroveGateCopy(state).title).toBe("You do not have access to Proofgrove");
    expect(proofgroveGateCopy(state).autoRecovers).toBe(false);
  });

  it("maps a 401 to session-expired", () => {
    const state = classifyProofgroveGate({ status: 401 });
    expect(state).toBe("session-expired");
    expect(proofgroveGateCopy(state).title).toBe("Your session has expired");
  });

  it("maps a network error to offline", () => {
    expect(classifyProofgroveGate({ networkError: true })).toBe("offline");
    expect(classifyProofgroveGate({ online: false })).toBe("offline");
    expect(proofgroveGateCopy("offline").title).toBe("You appear to be offline");
  });

  it("maps a 503 (and other 5xx/timeouts) to service-unavailable", () => {
    expect(classifyProofgroveGate({ status: 503 })).toBe("service-unavailable");
    expect(classifyProofgroveGate({ status: 500 })).toBe("service-unavailable");
    expect(classifyProofgroveGate({ status: 408 })).toBe("service-unavailable");
    expect(proofgroveGateCopy("service-unavailable").title).toBe(
      "Proofgrove is temporarily unavailable",
    );
  });

  it("maps the genuine health signal (available: false) to unprovisioned", () => {
    const state = classifyProofgroveGate({ available: false });
    expect(state).toBe("unprovisioned");
    expect(proofgroveGateCopy(state).title).toBe("Start the local evaluation service");
  });

  it("prioritises connectivity over an HTTP status", () => {
    expect(classifyProofgroveGate({ online: false, status: 403 })).toBe("offline");
  });
});

describe("spans archive 503 stays out of the workspace gate", () => {
  // Regression: a 503 from the span-archive endpoint used to surface the
  // "not available for this workspace yet" copy, indistinguishable from the
  // unprovisioned gate panel even though Proofgrove itself was up.
  it("gives a data-plane 503 outage copy, never unprovisioned-workspace copy", () => {
    const error = apiErrorFromResponse(
      503,
      JSON.stringify(publicApiError(503, "request-3")),
    );
    expect(error.status).toBe(503);
    expect(error.message).toBe(
      "Part of Proofgrove is temporarily unavailable. Try again shortly.",
    );
    expect(error.message).not.toMatch(/workspace/i);
    expect(error.message).not.toBe(proofgroveGateCopy("unprovisioned").description);
  });

  it("a body-less 503 (gateway-stripped) also falls back to outage copy", () => {
    const error = apiErrorFromResponse(503, "");
    expect(error.message).not.toMatch(/workspace/i);
    expect(error.message).toContain("temporarily unavailable");
  });

  it("never yields a gate state: even a probe-observed 503 is an outage, not unprovisioned", () => {
    // The gate's classifier only consumes /api/status probe signals; a 503
    // there means outage. "unprovisioned" requires a clean probe response
    // reporting available: false — a data fetch can never produce it.
    expect(classifyProofgroveGate({ status: 503 })).toBe("service-unavailable");
    expect(classifyProofgroveGate({ status: 503 })).not.toBe("unprovisioned");
  });
});
