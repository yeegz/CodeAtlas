import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Flat-config ignores are anchored at the config directory, so each pattern
    // needs `**/` to also cover generated output inside workspace packages.
    ignores: [
      "**/.next/",
      "**/.codeatlas/",
      "**/coverage/",
      "**/dist/",
      "**/node_modules/",
    ],
  },
  tseslint.configs.recommended,
);
