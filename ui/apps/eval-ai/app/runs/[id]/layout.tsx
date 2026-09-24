import type { Metadata } from "next";
import type { ReactNode } from "react";

// The run report page is a client component and cannot export metadata itself.
// The id is enough for a distinguishable tab title; long ids are shortened.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const runId = decodeURIComponent(id);
  return { title: `Run ${runId.length > 12 ? `${runId.slice(0, 8)}…` : runId}` };
}

export default function RunDetailLayout({ children }: { children: ReactNode }) {
  return children;
}
