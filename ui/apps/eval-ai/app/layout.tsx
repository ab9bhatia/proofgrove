import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { TelemetryProvider, resolveTelemetryConfig } from "@evalai/otel-web";
import { Toaster } from "@evalai/shared/ui/sonner";
import { AppShell } from "@/components/app-shell";
import { ThemeProvider } from "@/components/theme";
import { UIStateProvider } from "@/components/ui-state";
import { BakeoffResume } from "@/components/bakeoff-resume";
import { ROUTE_TEMPLATES } from "@/lib/route-templates";
import { THEME_COOKIE } from "@/lib/theme-preference";
import "./globals.css";

/**
 * Every document must be server-rendered so the proxy's per-request CSP nonce
 * can be stamped onto Next.js's inline RSC bootstrap scripts. A statically
 * prerendered page is built before any nonce exists, so its inline
 * `self.__next_f.push(...)` scripts ship without one and the browser blocks
 * them under `script-src 'self' 'nonce-…'` — the page loads but never
 * hydrates. Setting this on the root layout keeps that invariant true for
 * pages added later, rather than relying on each one to opt in.
 *
 * Nothing is lost here: these apps sit behind the gateway's OIDC filter and
 * render per-user data, so their HTML was never publicly cacheable.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    default: "Proofgrove",
    template: "%s · Proofgrove",
  },
  description: "Proofgrove — a hands-on AI evaluation lab",
};

export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbf8ff" },
    { media: "(prefers-color-scheme: dark)", color: "#1e1f1e" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const telemetry = resolveTelemetryConfig("eval-ai", "evalai");
  const initialResolvedMode =
    (await cookies()).get(THEME_COOKIE)?.value === "dark" ? "dark" : "light";

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={initialResolvedMode === "dark" ? "dark" : undefined}
      style={{ colorScheme: initialResolvedMode }}
    >
      <body className="eval-hub-skin antialiased min-h-dvh bg-background text-foreground">
        <TelemetryProvider config={telemetry} routeTemplates={ROUTE_TEMPLATES} />
        <BakeoffResume />
        <ThemeProvider initialResolvedMode={initialResolvedMode}>
          <UIStateProvider>
            <AppShell>{children}</AppShell>
          </UIStateProvider>
        </ThemeProvider>
        <Toaster position="top-right" />
      </body>
    </html>
  );
}
