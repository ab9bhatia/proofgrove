/**
 * Evaluations library tab URL helpers.
 *
 * Canonical: `tab=experiments` for the Experiments tab (omitted for Run history).
 * Legacy: `view=experiments` still reads as Experiments so old bookmarks work.
 *
 * Lifecycle uses a separate `lifecycle=` key (see library-url-state) — never `view=`.
 */

export type EvaluationsTab = "runs" | "experiments";

type SearchParamsReader = Pick<URLSearchParams, "get">;

const TAB_ORDER: readonly EvaluationsTab[] = ["runs", "experiments"] as const;

export function evaluationViewForKey(current: EvaluationsTab, key: string): EvaluationsTab | null {
  if (key === "Home") return TAB_ORDER[0];
  if (key === "End") return TAB_ORDER[TAB_ORDER.length - 1];
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const index = TAB_ORDER.indexOf(current);
    const delta = key === "ArrowRight" ? 1 : -1;
    return TAB_ORDER[(index + delta + TAB_ORDER.length) % TAB_ORDER.length];
  }
  return null;
}

export function readEvaluationsTab(params: SearchParamsReader): EvaluationsTab {
  const tab = (params.get("tab") ?? "").trim().toLowerCase();
  if (tab === "experiments") return "experiments";
  // Legacy bookmark: ?view=experiments (collided with lifecycle view=archived).
  if ((params.get("view") ?? "").trim().toLowerCase() === "experiments") return "experiments";
  return "runs";
}

/** Apply tab to params; migrates away from legacy `view=experiments`. */
export function writeEvaluationsTab(params: URLSearchParams, tab: EvaluationsTab): void {
  if (tab === "experiments") params.set("tab", "experiments");
  else params.delete("tab");

  if ((params.get("view") ?? "").trim().toLowerCase() === "experiments") {
    params.delete("view");
  }
}

export function evaluationsHref(tab: EvaluationsTab, currentSearch = ""): string {
  const params = new URLSearchParams(
    currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch,
  );
  writeEvaluationsTab(params, tab);
  const query = params.toString();
  return query ? `/evaluations?${query}` : "/evaluations";
}
