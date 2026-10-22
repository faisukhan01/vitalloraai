import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  transpilePackages: ["@vitalora/shared-types", "@vitalora/api-client"],
};

export default nextConfig;
