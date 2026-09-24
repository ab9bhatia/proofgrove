import type { Metadata } from "next";
import type { ReactNode } from "react";

// The dataset detail page is a client component and cannot export metadata
// itself. Dataset names are human-readable, so the route param is the title.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}): Promise<Metadata> {
  const { name } = await params;
  return { title: `Dataset ${decodeURIComponent(name)}` };
}

export default function DatasetDetailLayout({ children }: { children: ReactNode }) {
  return children;
}
