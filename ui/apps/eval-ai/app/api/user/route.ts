import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Local classroom identity; this lite app has no production authentication. */
export async function GET() {
  return NextResponse.json(
    { firstName: "Classroom", lastName: "Learner", email: "learner@evalai.local" },
    { headers: { "cache-control": "no-store" } },
  );
}
