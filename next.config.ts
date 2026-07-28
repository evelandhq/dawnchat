import type { NextConfig } from "next";

const identityBaseUrl = (
  process.env.EVELAND_IDENTITY_URL ??
  process.env.NEXT_PUBLIC_EVELAND_IDENTITY_URL ??
  "http://localhost:4000"
).replace(/\/$/, "");

const nextConfig: NextConfig = {
  typedRoutes: true,
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/identity/:path*",
        destination: `${identityBaseUrl}/identity/:path*`,
      },
    ];
  },
};

export default nextConfig;
