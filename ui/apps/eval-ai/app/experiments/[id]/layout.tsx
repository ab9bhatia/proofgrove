import type { Metadata } from "next";
import type { ReactNode } from "react";

// The experiment detail page is a client component and cannot export metadata
// itself. The id is enough for a distinguishable tab title; long ids are shortened.
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

export default function ExperimentDetailLayout({ children }: { children: ReactNode }) {
  return children;
}
