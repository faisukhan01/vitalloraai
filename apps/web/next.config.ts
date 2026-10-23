import type { NextConfig } from "next";

// VITALORA AI — web configuration.
//
// Sandbox / same-origin mode: API_PROXY_URL points at the Caddy gateway,
// which forwards /api/* (including the XTransformPort query) to the
// FastAPI backend. The browser only ever talks to the Next.js origin.
const API_PROXY_URL = process.env.API_PROXY_URL ?? "";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  transpilePackages: ["@vitalora/shared-types", "@vitalora/api-client"],
  async rewrites() {
    if (!API_PROXY_URL) return [];
    return [
      {
        source: "/api/:path*",
        destination: `${API_PROXY_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
