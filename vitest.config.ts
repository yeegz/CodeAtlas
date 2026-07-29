import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/fixtures/**/test/**"],
    include: ["**/test/**/*.test.ts"],
    passWithNoTests: true,
  },
});
