"use client";

import { PAGE_FRAME } from "@/lib/page-frame";
import { Suspense } from "react";
import { notFound, useSearchParams } from "next/navigation";
import { SimulatedEvidenceWorkbench } from "@/components/simulated-evidence-workbench";

export default function EvidencePreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <Suspense><PreviewFromUrl /></Suspense>;
}

function PreviewFromUrl() {
  const params = useSearchParams();
  return (
    <div className={PAGE_FRAME}>
      <SimulatedEvidenceWorkbench config={{
        enabled: true,
        caseId: params.get("case"),
        view: params.get("view"),
        filter: params.get("filter"),
        stepId: params.get("step"),
        state: params.get("state"),
      }} />
    </div>
  );
}
