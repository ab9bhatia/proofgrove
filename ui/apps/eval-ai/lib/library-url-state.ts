export type LibrarySortKey = "last_run" | "latest_score" | "runs";
export type LibrarySortDir = "asc" | "desc";

export type RunLibraryUrlState = {
  query: string;
  label: string;
  type: "" | "Agent" | "RAG" | "LLM" | "Existing responses" | "Baseline";
  status: "" | "Running" | "Completed" | "Stopped" | "Error";
  dateMode: "any" | "specific" | "range";
  date: string;
  dateFrom: string;
  dateTo: string;
  lifecycle: "active" | "archived";
  page: number;
  expanded: string[];
  selectedRunIds: string[];
  openRunId: string;
  sortKey: LibrarySortKey;
  sortDir: LibrarySortDir;
};

type SearchParamsReader = Pick<URLSearchParams, "get">;

// Matched against `runScenarioTypeLabel`, which reports a run's response source
// ahead of its scenario. Without the last two entries a provided or baseline run
// answered to no filter value at all: `?type=llm` stopped matching them once the
// label changed, and nothing selected them instead.
const RUN_TYPES: Record<string, RunLibraryUrlState["type"]> = {
  agent: "Agent",
  rag: "RAG",
  llm: "LLM",
  provided: "Existing responses",
  baseline: "Baseline",
};
// Lower-casing the label round-tripped only while every label was one word:
// "Existing responses" serialised to `existing responses`, which is not a key
// above, so the filter cleared itself on the next navigation that re-wrote the
// URL — a search keystroke, a sort, a page change.
const RUN_TYPE_PARAMS = Object.fromEntries(
  Object.entries(RUN_TYPES).map(([param, label]) => [label, param]),
) as Record<RunLibraryUrlState["type"], string>;

const RUN_STATUSES: Record<string, RunLibraryUrlState["status"]> = {
  running: "Running",
  completed: "Completed",
  cancelled: "Stopped",
  stopped: "Stopped",
  failed: "Error",
};

function setOrDelete(params: URLSearchParams, key: string, value: string) {
  if (value.trim()) params.set(key, value);
  else params.delete(key);
}

export function readRunLibraryUrlState(params: SearchParamsReader): RunLibraryUrlState {
  const requestedType = (params.get("type") ?? "").trim().toLowerCase();
  const requestedStatus = (params.get("status") ?? "").trim().toLowerCase();
  const requestedDateMode = (params.get("date_mode") ?? "").trim().toLowerCase();
  const requestedPage = Number(params.get("page"));

  const requestedSort = (params.get("sort") ?? "").trim().toLowerCase();
  const requestedDir = (params.get("dir") ?? "").trim().toLowerCase();
  const sortKey: LibrarySortKey =
    requestedSort === "latest_score" || requestedSort === "runs" || requestedSort === "last_run"
      ? requestedSort
      : "last_run";
  const sortDir: LibrarySortDir = requestedDir === "asc" ? "asc" : "desc";

  return {
    query: params.get("q") ?? "",
    label: params.get("label") ?? "",
    type: RUN_TYPES[requestedType] ?? "",
    status: RUN_STATUSES[requestedStatus] ?? "",
    dateMode:
      requestedDateMode === "specific" || requestedDateMode === "range"
        ? requestedDateMode
        : "any",
    date: params.get("date") ?? "",
    dateFrom: params.get("date_from") ?? "",
    dateTo: params.get("date_to") ?? "",
    // Canonical: lifecycle=archived. Legacy: view=archived (collided with tab view=experiments).
    lifecycle:
      (params.get("lifecycle") ?? "").trim().toLowerCase() === "archived" ||
      (params.get("view") ?? "").trim().toLowerCase() === "archived"
        ? "archived"
        : "active",
    page: Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
    expanded: (params.get("expanded") ?? "").split(",").filter(Boolean),
    selectedRunIds: (params.get("compare") ?? "").split(",").filter(Boolean).slice(0, 4),
    openRunId: params.get("run") ?? "",
    sortKey,
    sortDir,
  };
}

export function writeRunLibrarySearchParams(
  current: string,
  state: RunLibraryUrlState,
): string {
  const params = new URLSearchParams(current);
  setOrDelete(params, "q", state.query);
  setOrDelete(params, "label", state.label);
  setOrDelete(params, "type", RUN_TYPE_PARAMS[state.type] ?? "");
  setOrDelete(params, "status", state.status === "Error" ? "failed" : state.status.toLowerCase());
  setOrDelete(params, "lifecycle", state.lifecycle === "archived" ? "archived" : "");
  // Drop legacy lifecycle-on-view so it cannot collide with tab bookmarks.
  if ((params.get("view") ?? "").trim().toLowerCase() === "archived") {
    params.delete("view");
  }
  setOrDelete(params, "page", state.page > 1 ? String(state.page) : "");
  setOrDelete(params, "expanded", state.expanded.join(","));
  setOrDelete(params, "compare", state.selectedRunIds.join(","));
  setOrDelete(params, "run", state.openRunId);
  const defaultSort = state.sortKey === "last_run" && state.sortDir === "desc";
  setOrDelete(params, "sort", defaultSort ? "" : state.sortKey);
  setOrDelete(params, "dir", defaultSort ? "" : state.sortDir);

  if (state.dateMode === "specific") {
    params.set("date_mode", "specific");
    setOrDelete(params, "date", state.date);
    params.delete("date_from");
    params.delete("date_to");
  } else if (state.dateMode === "range") {
    params.set("date_mode", "range");
    params.delete("date");
    setOrDelete(params, "date_from", state.dateFrom);
    setOrDelete(params, "date_to", state.dateTo);
  } else {
    params.delete("date_mode");
    params.delete("date");
    params.delete("date_from");
    params.delete("date_to");
  }

  return params.toString();
}
