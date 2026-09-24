import { describe, expect, it } from "vitest";

import type { ArchivedTraceSpan } from "@/lib/api";
import {
  metadataOmitKeys,
  spanMetadataFields,
  traceMetadataFields,
} from "./trace-metadata";

function span(overrides: Partial<ArchivedTraceSpan> = {}): ArchivedTraceSpan {
  return {
    trace_id: "t1",
    span_id: "s1",
    parent_span_id: null,
    name: "root",
    kind: null,
    start_time_unix_nano: null,
    end_time_unix_nano: null,
    duration_ms: null,
    status: null,
    attributes: {},
    resource_attributes: {},
    events: [],
    ...overrides,
  };
}

describe("spanMetadataFields", () => {
  it("returns only fields that exist on span or resource attributes", () => {
    expect(
      spanMetadataFields(
        span({
          attributes: {
            "session.id": "sess-1",
            "gen_ai.agent.name": "assistant",
          },
          resource_attributes: {
            "ctx.tenant": "acme",
          },
        }),
      ),
    ).toEqual([
      { key: "session.id", label: "Session", value: "sess-1" },
      { key: "gen_ai.agent.name", label: "Agent", value: "assistant" },
      { key: "ctx.tenant", label: "Tenant", value: "acme" },
    ]);
  });

  it("prefers span attributes over resource for the same key", () => {
    expect(
      spanMetadataFields(
        span({
          attributes: { "ctx.tenant": "from-span" },
          resource_attributes: { "ctx.tenant": "from-resource" },
        }),
      ).map((field) => field.value),
    ).toEqual(["from-span"]);
  });

  it("does not fabricate missing metadata", () => {
    expect(spanMetadataFields(span())).toEqual([]);
  });

  it("collapses user.id and kagent.user_id to one 'User' field", () => {
    // Both specs mean the same thing; a span carrying both must not surface
    // "User" twice. The earlier spec (user.id) wins.
    expect(
      spanMetadataFields(
        span({ attributes: { "user.id": "std-user", "kagent.user_id": "vendor-user" } }),
      ),
    ).toEqual([{ key: "user.id", label: "User", value: "std-user" }]);
  });
});

describe("traceMetadataFields", () => {
  it("collects first recorded value per key across spans", () => {
    expect(
      traceMetadataFields([
        span({ span_id: "a", attributes: { "kagent.user_id": "user-a" } }),
        span({ span_id: "b", attributes: { "gen_ai.conversation.id": "conv-1" } }),
        span({
          span_id: "c",
          resource_attributes: { "ctx.customer_org": "org-9" },
        }),
      ]),
    ).toEqual([
      { key: "kagent.user_id", label: "User", value: "user-a" },
      { key: "gen_ai.conversation.id", label: "Conversation", value: "conv-1" },
      { key: "ctx.customer_org", label: "Customer org", value: "org-9" },
    ]);
  });

  it("collapses a User field recorded under different keys on different spans", () => {
    expect(
      traceMetadataFields([
        span({ span_id: "a", attributes: { "user.id": "std-user" } }),
        span({ span_id: "b", attributes: { "kagent.user_id": "vendor-user" } }),
      ]),
    ).toEqual([{ key: "user.id", label: "User", value: "std-user" }]);
  });
});

describe("metadataOmitKeys", () => {
  it("returns attribute keys promoted to the summary band", () => {
    expect(
      metadataOmitKeys([{ key: "session.id", label: "Session", value: "x" }]),
    ).toEqual(new Set(["session.id"]));
  });
});
