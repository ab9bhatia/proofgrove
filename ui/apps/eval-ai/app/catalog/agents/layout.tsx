import type { Metadata } from "next";
import type { ReactNode } from "react";

// The page below is a client component and cannot export metadata itself.
export const metadata: Metadata = { title: "Agents" };

export default function AgentCatalogLayout({ children }: { children: ReactNode }) {
  return children;
}
