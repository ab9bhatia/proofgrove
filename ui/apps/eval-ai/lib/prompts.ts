import type { PromptVersion } from "@/lib/api";

/** `prompt-id@version` — the form a run records and the API resolves. */
export function promptRef(version: PromptVersion): string {
  return `${version.prompt_id}@${version.version}`;
}

export interface GroupedPrompt {
  promptId: string;
  name: string;
  versions: PromptVersion[];
}

/**
 * Group flat versions under their prompt, newest first, optionally filtered.
 *
 * Extracted rather than inlined so the grouping and filtering are testable
 * without rendering — this app's convention for anything with logic in it.
 */
export function groupPromptVersions(versions: PromptVersion[], query = ""): GroupedPrompt[] {
  const needle = query.trim().toLowerCase();

  const byPrompt = new Map<string, GroupedPrompt>();
  for (const version of versions) {
    const group = byPrompt.get(version.prompt_id) ?? {
      promptId: version.prompt_id,
      // The newest version's name wins: renaming a prompt should not require
      // rewriting its history.
      name: version.name,
      versions: [],
    };
    group.versions.push(version);
    byPrompt.set(version.prompt_id, group);
  }

  for (const group of byPrompt.values()) {
    group.versions.sort((a, b) => b.version - a.version);
    group.name = group.versions[0]?.name ?? group.name;
  }

  // Match whole prompts, never individual versions. Dropping the versions that
  // do not match left a group whose lead, version count and production badge all
  // described a subset — a prompt whose live version lacked the search term
  // reported "no production version".
  const groups = [...byPrompt.values()].filter(
    (group) =>
      !needle ||
      group.versions.some((version) =>
        [version.prompt_id, version.name, version.content].some((field) =>
          field?.toLowerCase().includes(needle),
        ),
      ),
  );
  return groups.sort((a, b) => a.promptId.localeCompare(b.promptId));
}

/**
 * One-line preview of a prompt body, for pickers where the full text would
 * dominate the row. The catalog page shows the whole thing.
 */
export function promptPreview(content: string, limit = 120): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Mirrors the server's `_ID_PATTERN`; kept here so a typo is caught before a round trip. */
const PROMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Why this prompt id is unusable, or null when it is fine.
 *
 * The server is still the authority — this exists so the commonest mistake (a
 * space, because the field looks like a name) is answered instantly instead of
 * coming back as a generic 422.
 */
export function promptIdProblem(promptId: string): string | null {
  const trimmed = promptId.trim();
  if (!trimmed) return "Give the prompt an id.";
  if (/\s/.test(trimmed)) return "No spaces — try dashes instead, like support-tone.";
  if (!PROMPT_ID_PATTERN.test(trimmed)) {
    return "Use letters, numbers, dots, dashes or underscores, starting with a letter or number.";
  }
  return null;
}

/** The version `production` points at, or null when the label is unset. */
export function productionVersion(prompt: GroupedPrompt): number | null {
  return prompt.versions.find((version) => version.labels.includes("production"))?.version ?? null;
}

/**
 * The version to show first. `versions` is newest-first, so when nothing carries
 * the production label the newest stands in: a prompt that leads with nothing is
 * worse than one that leads with its most recent draft.
 */
export function leadVersion(prompt: GroupedPrompt): PromptVersion | null {
  return prompt.versions.find((version) => version.labels.includes("production"))
    ?? prompt.versions[0]
    ?? null;
}


/**
 * The prompt id from a route segment.
 *
 * `decodeURIComponent` throws `URIError` on a malformed escape — `%`, `a%zz` —
 * and a throw during render blanks the page. A bad id should reach the "no such
 * prompt" state, which is what an unreadable segment means anyway, so the raw
 * value is returned instead and the lookup fails normally.
 */
export function decodePromptId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
