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
  // 4GB sandbox: the OOM killer repeatedly murdered next-server (1.8GB RSS)
  // mid-compile, taking the whole preview down. Cap Turbopack's memory and
  // make it GC aggressively — stability beats marginal compile speed here.
  experimental: {
    turbopackMemoryLimit: 1024,
  },
  // Sandbox preview panels (preview-chat-*.space-z.ai) serve the app through a
  // proxy whose forwarded host differs from the dev server's own origin.
  // Without this, Next.js dev treats every /_next/* asset request as
  // cross-origin and its dev protection turns the proxied navigation into a
  // redirect loop (ERR_TOO_MANY_REDIRECTS) for the user.
  allowedDevOrigins: ["*.space-z.ai", "localhost", "127.0.0.1"],
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
