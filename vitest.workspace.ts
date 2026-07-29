import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      exclude: ["**/fixtures/**/test/**", "**/node_modules/**"],
      include: ["**/test/**/*.test.ts"],
    },
  },
]);
