import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

describe("Proofgrove compatibility redirects", () => {
  it("keeps Evaluations and Projects canonical while redirecting legacy library routes", async () => {
    const redirects = await nextConfig.redirects?.();

    expect(redirects).toEqual([
      { source: "/runs", destination: "/evaluations", permanent: true },
      { source: "/experiments", destination: "/evaluations?tab=experiments", permanent: true },
      { source: "/compare", destination: "/evaluations?tab=experiments", permanent: true },
      { source: "/tracing", destination: "/projects", permanent: true },
      { source: "/tracing/projects/:path*", destination: "/projects/:path*", permanent: true },
    ]);
    expect(redirects).not.toEqual(expect.arrayContaining([expect.objectContaining({ source: "/evaluations" })]));
  });
});
