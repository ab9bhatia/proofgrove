import "server-only";
import { NextResponse } from "next/server";
import { evalHubBaseUrl } from "@/lib/eval-hub";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIMEOUT_MS = 2500;

/**
 * Reachability of the Proofgrove backend, used by the UI readiness gate. The
 * backend is provisioned on demand (make deploy-eval-hub), so the UI can be live
 * before it exists; this pings /health/ready with a short timeout and reports
 * availability rather than surfacing raw proxy 502s to the user.
 */
export async function GET() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${evalHubBaseUrl()}/health/ready`, {
      signal: controller.signal,
      cache: "no-store",
    });
    return NextResponse.json({ available: res.ok });
  } catch {
    return NextResponse.json({ available: false });
  } finally {
    clearTimeout(timer);
  }
}
