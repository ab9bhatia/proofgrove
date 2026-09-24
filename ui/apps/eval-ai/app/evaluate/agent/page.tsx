import type { Metadata } from "next";
import { Suspense } from "react";
import { LegacyEvaluationRedirect } from "@/components/legacy-evaluation-redirect";

export const metadata: Metadata = { title: "Evaluate" };

export default function AgentEvaluationPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><div className="size-5 animate-spin rounded-full border-2 border-muted border-t-primary" /></div>}>
      <LegacyEvaluationRedirect kind="agent" />
    </Suspense>
  );
}
