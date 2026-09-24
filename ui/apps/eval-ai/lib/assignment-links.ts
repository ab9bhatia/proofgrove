/**
 * Stable Assignment deep links for the Evaluation governance catalogue and
 * Evaluate restore. Never invent an Assignment identity — callers must pass
 * explicit id + version (or a combined `id@version` query value).
 */

export function evaluateHrefFromAssignment(input: {
  assignmentId: string;
  version: string;
  dataset?: string | null;
  type?: "agent" | "llm" | "rag";
}): string {
  const params = new URLSearchParams();
  params.set("assignment", input.assignmentId.trim());
  params.set("assignmentVersion", input.version.trim());
  if (input.dataset?.trim()) params.set("dataset", input.dataset.trim());
  if (input.type) params.set("type", input.type);
  return `/evaluate?${params.toString()}`;
}

export function assignmentDetailsHref(input: {
  runManifestId: string;
  assignmentId?: string | null;
  version?: string | null;
}): string {
  const params = new URLSearchParams();
  params.set("setup", input.runManifestId.trim());
  if (input.assignmentId?.trim() && input.version?.trim()) {
    params.set("assignment", input.assignmentId.trim());
    params.set("assignmentVersion", input.version.trim());
  }
  return `/contracts/new?${params.toString()}`;
}

/** Catalogue permalink used by Copy link (single list route: /contracts). */
export function assignmentPermalinkPath(input: {
  assignmentId: string;
  version: string;
}): string {
  const params = new URLSearchParams();
  params.set("assignment", input.assignmentId.trim());
  params.set("assignmentVersion", input.version.trim());
  return `/contracts?${params.toString()}`;
}

export function assignmentFromSearchParams(
  params: URLSearchParams,
): { assignmentId: string; assignmentVersion: string } | null {
  const raw = params.get("assignment")?.trim() || "";
  if (!raw) return null;

  if (raw.includes("@")) {
    const at = raw.lastIndexOf("@");
    const assignmentId = raw.slice(0, at).trim();
    const assignmentVersion = raw.slice(at + 1).trim();
    if (!assignmentId || !assignmentVersion) return null;
    return { assignmentId, assignmentVersion };
  }

  const assignmentVersion =
    params.get("assignmentVersion")?.trim() || params.get("version")?.trim() || "";
  if (!assignmentVersion) return null;
  return { assignmentId: raw, assignmentVersion };
}
