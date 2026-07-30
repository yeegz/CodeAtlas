import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const IGNORED = ["**/fixtures/**/test/**", "**/node_modules/**"];
const WEB_SRC = fileURLToPath(new URL("./apps/web/src", import.meta.url));

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "packages/*/test/**/*.test.ts",
            "apps/cli/test/**/*.test.ts",
          ],
          exclude: IGNORED,
        },
      },
      {
        // The web project needs a DOM and JSX. Vite's oxc transform with the
        // automatic runtime is enough for component tests; no React refresh
        // plugin is required.
        oxc: { jsx: { runtime: "automatic" } },
        // Mirrors the `@/*` path mapping the Next build uses.
        resolve: { alias: { "@": WEB_SRC } },
        test: {
          name: "web",
          environment: "jsdom",
          include: ["apps/web/test/**/*.test.tsx"],
          exclude: IGNORED,
          setupFiles: ["apps/web/test/setup.ts"],
        },
      },
    ],
  },
});
