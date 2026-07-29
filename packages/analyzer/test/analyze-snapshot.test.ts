import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  analyzeSnapshot,
  computeSnapshotDigest,
  mapChangedSymbols,
} from "../src/index.js";

async function analyzeFiles(
  files: Record<string, string>,
  snapshotCharacter: string,
) {
  const root = await mkdtemp(join(tmpdir(), "codeatlas-analysis-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      await writeFile(join(root, path), content);
    }
    return await analyzeSnapshot({
      root,
      snapshotSha: snapshotCharacter.repeat(40),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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

it("represents export-list functions and anonymous default functions once", async () => {
  const analysis = await analyzeFiles(
    {
      "exports.ts": [
        "function selected(): string { return 'selected'; }",
        "export { selected as listed };",
        "export default function (): string { return selected(); }",
      ].join("\n"),
    },
    "e",
  );

  expect(analysis.symbols.map((symbol) => symbol.name)).toEqual([
    "selected",
    "default",
  ]);
  expect(analysis.contracts.map((contract) => contract.name)).toEqual([
    "selected",
    "default",
  ]);
  expect(
    analysis.edges
      .filter((edge) => edge.relation === "EXPORTS")
      .map((edge) => edge.toName)
      .sort(),
  ).toEqual(["default", "listed"]);
});

it("emits a re-export edge for an aliased source export", async () => {
  const analysis = await analyzeFiles(
    {
      "helper.ts": "export function helper(): string { return 'safe'; }\n",
      "index.ts": "export { helper as exposed } from './helper.js';\n",
    },
    "f",
  );

  expect(analysis.edges).toContainEqual(
    expect.objectContaining({
      relation: "EXPORTS",
      fromName: "index.ts",
      toName: "exposed",
      evidenceType: "STATIC_AST",
    }),
  );
});

it("maps a default export assignment to its local function", async () => {
  const analysis = await analyzeFiles(
    {
      "assigned.ts": [
        "function assigned(): string { return 'assigned'; }",
        "export default assigned;",
      ].join("\n"),
    },
    "0",
  );

  expect(analysis.symbols.map((symbol) => symbol.name)).toEqual(["assigned"]);
  expect(analysis.edges).toContainEqual(
    expect.objectContaining({
      relation: "EXPORTS",
      fromName: "assigned.ts",
      toName: "default",
    }),
  );
});

it("represents an anonymous default arrow export as a function contract", async () => {
  const analysis = await analyzeFiles(
    {
      "arrow.ts": "export default (): string => 'safe';\n",
    },
    "4",
  );

  expect(analysis.symbols.map((symbol) => symbol.name)).toEqual(["default"]);
  expect(analysis.contracts.map((contract) => contract.name)).toEqual([
    "default",
  ]);
  expect(analysis.edges).toContainEqual(
    expect.objectContaining({ relation: "EXPORTS", toName: "default" }),
  );
});

it("discovers chained Vitest definitions through imported bindings", async () => {
  const analysis = await analyzeFiles(
    {
      "chains.test.ts": [
        "import { it, test as scenario } from 'vitest';",
        "it.only('only case', () => {});",
        "scenario.skip('skipped case', () => {});",
        "it.todo('todo case');",
        "scenario.concurrent('concurrent case', () => {});",
        "it.each([[1]])('parameterized case', () => {});",
      ].join("\n"),
    },
    "1",
  );

  expect(analysis.tests.map((test) => test.name)).toEqual([
    "only case",
    "skipped case",
    "todo case",
    "concurrent case",
    "parameterized case",
  ]);
  expect(analysis.tests).toHaveLength(5);
});

it("does not classify a locally bound function named test", async () => {
  const analysis = await analyzeFiles(
    {
      "local.test.ts": [
        "function test(name: string, callback: () => void): void { callback(); }",
        "test('not a framework test', () => {});",
      ].join("\n"),
    },
    "2",
  );

  expect(analysis.tests).toEqual([]);
});

it("assigns unique stable identifiers to repeated same-line sites", async () => {
  const files = {
    "dependency.ts": [
      "export const first = 1;",
      "export const second = 2;",
    ].join("\n"),
    "sites.test.ts": [
      "import { it } from 'vitest';",
      "import { first } from './dependency.js'; import { second } from './dependency.js';",
      "export function target(): void {}",
      "export function caller(flag: boolean): void { target(); target(); if (flag) {} if (!flag) {} }",
      "it('same name', () => {}); it('same name', () => {});",
    ].join("\n"),
  };
  const first = await analyzeFiles(files, "3");
  const second = await analyzeFiles(files, "3");

  const imports = first.edges.filter(
    (edge) => edge.relation === "IMPORTS" && edge.toName === "./dependency.js",
  );
  const calls = first.edges.filter(
    (edge) =>
      edge.relation === "CALLS" &&
      edge.fromName === "caller" &&
      edge.toName === "target",
  );

  expect(imports).toHaveLength(2);
  expect(new Set(imports.map((edge) => edge.id)).size).toBe(2);
  expect(calls).toHaveLength(2);
  expect(new Set(calls.map((edge) => edge.id)).size).toBe(2);
  expect(first.branches).toHaveLength(2);
  expect(new Set(first.branches.map((branch) => branch.id)).size).toBe(2);
  expect(first.tests).toHaveLength(2);
  expect(new Set(first.tests.map((test) => test.id)).size).toBe(2);
  expect(new Set(first.evidence.map((item) => item.id)).size).toBe(
    first.evidence.length,
  );
  expect({
    edges: second.edges.map((edge) => edge.id),
    branches: second.branches.map((branch) => branch.id),
    tests: second.tests.map((test) => test.id),
    evidence: second.evidence.map((item) => item.id),
  }).toEqual({
    edges: first.edges.map((edge) => edge.id),
    branches: first.branches.map((branch) => branch.id),
    tests: first.tests.map((test) => test.id),
    evidence: first.evidence.map((item) => item.id),
  });
});
