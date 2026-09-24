import { cn } from "@evalai/shared/utils";
import type { TraceMetadataField } from "@/components/tracing/trace-metadata";

/**
 * The two label/value primitives the inspector reads facts with.
 *
 * `MetadataBand` used to draw itself as a bordered, tinted card. Sitting inside
 * the summary card that already was one, it produced a card inside a card and
 * read as a raised surface rather than as a group. It groups with space now.
 */
export function MetadataBand({ fields, className }: { fields: ReadonlyArray<TraceMetadataField>; className?: string }) {
  return (
    <dl
      aria-label="Trace metadata"
      className={cn("grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3", className)}
    >
      {fields.map((field) => (
        <div key={field.key} className="min-w-0">
          <dt className="text-muted-foreground">{field.label}</dt>
          <dd className="mt-0.5 break-all font-mono text-sm text-foreground">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Datum({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 break-all text-sm text-foreground", mono && "font-mono text-xs")}>{value}</dd>
    </div>
  );
}
