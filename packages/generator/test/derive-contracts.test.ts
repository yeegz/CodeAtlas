import { expect, it } from "vitest";
import type {
  AnalyzedBranch,
  AnalyzedContract,
  ChangedSymbol,
} from "../../analyzer/src/index.js";
import type { TestSelection } from "../../selector/src/index.js";
import {
  deriveTestObjectives,
  type DeriveTestObjectivesInput,
} from "../src/index.js";

const snapshotSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

it("keeps branch provenance when another file covers the same line", () => {
  const objectives = deriveTestObjectives(
    input({
      coverage: [{ path: "src/other.ts", coveredLines: [17] }],
    }),
  );

  expect(objectives).toEqual([
    expect.objectContaining({
      targetSymbol: "validateToken",
      entryPoint: "restoreSession",
      source: {
        snapshotSha,
        path: "src/auth.ts",
        startLine: 17,
        endLine: 17,
      },
      evidenceIds: ["ev:branch", "ev:contract", "ev:selected"],
    }),
  ]);
  expect(
    deriveTestObjectives(
      input({ coverage: [{ path: "src/auth.ts", coveredLines: [17] }] }),
    ),
  ).toEqual([]);
});

it("merges tied evidence independently of input order and keeps distinct same-line branches", () => {
  const first = input({
    branches: [
      branch({ evidenceIds: ["ev:branch-z"] }),
      branch({ evidenceIds: ["ev:branch-a"] }),
      branch({ id: "branch:conditional", kind: "conditional" }),
    ],
    publicEntryPoints: [
      contract({ evidenceIds: ["ev:contract-z"] }),
      contract({ evidenceIds: ["ev:contract-a"] }),
    ],
    selectedTests: [
      selection({ evidenceIds: ["ev:selected-z"] }),
      selection({ evidenceIds: ["ev:selected-a"] }),
    ],
  });
  const reversed: DeriveTestObjectivesInput = {
    changedSymbols: [...first.changedSymbols].reverse(),
    branches: [...first.branches].reverse(),
    coverage: [...first.coverage].reverse(),
    publicEntryPoints: [...first.publicEntryPoints].reverse(),
    selectedTests: [...first.selectedTests].reverse(),
  };

  const expected = [
    {
      id: "objective:regression-test:symbol%3AvalidateToken:branch%3Aconditional:conditional:17:restoreSession",
      evidenceIds: [
        "ev:branch",
        "ev:contract",
        "ev:selected",
        "ev:branch-a",
        "ev:branch-z",
        "ev:contract-a",
        "ev:contract-z",
        "ev:selected-a",
        "ev:selected-z",
      ],
    },
    {
      id: "objective:regression-test:symbol%3AvalidateToken:branch%3Aexpiration:if:17:restoreSession",
      evidenceIds: [
        "ev:branch",
        "ev:contract",
        "ev:selected",
        "ev:branch-a",
        "ev:branch-z",
        "ev:contract-a",
        "ev:contract-z",
        "ev:selected-a",
        "ev:selected-z",
      ],
    },
  ];

  expect(
    deriveTestObjectives(first).map(({ id, evidenceIds }) => ({
      id,
      evidenceIds,
    })),
  ).toEqual(expected);
  expect(
    deriveTestObjectives(reversed).map(({ id, evidenceIds }) => ({
      id,
      evidenceIds,
    })),
  ).toEqual(expected);
});

it("does not invent an entry point from another source file", () => {
  expect(
    deriveTestObjectives(
      input({
        publicEntryPoints: [
          contract({
            id: "contract:unrelated",
            name: "unrelatedEntry",
            source: location("src/other.ts", 4),
          }),
        ],
      }),
    ),
  ).toEqual([]);
});

it("derives from frozen upstream input without mutating records or arrays", () => {
  const value = input({
    branches: [
      branch({ evidenceIds: ["ev:z", "ev:a"] }),
      branch({ evidenceIds: ["ev:b"] }),
    ],
  });
  const before = structuredClone(value);
  deepFreeze(value);

  expect(deriveTestObjectives(value)).toEqual([
    expect.objectContaining({
      source: location("src/auth.ts", 17),
      evidenceIds: expect.arrayContaining(["ev:a", "ev:b", "ev:z"]),
    }),
  ]);
  expect(value).toEqual(before);
});

function input(
  overrides: Partial<DeriveTestObjectivesInput> = {},
): DeriveTestObjectivesInput {
  return {
    changedSymbols: [changedSymbol()],
    branches: [branch()],
    coverage: [],
    publicEntryPoints: [contract()],
    selectedTests: [selection()],
    ...overrides,
  };
}

function changedSymbol(overrides: Partial<ChangedSymbol> = {}): ChangedSymbol {
  return {
    id: "symbol:validateToken",
    name: "validateToken",
    path: "src/auth.ts",
    baseLocation: location("src/auth.ts", 14, 18),
    headLocation: location("src/auth.ts", 14, 19),
    changedLines: [17, 18, 19],
    signatureChanged: false,
    ...overrides,
  };
}

function branch(
  overrides: Partial<AnalyzedBranch> = {},
): AnalyzedBranch & { symbolId: string; line: number } {
  return {
    id: "branch:expiration",
    kind: "if",
    source: location("src/auth.ts", 17),
    evidenceIds: ["ev:branch"],
    symbolId: "symbol:validateToken",
    line: 17,
    ...overrides,
  };
}

function contract(
  overrides: Partial<AnalyzedContract> = {},
): AnalyzedContract & { path: string } {
  return {
    id: "contract:restoreSession",
    symbolId: "symbol:restoreSession",
    name: "restoreSession",
    signature: "restoreSession(token: Token, now: number): SessionResponse",
    signatureDigest: "digest:restoreSession",
    source: location("src/auth.ts", 21, 29),
    evidenceIds: ["ev:contract"],
    path: overrides.source?.path ?? "src/auth.ts",
    ...overrides,
  };
}

function selection(overrides: Partial<TestSelection> = {}): TestSelection {
  return {
    testId: "test:auth",
    path: "test/auth.test.ts",
    reasons: ["Reaches validateToken."],
    evidenceIds: ["ev:selected"],
    ...overrides,
  };
}

function location(path: string, startLine: number, endLine = startLine) {
  return { snapshotSha, path, startLine, endLine };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
