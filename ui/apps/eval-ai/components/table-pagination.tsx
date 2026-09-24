"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { ROWS_PER_PAGE } from "@/lib/pagination";

export function TablePagination({ total, page, onPageChange, label, busy = false, hasMore = false }: {
  total: number; page: number; onPageChange: (page: number) => void; label: string; busy?: boolean; hasMore?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / ROWS_PER_PAGE));
  return <div className="flex flex-col gap-3 border-t bg-muted/10 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
    <p className="text-xs text-muted-foreground">Showing <span className="font-medium text-foreground">{total ? (page - 1) * ROWS_PER_PAGE + 1 : 0}</span>–<span className="font-medium text-foreground">{Math.min(page * ROWS_PER_PAGE, total)}</span> of <span className="font-medium text-foreground">{total}</span> {label}</p>
    <nav className="flex items-center gap-2" aria-label={`${label} pagination`}>
      <Button type="button" variant="outline" size="sm" disabled={busy || page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft className="mr-1 size-3.5" aria-hidden />Previous</Button>
      <span className="min-w-20 text-center text-xs font-medium" aria-live="polite">{busy ? "Loading…" : `Page ${page} of ${pages}`}</span>
      <Button type="button" variant="outline" size="sm" disabled={busy || (page >= pages && !hasMore)} onClick={() => onPageChange(page + 1)}>Next<ChevronRight className="ml-1 size-3.5" aria-hidden /></Button>
    </nav>
  </div>;
}
