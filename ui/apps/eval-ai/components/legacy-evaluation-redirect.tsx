"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import type { EvaluationKind } from "@/lib/evaluation-form";

export function LegacyEvaluationRedirect({ kind }: { kind: EvaluationKind }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("type", kind);
    router.replace(`/evaluate?${next.toString()}`);
  }, [kind, router, searchParams]);

  return (
    <div role="status" aria-live="polite" className="flex justify-center py-24">
      <div className="size-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
      <span className="sr-only">Opening the evaluation setup…</span>
    </div>
  );
}

/**
 * Maps a legacy evaluation route to its canonical `/evaluations` equivalent,
 * preserving query parameters.
 *
 * - `/experiments`            → `/evaluations?tab=experiments`
 * - `/compare`               → `/evaluations?tab=experiments`
 * - `/experiments/:id`        → `/evaluations/:id`
 * - `/experiments/:id/compare`→ `/evaluations/:id/compare`
 */
export function mapLegacyEvaluationPath(pathname: string, search = ""): string {
  const rawSearch = search.startsWith("?") ? search.slice(1) : search;

  // Library-level legacy entry points open the comparison view of the library.
  if (pathname === "/experiments" || pathname === "/compare") {
    const params = new URLSearchParams(rawSearch);
    params.set("tab", "experiments");
    if ((params.get("view") ?? "").trim().toLowerCase() === "experiments") {
      params.delete("view");
    }
    return `/evaluations?${params.toString()}`;
  }

  // Nested legacy experiment routes map 1:1 onto the canonical evaluations tree.
  if (pathname.startsWith("/experiments/")) {
    const suffix = pathname.slice("/experiments".length);
    return `/evaluations${suffix}${rawSearch ? `?${rawSearch}` : ""}`;
  }

  return `/evaluations${rawSearch ? `?${rawSearch}` : ""}`;
}

function LegacyEvaluationRouteRedirectInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    router.replace(mapLegacyEvaluationPath(pathname ?? "", searchParams.toString()));
  }, [router, pathname, searchParams]);

  return (
    <div role="status" aria-live="polite" className="flex justify-center py-24">
      <div className="size-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
      <span className="sr-only">Redirecting to the evaluations library…</span>
    </div>
  );
}

/**
 * Client redirect for legacy `/experiments*` and `/compare` routes. Reads the
 * live pathname so a single component serves every legacy path, forwarding to
 * the canonical `/evaluations` equivalent with query parameters intact.
 */
export function LegacyEvaluationRouteRedirect() {
  return (
    <Suspense
      fallback={
        <div role="status" aria-live="polite" className="flex justify-center py-24">
          <div className="size-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
          <span className="sr-only">Redirecting to the evaluations library…</span>
        </div>
      }
    >
      <LegacyEvaluationRouteRedirectInner />
    </Suspense>
  );
}
