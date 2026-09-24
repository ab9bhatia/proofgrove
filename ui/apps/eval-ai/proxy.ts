// Proofgrove Proofgrove UI Next 16 proxy.
//
// All real logic lives in @evalai/shared/proxy so platform-ui and tenant-ui
// can share it. This file exists only because Next 16 requires `proxy.ts`
// at the app root, and the matcher must be a literal (statically analysed).

import type { NextRequest } from "next/server";
import { mintUserCookie } from "@evalai/shared/proxy";
import { withSecurityHeaders } from "@evalai/shared/security-proxy";

export function proxy(request: NextRequest) {
  return withSecurityHeaders(request, mintUserCookie);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
