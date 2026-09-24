// Client for the F6 review-collaboration endpoints:
//   GET  /platform/findings/{id}/activity   — derived, read-only timeline
//   GET  /platform/findings/{id}/comments   — append-only comments
//   POST /platform/findings/{id}/comments   — post a comment (mentions are
//                                             parsed server-side and recorded;
//                                             nothing is delivered)
//
// It lives here rather than in `lib/api.ts` (which this slice must not modify)
// but talks to the same BFF proxy with the same error handling — mirroring
// `lib/run-history.ts`.

import { sessionAwareFetch } from "@evalai/shared/session";
import { ApiError, apiErrorFromResponse } from "@/lib/api-errors";

const BASE = "/api/eval-hub";

/** Server-side bound on a comment body (mirrors `FINDING_COMMENT_MAX_LENGTH`). */
export const COMMENT_MAX_LENGTH = 4000;

/** An append-only collaboration comment on a finding. No edit or delete exists. */
export interface FindingComment {
  comment_id: string;
  finding_id: string;
  tenant_id?: string | null;
  author: string;
  body: string;
  /** Parsed server-side from `body`; recorded only — no notification delivery. */
  mentions: string[];
  created_at: string;
}

export type ActivityKind =
  | "finding_created"
  | "review_decision"
  | "remediation_created"
  | "remediation_status_changed"
  | "waiver_granted"
  | "comment";

/**
 * One entry in a finding's activity timeline. The server derives this from
 * already-persisted review data (there is no event table), so edits/deletes
 * are not tracked and remediation status changes appear only when they went
 * through the API.
 */
export interface ActivityEvent {
  kind: ActivityKind;
  actor: string;
  timestamp: string;
  summary: string;
  reference_id: string;
  details?: Record<string, unknown>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await sessionAwareFetch(`${BASE}${path}`, {
      cache: "no-store",
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: "Unable to reach Proofgrove. Check your connection and try again.",
    });
  }
  if (!res.ok) {
    throw apiErrorFromResponse(res.status, await res.text());
  }
  if (res.status === 204) return {} as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError({
      status: 502,
      code: "INVALID_RESPONSE",
      message: "Proofgrove returned an invalid response. Try again shortly.",
    });
  }
}

export const reviewCollabApi = {
  listActivity: (findingId: string): Promise<ActivityEvent[]> =>
    request<ActivityEvent[]>(`/platform/findings/${encodeURIComponent(findingId)}/activity`),

  listComments: (findingId: string): Promise<FindingComment[]> =>
    request<FindingComment[]>(`/platform/findings/${encodeURIComponent(findingId)}/comments`),

  postComment: (findingId: string, body: { author: string; body: string }): Promise<FindingComment> =>
    request<FindingComment>(`/platform/findings/${encodeURIComponent(findingId)}/comments`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

/**
 * Client-side validation matching the server contract (non-blank, bounded
 * body), so an invalid comment is explained instead of round-tripping to a 422.
 * Identity gating is separate: the composer reuses `reviewIdentityError`.
 */
export function commentValidationError(body: string): string | null {
  if (!body.trim()) return "Write a comment before posting.";
  if (body.length > COMMENT_MAX_LENGTH) return "Comments are limited to 4,000 characters.";
  return null;
}

/**
 * Shape a just-posted comment as a timeline entry so it can be appended to the
 * loaded activity list without refetching (append happens only on a confirmed
 * 201 — never before the server accepted the comment).
 */
export function commentToActivityEvent(comment: FindingComment): ActivityEvent {
  return {
    kind: "comment",
    actor: comment.author,
    timestamp: comment.created_at,
    summary: comment.body,
    reference_id: comment.comment_id,
    details: { mentions: comment.mentions },
  };
}

/**
 * Compact relative time for timeline rows. Falls back to an absolute date
 * beyond a week and admits ignorance for unparseable values rather than
 * fabricating a time.
 */
export function relativeTimeLabel(value: string, nowMs: number = Date.now()): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "time unknown";
  const elapsedSeconds = Math.max(0, (nowMs - parsed) / 1000);
  if (elapsedSeconds < 60) return "just now";
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}m ago`;
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)}h ago`;
  if (elapsedSeconds < 7 * 86400) return `${Math.floor(elapsedSeconds / 86400)}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(parsed),
  );
}
