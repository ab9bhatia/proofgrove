import { describe, expect, it } from "vitest";

import type { ActivityEvent, FindingComment } from "@/lib/review-collab";
import {
  COMMENT_MAX_LENGTH,
  commentToActivityEvent,
  commentValidationError,
  relativeTimeLabel,
} from "@/lib/review-collab";

describe("commentValidationError", () => {
  it("requires a non-blank comment body", () => {
    expect(commentValidationError("")).toBe("Write a comment before posting.");
    expect(commentValidationError("   \n ")).toBe("Write a comment before posting.");
  });

  it("enforces the server's 4,000 character bound before the request is sent", () => {
    expect(commentValidationError("x".repeat(COMMENT_MAX_LENGTH))).toBeNull();
    expect(commentValidationError("x".repeat(COMMENT_MAX_LENGTH + 1))).toBe(
      "Comments are limited to 4,000 characters.",
    );
  });

  it("accepts a normal comment", () => {
    expect(commentValidationError("Confirmed on replay — @alice please own the fix")).toBeNull();
  });
});

describe("relativeTimeLabel", () => {
  const now = Date.parse("2026-08-24T12:00:00Z");

  it("labels recent activity honestly", () => {
    expect(relativeTimeLabel("2026-08-24T11:59:50Z", now)).toBe("just now");
    expect(relativeTimeLabel("2026-08-24T11:35:00Z", now)).toBe("25m ago");
    expect(relativeTimeLabel("2026-08-24T07:00:00Z", now)).toBe("5h ago");
    expect(relativeTimeLabel("2026-08-21T12:00:00Z", now)).toBe("3d ago");
  });

  it("treats slightly-future timestamps (clock skew) as just now", () => {
    expect(relativeTimeLabel("2026-08-24T12:00:20Z", now)).toBe("just now");
  });

  it("falls back to an absolute date beyond a week", () => {
    const label = relativeTimeLabel("2026-07-01T12:00:00Z", now);
    expect(label).not.toContain("ago");
    expect(label).toContain("2026");
  });

  it("never fabricates a time for an unparseable value", () => {
    expect(relativeTimeLabel("not-a-date", now)).toBe("time unknown");
  });
});

describe("commentToActivityEvent", () => {
  it("maps a posted comment into the timeline shape used for optimistic append", () => {
    const comment: FindingComment = {
      comment_id: "comment-1",
      finding_id: "finding-1",
      tenant_id: "tenant-a",
      author: "Jane Reviewer",
      body: "Looks real, @sam should own the fix",
      mentions: ["sam"],
      created_at: "2026-08-24T10:00:00Z",
    };
    const event: ActivityEvent = commentToActivityEvent(comment);
    expect(event.kind).toBe("comment");
    expect(event.actor).toBe("Jane Reviewer");
    expect(event.summary).toBe("Looks real, @sam should own the fix");
    expect(event.timestamp).toBe("2026-08-24T10:00:00Z");
    expect(event.reference_id).toBe("comment-1");
    expect(event.details).toEqual({ mentions: ["sam"] });
  });
});
