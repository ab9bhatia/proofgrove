"use client";

import { useState } from "react";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@evalai/shared/ui/dropdown-menu";
import { toast } from "@evalai/shared/ui/sonner";
import type { RunResult } from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import {
  exportEvaluation,
  type ExportFormat,
  type ExportScope,
  type PdfGranularity,
} from "@/lib/eval-export";

type MenuItem =
  | { kind: "format"; format: ExportFormat; label: string }
  | { kind: "pdf"; granularity: PdfGranularity; label: string };

const MENU_ITEMS: MenuItem[] = [
  { kind: "pdf", granularity: "details", label: "Print / Save as PDF" },
  { kind: "format", format: "json", label: "JSON" },
  { kind: "format", format: "csv", label: "CSV" },
];

/**
 * Dropdown to extract evaluation evidence as PDF (Summary/Details), JSON, or CSV.
 *
 * Built on the shared Radix dropdown-menu primitive so the menu gets the full
 * keyboard + focus model for free: focus moves to the first item on open,
 * Arrow/Home/End navigate, Escape closes and restores focus to the trigger, and
 * selecting an item closes the menu.
 */
export function ExportMenu({
  run,
  scope,
  label = "Extract",
  size = "sm",
}: {
  run: RunResult;
  scope: ExportScope;
  label?: string;
  size?: "sm" | "md" | "lg";
}) {
  const [busy, setBusy] = useState(false);

  async function handleExport(format: ExportFormat, pdfGranularity?: PdfGranularity) {
    setBusy(true);
    try {
      exportEvaluation(scope, format, run, { pdfGranularity });
    } catch (reason) {
      toast.error("Export failed", {
        description: userFacingError(reason, "Try exporting this run again."),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size={size} disabled={busy}>
          {busy ? (
            <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="mr-1.5 size-3.5" aria-hidden="true" />
          )}
          {label}
          <ChevronDown className="ml-1 size-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {MENU_ITEMS.map((item) => (
          <DropdownMenuItem
            key={item.label}
            onSelect={() =>
              void handleExport(
                item.kind === "pdf" ? "pdf" : item.format,
                item.kind === "pdf" ? item.granularity : undefined,
              )
            }
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
