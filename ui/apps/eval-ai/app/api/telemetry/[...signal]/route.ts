import { createTelemetryHandler } from "@evalai/otel-web/server";
import { ROUTE_TEMPLATES } from "@/lib/route-templates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ADR-26-08-12 relay. The shared handler discards browser resource claims,
// allowlists attributes, bounds volume, removes URL queries, and never accepts
// prompts, responses, expected outputs, retrieval content, or tool payloads.
export const POST = createTelemetryHandler({
  serviceName: "eval-ai",
  app: "evalai",
  routeTemplates: ROUTE_TEMPLATES,
});
