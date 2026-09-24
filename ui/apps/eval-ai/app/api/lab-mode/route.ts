import { labMode } from "@/lib/lab-mode";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await labMode(), { headers: { "Cache-Control": "no-store" } });
}
