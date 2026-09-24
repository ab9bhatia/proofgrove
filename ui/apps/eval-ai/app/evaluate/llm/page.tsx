import type { Metadata } from "next";
import { Suspense } from "react";
import { LegacyEvaluationRedirect } from "@/components/legacy-evaluation-redirect";

export const metadata: Metadata = { title: "Evaluate" };

function Fallback() {
  return (
    <div className="flex justify-center py-24">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
    </div>
  );
}

export default function LlmEvaluationPage() {
  return (
    <Suspense fallback={<Fallback />}>
      <LegacyEvaluationRedirect kind="llm" />
    </Suspense>
  );
}
