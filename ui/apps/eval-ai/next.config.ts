import type { NextConfig } from "next";
import path from "node:path";
import { SECURITY_HEADERS } from "@evalai/shared/security-headers";

const workspaceRoot = path.join(__dirname, "../../");

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: workspaceRoot,
  transpilePackages: ["@evalai/shared", "@evalai/otel-web"],
  async redirects() {
    return [
      { source: "/runs", destination: "/evaluations", permanent: true },
      { source: "/experiments", destination: "/evaluations?tab=experiments", permanent: true },
      { source: "/compare", destination: "/evaluations?tab=experiments", permanent: true },
      { source: "/tracing", destination: "/projects", permanent: true },
      { source: "/tracing/projects/:path*", destination: "/projects/:path*", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
