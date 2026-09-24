import Link from "next/link";
import { FileJson, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { CopyButton } from "@/components/copy-button";

import type { DatasetRecord } from "@/lib/api";
import { recordMetadata } from "@/lib/dataset-csv";

const LABELS: Record<string, string> = {
  expected_authored_by: "Reference answer",
  source_run_id: "Source run",
  source_trace_id: "Source trace ID",
  source_example_id: "Source case ID",
  source_capture_state: "Capture status",
  source_redacted: "Source redacted",
  source_retention_policy: "Retention policy",
};
const SUMMARY_KEYS = ["risk", "domain", "expected_authored_by"];

export function metadataLabel(key: string) {
  return LABELS[key] || key.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function metadataValueText(key: string, value: unknown): string {
  if (value == null || value === "") return "Not recorded";
  if (key === "expected_authored_by") {
    if (value === "reviewer") return "Written by reviewer";
    if (value === "capture") return "Captured answer";
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (key === "source_redacted" && (value === "true" || value === "false")) return value === "true" ? "Yes" : "No";
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}

export function DatasetRecordMetadata({ record, onViewJson, recordLabel = "record", hiddenKeys = [] }: { record: DatasetRecord; onViewJson?: () => void; recordLabel?: string; hiddenKeys?: string[] }) {
  const metadata = recordMetadata(record);
  const entries = Object.entries(metadata).filter(([key]) => !hiddenKeys.includes(key));
  if (!Object.keys(metadata).length) return <span className="text-muted-foreground">No metadata</span>;
  const summary = SUMMARY_KEYS.filter((key) => key in metadata && !hiddenKeys.includes(key));
  const details = entries.filter(([key]) => !SUMMARY_KEYS.includes(key));

  return (
    <div className="space-y-2 text-xs leading-5">
      {summary.length ? (
        <dl className="space-y-1">
          {summary.map((key) => (
            <div key={key} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2">
              <dt className="text-muted-foreground">{metadataLabel(key)}</dt>
              <dd className="min-w-0 break-words">{metadataValueText(key, metadata[key])}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {details.length ? (
        <details>
          <summary className="w-fit cursor-pointer rounded py-1 font-medium text-brand-text underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {summary.length ? "More details" : "View metadata"} ({details.length})
          </summary>
          <dl className="mt-2 max-h-80 space-y-3 overflow-y-auto pr-2">
            {details.map(([key, value]) => (
              <div key={key}>
                <dt className="text-muted-foreground">{metadataLabel(key)}</dt>
                <dd className="min-w-0 whitespace-pre-wrap break-all">
                  {key === "source_run_id" && typeof value === "string" && value ? (
                    <Link href={`/runs/${encodeURIComponent(value)}`} className="rounded text-brand-text underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{value}</Link>
                  ) : metadataValueText(key, value)}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {onViewJson ? <button type="button" onClick={onViewJson} aria-label={`View metadata JSON for ${recordLabel}`} className="inline-flex min-h-9 items-center gap-1.5 rounded px-1 font-medium text-brand-text hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><FileJson className="size-3.5" aria-hidden="true" />View JSON</button> : null}
    </div>
  );
}

export function MetadataJsonDialog({ record, recordLabel, question, onClose }: { record: DatasetRecord; recordLabel: string; question: string; onClose: () => void }) {
  const json = JSON.stringify(recordMetadata(record), null, 2);
  return (
    <Dialog labelledBy="metadata-json-title" describedBy="metadata-json-context" onClose={onClose} scrimLabel="Close metadata JSON" width="max-w-3xl">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b p-5">
        <div className="min-w-0">
          <h2 id="metadata-json-title" className="text-lg font-semibold">Metadata JSON</h2>
          <p id="metadata-json-context" className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground">{recordLabel}{question ? ` · ${question}` : ""}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CopyButton value={json} subject="metadata JSON" />
          <button type="button" onClick={onClose} aria-label="Close metadata JSON" className="inline-flex size-9 items-center justify-center rounded-lg hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="size-4" aria-hidden="true" /></button>
        </div>
      </header>
      <div className="min-h-0 overflow-auto p-5">
        <pre role="region" aria-label="Record metadata JSON" tabIndex={0} className="whitespace-pre-wrap break-words rounded-xl border bg-muted/30 p-4 font-mono text-[13px] leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><code>{json}</code></pre>
      </div>
    </Dialog>
  );
}
