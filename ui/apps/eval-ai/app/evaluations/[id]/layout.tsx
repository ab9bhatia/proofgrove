import type { Metadata } from "next";
import type { ReactNode } from "react";

// This route renders the experiment detail view (a client component that cannot
// export metadata). The id is enough for a distinguishable tab title.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const experimentId = decodeURIComponent(id);
  return {
    title: `Experiment ${experimentId.length > 12 ? `${experimentId.slice(0, 8)}…` : experimentId}`,
  };
}

export default function EvaluationDetailLayout({ children }: { children: ReactNode }) {
  return children;
}
