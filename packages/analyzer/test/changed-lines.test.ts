import { expect, it } from "vitest";

import { analyzeSnapshot, mapChangedSymbols } from "../src/index.js";

it("maps changed line spans to the enclosing symbol", async () => {
  const base = await analyzeSnapshot({
    root: "fixtures/auth-regression/base",
    snapshotSha: "a".repeat(40),
  });
  const head = await analyzeSnapshot({
    root: "fixtures/auth-regression/head",
    snapshotSha: "b".repeat(40),
  });

  expect(mapChangedSymbols(base, head)).toEqual([
    {
      id: head.symbols.find((symbol) => symbol.name === "validateToken")?.id,
      name: "validateToken",
      path: "src/auth.ts",
      baseLocation: {
        snapshotSha: "a".repeat(40),
        path: "src/auth.ts",
        startLine: 14,
        endLine: 18,
      },
      headLocation: {
        snapshotSha: "b".repeat(40),
        path: "src/auth.ts",
        startLine: 14,
        endLine: 19,
      },
      changedLines: [15, 16, 17, 18],
      signatureChanged: false,
    },
  ]);
});
