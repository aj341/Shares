import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep server-only secrets (FINNHUB_API_KEY, MBOUM_API_KEY) out of the client bundle.
  // They are read only inside app/api/**/route.ts and lib/*.ts running on the server.
};

export default nextConfig;
