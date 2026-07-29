import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/fixtures/**/test/**", "**/node_modules/**"],
    include: ["**/test/**/*.test.ts"],
    passWithNoTests: true,
  },
});
