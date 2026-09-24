/** User-facing helpers for agent invocation / row execution errors. */

const MIB = 1024 * 1024;

export type OversizedOutputDiagnostics = {
  error_type: "AGENT_OUTPUT_TOO_LARGE";
  limit_bytes?: number;
  received_bytes?: number;
  partial_output_available?: boolean;
  stage?: string;
  retryable?: boolean;
};

export function isAgentOutputTooLarge(
  invocationError: string | null | undefined,
  output?: Record<string, unknown> | null,
  errorType?: string | null,
): boolean {
  if (errorType === "AGENT_OUTPUT_TOO_LARGE") return true;
  if (output?.error_type === "AGENT_OUTPUT_TOO_LARGE") return true;
  return Boolean(invocationError?.startsWith("AGENT_OUTPUT_TOO_LARGE"));
}

export function oversizedDiagnosticsFromOutput(
  output?: Record<string, unknown> | null,
): OversizedOutputDiagnostics | null {
  if (!output || output.error_type !== "AGENT_OUTPUT_TOO_LARGE") return null;
  return {
    error_type: "AGENT_OUTPUT_TOO_LARGE",
    limit_bytes: typeof output.limit_bytes === "number" ? output.limit_bytes : undefined,
    received_bytes: typeof output.received_bytes === "number" ? output.received_bytes : undefined,
    partial_output_available: Boolean(output.partial_output_available),
    stage: typeof output.stage === "string" ? output.stage : undefined,
    retryable: typeof output.retryable === "boolean" ? output.retryable : false,
  };
}

function formatMib(bytes: number | undefined, fallback = 1): string {
  const value = typeof bytes === "number" && Number.isFinite(bytes) ? bytes / MIB : fallback;
  return `${value.toFixed(1)} MiB`;
}

/** Primary title for oversized agent stream failures. */
export function oversizedOutputTitle(): string {
  return "Agent transport envelope exceeded";
}

/** Body copy for oversized agent stream failures (no raw exception text). */
export function oversizedOutputDescription(diagnostics?: OversizedOutputDiagnostics | null): string {
  const limit = formatMib(diagnostics?.limit_bytes, 1);
  return (
    `The A2A stream exceeded the ${limit} transport safety envelope. ` +
    "Individual large tool results are normally stored as artifacts before evaluation."
  );
}

export function oversizedOutputReceivedLabel(
  diagnostics?: OversizedOutputDiagnostics | null,
): string {
  const limitBytes = diagnostics?.limit_bytes ?? MIB;
  const received = diagnostics?.received_bytes;
  const limitLabel = formatMib(limitBytes);
  if (typeof received === "number" && Number.isFinite(received)) {
    const receivedLabel =
      received > limitBytes ? `>${formatMib(limitBytes)}` : formatMib(received);
    return `Received: ${receivedLabel} · Limit: ${limitLabel}`;
  }
  return `Received: >${limitLabel} · Limit: ${limitLabel}`;
}
