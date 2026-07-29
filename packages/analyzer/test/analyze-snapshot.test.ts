import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  analyzeSnapshot,
  computeSnapshotDigest,
  mapChangedSymbols,
} from "../src/index.js";

it("maps the authentication change to validateToken and its dependant", async () => {
  const base = await analyzeSnapshot({
    root: "fixtures/auth-regression/base",
    snapshotSha: "a".repeat(40),
  });
  const head = await analyzeSnapshot({
    root: "fixtures/auth-regression/head",
    snapshotSha: "b".repeat(40),
  });

  const changed = mapChangedSymbols(base, head);

  expect(changed.map((item) => item.name)).toEqual(["validateToken"]);
  expect(head.edges).toContainEqual(
    expect.objectContaining({
      relation: "CALLS",
      fromName: "restoreSession",
      toName: "validateToken",
    }),
  );
  expect(head.tests[0]?.path).toBe("test/auth.test.ts");
  expect(
    head.symbols.find((symbol) => symbol.label === "validateToken")?.source,
  ).toEqual({
    snapshotSha: "b".repeat(40),
    path: "src/auth.ts",
    startLine: 14,
    endLine: 19,
  });
  for (const source of [
    ...head.symbols.map((item) => item.source),
    ...head.tests.map((item) => item.source),
    ...head.contracts.map((item) => item.source),
    ...head.branches.map((item) => item.source),
    ...head.evidence.flatMap((item) => (item.source ? [item.source] : [])),
  ]) {
    expect(source.snapshotSha).toBe("b".repeat(40));
    expect(source.path).not.toMatch(
      /^(?:\/|\\|[A-Za-z]:)|(?:^|\/)\.\.(?:\/|$)/,
    );
  }
});

it("computes a stable content digest that distinguishes snapshots", async () => {
  const firstBase = await computeSnapshotDigest(
    "fixtures/auth-regression/base",
  );
  const secondBase = await computeSnapshotDigest(
    "fixtures/auth-regression/base",
  );
  const head = await computeSnapshotDigest("fixtures/auth-regression/head");

  expect(firstBase).toMatch(/^[0-9a-f]{40}$/);
  expect(secondBase).toBe(firstBase);
  expect(head).not.toBe(firstBase);
});

it("includes non-source regular files in the snapshot digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeatlas-digest-"));
  try {
    await writeFile(join(root, "source.ts"), "export const answer = 42;\n");
    await writeFile(join(root, "package.json"), '{"version":"1.0.0"}\n');
    const before = await computeSnapshotDigest(root);

    await writeFile(join(root, "package.json"), '{"version":"2.0.0"}\n');

    await expect(computeSnapshotDigest(root)).resolves.not.toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a source symlink that escapes the resolved snapshot root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "codeatlas-symlink-"));
  const root = join(parent, "snapshot");
  try {
    await mkdir(root);
    const outside = join(parent, "outside.ts");
    await writeFile(outside, "export function outside() {}\n");
    await symlink(outside, join(root, "escape.ts"));

    await expect(
      analyzeSnapshot({ root, snapshotSha: "c".repeat(40) }),
    ).rejects.toThrow("Symlink escapes snapshot root");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("resolves direct calls across source files without loading target modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeatlas-cross-file-"));
  try {
    await writeFile(
      join(root, "helper.ts"),
      "export function helper(): string { return 'safe'; }\n",
    );
    await writeFile(
      join(root, "main.ts"),
      "import { helper } from './helper.js';\nexport function caller(): string { return helper(); }\n",
    );

    const analysis = await analyzeSnapshot({
      root,
      snapshotSha: "d".repeat(40),
    });

    expect(analysis.edges).toContainEqual(
      expect.objectContaining({
        relation: "CALLS",
        fromName: "caller",
        toName: "helper",
        evidenceType: "STATIC_CALLGRAPH",
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
