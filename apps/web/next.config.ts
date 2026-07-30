import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // The workspace root is two levels above this app, so tracing does not walk
  // the whole filesystem looking for a lockfile.
  outputFileTracingRoot: resolve(here, "../.."),
  // The evidence packages ship TypeScript sources from the workspace.
  transpilePackages: [
    "@codeatlas/analyzer",
    "@codeatlas/differential",
    "@codeatlas/evidence",
    "@codeatlas/generator",
    "@codeatlas/passport",
    "@codeatlas/pipeline",
    "@codeatlas/runner",
    "@codeatlas/selector",
  ],
  eslint: {
    // Lint is owned by the workspace-level `pnpm lint` command.
    ignoreDuringBuilds: true,
  },
  webpack: (config) => {
    // The domain packages are NodeNext TypeScript, so they import siblings with
    // a `.js` specifier that resolves to a `.ts` file. Teach the bundler the
    // same mapping the TypeScript compiler already uses.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
