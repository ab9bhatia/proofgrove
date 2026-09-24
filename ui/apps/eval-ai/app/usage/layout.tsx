import type { Metadata } from "next";
import type { ReactNode } from "react";

// The page below is a client component and cannot export metadata itself.
export const metadata: Metadata = { title: "Usage" };

export default function UsageLayout({ children }: { children: ReactNode }) {
  return children;
}
