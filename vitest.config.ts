import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const IGNORED = ["**/fixtures/**/test/**", "**/node_modules/**"];
const WEB_SRC = fileURLToPath(new URL("./apps/web/src", import.meta.url));

/*
 * Runner, generator, pipeline and CLI cases execute the fixture suites for
 * real, spawning several child Vitest processes each. Those budgets bound
 * behaviour rather than latency, so they are generous: a tight default turns
 * ordinary machine load into a false failure.
 */
const EXECUTION_BUDGET_MS = 120_000;
const SUITE_BUDGET_MS = 900_000;

/*
 * Each of those files spawns its own multi-process Vitest runs, so letting
 * every file start at once oversubscribes the machine and slows the whole
 * suite down rather than speeding it up. The two projects also carry their own
 * group order, which runs them one after the other instead of competing for
 * the same cores.
 */
const MAX_CONCURRENT_FILES = 4;
const MAX_CONCURRENT_WEB_FILES = 2;

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
          testTimeout: EXECUTION_BUDGET_MS,
          hookTimeout: SUITE_BUDGET_MS,
          maxWorkers: MAX_CONCURRENT_FILES,
          sequence: { groupOrder: 0 },
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
          include: ["apps/web/test/**/*.test.{ts,tsx}"],
          exclude: IGNORED,
          setupFiles: ["apps/web/test/setup.ts"],
          testTimeout: EXECUTION_BUDGET_MS,
          hookTimeout: SUITE_BUDGET_MS,
          maxWorkers: MAX_CONCURRENT_WEB_FILES,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
