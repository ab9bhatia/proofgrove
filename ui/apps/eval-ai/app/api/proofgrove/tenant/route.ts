import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { publicApiError } from "@/lib/api-errors";
import { resolveTenant, TenantContextError } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(
      { tenant_id: resolveTenant() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (!(error instanceof TenantContextError)) throw error;
    const requestId = randomUUID();
    return NextResponse.json(publicApiError(503, requestId), {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "x-request-id": requestId,
      },
    });
  }
}
