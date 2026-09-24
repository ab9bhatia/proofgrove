import type { RunConfigurationSnapshot, RunItemDetail } from "@/lib/api-types";

/**
 * Why "Try another prompt" is unavailable for this case, or null when it can
 * run. Extracted rather than inlined so every branch is testable without
 * rendering — this app's convention for anything with logic in it (see
 * `compareDisabledReasonFromRunReport`).
 *
 * The server re-validates all of this with coded refusals; this function is
 * UX, not truth. Its rules mirror the POST route's pre-flight checks so the
 * button never invites a click the server would refuse.
 */

/** Mirrored from the backend's `_QUERY_KEYS` — the keys a run reads the
 *  question through, so this can never disagree with what a replay would send. */
export const REPLAY_QUESTION_KEYS = ["question", "query", "prompt", "input"] as const;

/** Appended by the persistence layer to any string it cut short. */
const TRUNCATION_MARKER = "[TRUNCATED]";

export function replayQuestionText(input: Record<string, unknown> | null | undefined): string | null {
  if (!input) return null;
  for (const key of REPLAY_QUESTION_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function replayDisabledReason(
  item: RunItemDetail | null,
  config: RunConfigurationSnapshot | null,
  configError: boolean,
): string | null {
  if (!item) return "Case evidence is still loading.";
  if (configError) return "Could not load the original run's configuration. Retry to check whether this case can be replayed.";
  if (!config) return "Loading the original run's configuration…";
  if (config.response_source !== "llm") {
    return config.response_source === "agent"
      ? "This run evaluated an agent, whose invocation accepts no system prompt — there is nothing a different prompt would change."
      : "This run scored stored responses without invoking a model, so there is no target to replay.";
  }
  if (!config.target_model?.trim()) {
    return "The original run did not record its target model, so the replay cannot invoke the same model.";
  }
  if (config.llm_endpoint_resolvable === false) {
    return "No LLM endpoint is resolvable for this run's target.";
  }
  const question = replayQuestionText(item.input);
  if (question === null) {
    return "The case's input text was not captured, so there is nothing to send to the model.";
  }
  if (question.endsWith(TRUNCATION_MARKER)) {
    return "The case's input was truncated at persistence; replaying it would not reproduce the original question.";
  }
  return null;
}
