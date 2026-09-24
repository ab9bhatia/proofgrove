import { AlertTriangle, ShieldAlert } from "lucide-react";
import type { TraceWarning } from "@/components/tracing/trace-workspace";
import { cn } from "@evalai/shared/utils";

// Compact, honest capture/attestation/invocation warning band. A partial
// capture stays "Partial capture"; it is never hidden or upgraded. Renders
// nothing when the trace is fully captured, attested and succeeded.
export function CaptureBand({ warnings }: { warnings: TraceWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <section
      aria-label="Capture integrity warnings"
      className="mt-3 text-sm"
    >
      <details className="group rounded-lg border bg-card px-3">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {warnings.map((warning) => warning.label).join(" · ")}
          <span className="ml-2 font-normal text-muted-foreground">Capture details</span>
        </summary>
        <div className="space-y-2 border-t py-3">
      {warnings.map((warning) => {
        const Icon = warning.tone === "error" ? ShieldAlert : AlertTriangle;
        return (
          <div key={warning.id} className="flex items-start gap-2 text-sm">
            <Icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                warning.tone === "error" ? "text-red-600 dark:text-red-400" : "text-state-caution",
              )}
              aria-hidden="true"
            />
            <p className="min-w-0">
              <span className="font-medium">{warning.label}.</span>{" "}
              <span className="text-muted-foreground">{warning.detail}</span>
            </p>
          </div>
        );
      })}
        </div>
      </details>
    </section>
  );
}
