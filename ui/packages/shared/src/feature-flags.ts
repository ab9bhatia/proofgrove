// Feature-flag core for evalai UIs.
//
// NEXT_PUBLIC_* vars are inlined into the client bundle at build time, so
// this module is safe to import from both server and client components.
//
// Each app supplies its own `WIRED_HREFS` set (the routes backed by real
// data) and builds its own `isWired` via `makeIsWired`. The mode flags are
// shared because they're read from the same env var across all apps.

export type UIMode = "live" | "mock";

export const UI_MODE: UIMode =
  (process.env.NEXT_PUBLIC_UI_MODE ?? "live").toLowerCase() === "mock"
    ? "mock"
    : "live";

export const IS_LIVE_MODE = UI_MODE === "live";
export const IS_MOCK_MODE = UI_MODE === "mock";

/**
 * Build an `isWired(href)` predicate scoped to the calling app.
 *
 * In mock mode every href is wired (the shell shows everything).
 * In live mode only hrefs in `wiredHrefs` pass; query strings are stripped
 * before checking so `"/chat?project=x"` and `"/chat"` resolve identically.
 */
export function makeIsWired(
  wiredHrefs: ReadonlySet<string>,
): (href: string) => boolean {
  return (href: string) => {
    if (IS_MOCK_MODE) return true;
    const path = href.split("?")[0];
    return wiredHrefs.has(path);
  };
}
