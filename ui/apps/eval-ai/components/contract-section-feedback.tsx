import { AlertCircle, CheckCircle2 } from "lucide-react";

export type ContractSectionFeedbackMessage = {
  tone: "success" | "error";
  message: string;
};

export function ContractSectionFeedback({
  feedback,
}: {
  feedback: ContractSectionFeedbackMessage | null;
}) {
  if (!feedback) return null;

  const success = feedback.tone === "success";
  const Icon = success ? CheckCircle2 : AlertCircle;

  return (
    <div
      role={success ? "status" : "alert"}
      aria-live="polite"
      className={
        success
          ? "mx-5 mt-5 flex items-start gap-2.5 rounded-lg border border-state-positive/30 bg-state-positive-soft px-3 py-2.5 text-sm text-state-positive sm:mx-6"
          : "mx-5 mt-5 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive sm:mx-6"
      }
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{feedback.message}</span>
    </div>
  );
}
