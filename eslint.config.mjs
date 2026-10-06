import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Flat-config ignores are anchored at the config directory, so each pattern
    // needs `**/` to also cover generated output inside workspace packages.
    ignores: [
      "**/.next/",
      // Next regenerates this declaration file during typegen and builds.
      "**/next-env.d.ts",
      "**/.codeatlas/",
      "**/coverage/",
      "**/dist/",
      "**/node_modules/",
      ".runner-review-snapshot-*/",
      ".runner-symlink-*/",
    ],
  },
  tseslint.configs.recommended,
);
