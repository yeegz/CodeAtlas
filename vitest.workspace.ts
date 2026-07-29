import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      exclude: ["**/fixtures/**/test/**"],
      include: ["**/test/**/*.test.ts"],
    },
  },
]);
