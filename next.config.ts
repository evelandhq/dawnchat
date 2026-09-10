import type { NextConfig } from "next";

import { resolveEvelandConfig } from "./src/identity/config";

const { internalOrigin } = resolveEvelandConfig();

const nextConfig: NextConfig = {
  typedRoutes: true,
  output: "standalone",
  reactCompiler: true,
  async rewrites() {
    return [
      {
        source: "/api/identity/:path*",
        destination: `${internalOrigin}/api/identity/:path*`,
      },
    ];
  },
};

export default nextConfig;
