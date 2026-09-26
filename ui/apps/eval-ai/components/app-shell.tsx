"use client";

import { Sidebar } from "@/components/sidebar";
import { LabModeBanner } from "@/components/lab-mode-banner";

/**
 * App chrome for Proofgrove — left sidebar + scrollable main pane.
 * Slate navigation rail, off-white/dark workspace canvas (Proofgrove).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    // dvh, not svh. `svh` is the viewport at its *smallest* — the size it would be
    // with every dynamic browser toolbar shown — so on a desktop window whose chrome
    // is static the shell renders shorter than the visible area and leaves a band of
    // bare background under both the rail and the workspace. `dvh` tracks what is
    // actually visible, which is what a full-height app frame wants.
    <div className="flex h-dvh overflow-hidden bg-brand-slate">
      <a
        href="#main-content"
        className="fixed left-4 top-4 z-[100] -translate-y-20 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground shadow-hover transition-transform duration-150 ease-standard focus:translate-y-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        Skip to main content
      </a>
      <Sidebar />
      <main
        id="main-content"
        tabIndex={-1}
        className="proofgrove-workspace proofgrove-workspace-scroll min-h-0 min-w-0 flex-1 overflow-auto overscroll-none pt-[calc(4rem+env(safe-area-inset-top))] lg:pt-0"
      >
        <div className="min-h-full">
          <LabModeBanner />
          {children}
        </div>
      </main>
    </div>
  );
}
