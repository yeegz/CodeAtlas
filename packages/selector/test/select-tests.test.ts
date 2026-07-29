import { expect, it } from "vitest";

import { explainExclusion, selectTests } from "../src/index.js";

it("selects the auth test through the changed symbol call path", () => {
  const selections = selectTests({
    changedSymbolIds: ["symbol:validateToken"],
    tests: [
      {
        id: "test:auth",
        path: "test/auth.test.ts",
        importedFileIds: ["file:auth"],
      },
    ],
    edges: [
      {
        from: "symbol:restoreSession",
        to: "symbol:validateToken",
        relation: "CALLS",
        evidenceIds: ["ev:call"],
      },
      {
        from: "test:auth",
        to: "symbol:restoreSession",
        relation: "TESTS",
        evidenceIds: ["ev:test"],
      },
    ],
  });

  expect(selections[0]).toEqual({
    testId: "test:auth",
    path: "test/auth.test.ts",
    reasons: ["Calls restoreSession(), which reaches changed validateToken()."],
    evidenceIds: ["ev:test", "ev:call"],
  });
});

it("explains an unrelated test exclusion", () => {
  const input = {
    changedSymbolIds: ["symbol:validateToken"],
    tests: [
      { id: "test:auth", path: "test/auth.test.ts" },
      { id: "test:billing", path: "test/billing.test.ts" },
    ],
    edges: [
      {
        from: "test:auth",
        to: "symbol:validateToken",
        relation: "TESTS",
        evidenceIds: ["ev:auth"],
      },
    ],
  };

  expect(selectTests(input).map((selection) => selection.testId)).toEqual([
    "test:auth",
  ]);
  expect(explainExclusion("test:billing", input)).toEqual({
    testId: "test:billing",
    excluded: true,
    reason: "NO_REACHABLE_CHANGED_SYMBOL",
  });
});

it("chooses the shortest cycle-safe path and deduplicates its evidence", () => {
  const selections = selectTests({
    changedSymbolIds: ["symbol:changed"],
    tests: [{ id: "test:target", path: "test/target.test.ts" }],
    edges: [
      {
        from: "symbol:slow",
        to: "symbol:changed",
        relation: "CALLS",
        evidenceIds: ["ev:slow"],
      },
      {
        from: "symbol:cycle",
        to: "symbol:slow",
        relation: "CALLS",
        evidenceIds: ["ev:cycle"],
      },
      {
        from: "symbol:slow",
        to: "symbol:cycle",
        relation: "CALLS",
        evidenceIds: ["ev:back"],
      },
      {
        from: "test:target",
        to: "symbol:cycle",
        relation: "TESTS",
        evidenceIds: ["ev:test", "ev:test"],
      },
      {
        from: "symbol:fast",
        to: "symbol:changed",
        relation: "CALLS",
        evidenceIds: ["ev:fast"],
      },
      {
        from: "test:target",
        to: "symbol:fast",
        relation: "TESTS",
        evidenceIds: ["ev:test", "ev:fast"],
      },
    ],
  });

  expect(selections).toEqual([
    {
      testId: "test:target",
      path: "test/target.test.ts",
      reasons: ["Calls fast(), which reaches changed changed()."],
      evidenceIds: ["ev:test", "ev:fast"],
    },
  ]);
});

it("sorts selected tests by path", () => {
  const selections = selectTests({
    changedSymbolIds: ["symbol:changed"],
    tests: [
      { id: "test:zebra", path: "test/zebra.test.ts" },
      { id: "test:apple", path: "test/apple.test.ts" },
    ],
    edges: [
      {
        from: "test:zebra",
        to: "symbol:changed",
        relation: "TESTS",
        evidenceIds: ["ev:z"],
      },
      {
        from: "test:apple",
        to: "symbol:changed",
        relation: "TESTS",
        evidenceIds: ["ev:a"],
      },
    ],
  });

  expect(selections.map((selection) => selection.path)).toEqual([
    "test/apple.test.ts",
    "test/zebra.test.ts",
  ]);
});

it("excludes paths longer than eight edges", () => {
  const selections = selectTests({
    changedSymbolIds: ["symbol:changed"],
    tests: [{ id: "test:nine-hops", path: "test/nine-hops.test.ts" }],
    edges: [
      { from: "symbol:one", to: "symbol:changed", relation: "CALLS" },
      { from: "symbol:two", to: "symbol:one", relation: "CALLS" },
      { from: "symbol:three", to: "symbol:two", relation: "CALLS" },
      { from: "symbol:four", to: "symbol:three", relation: "CALLS" },
      { from: "symbol:five", to: "symbol:four", relation: "CALLS" },
      { from: "symbol:six", to: "symbol:five", relation: "CALLS" },
      { from: "symbol:seven", to: "symbol:six", relation: "CALLS" },
      { from: "symbol:eight", to: "symbol:seven", relation: "CALLS" },
      { from: "test:nine-hops", to: "symbol:eight", relation: "TESTS" },
    ],
  });

  expect(selections).toEqual([]);
});

it("excludes an AI-inference-only path with its own explanation", () => {
  const input = {
    changedSymbolIds: ["symbol:changed"],
    tests: [{ id: "test:ai-only", path: "test/ai-only.test.ts" }],
    edges: [
      {
        from: "symbol:inferredCaller",
        to: "symbol:changed",
        relation: "CALLS",
        evidenceType: "AI_INFERENCE" as const,
        evidenceIds: ["ev:inferred-call"],
      },
      {
        from: "test:ai-only",
        to: "symbol:inferredCaller",
        relation: "TESTS",
        evidenceIds: ["ev:test"],
      },
    ],
  };

  expect(selectTests(input)).toEqual([]);
  expect(explainExclusion("test:ai-only", input)).toEqual({
    testId: "test:ai-only",
    excluded: true,
    reason: "AI_INFERENCE_PATH_ONLY",
  });
});

it("selects a static path when an AI-inference path exists in parallel", () => {
  const selections = selectTests({
    changedSymbolIds: ["symbol:changed"],
    tests: [{ id: "test:mixed", path: "test/mixed.test.ts" }],
    edges: [
      {
        from: "symbol:inferredCaller",
        to: "symbol:changed",
        relation: "CALLS",
        evidenceType: "AI_INFERENCE",
        evidenceIds: ["ev:inferred-call"],
      },
      {
        from: "test:mixed",
        to: "symbol:inferredCaller",
        relation: "TESTS",
        evidenceIds: ["ev:inferred-test"],
      },
      {
        from: "symbol:staticCaller",
        to: "symbol:changed",
        relation: "CALLS",
        evidenceType: "STATIC_CALLGRAPH",
        evidenceIds: ["ev:static-call"],
      },
      {
        from: "test:mixed",
        to: "symbol:staticCaller",
        relation: "TESTS",
        evidenceIds: ["ev:static-test"],
      },
    ],
  });

  expect(selections).toEqual([
    {
      testId: "test:mixed",
      path: "test/mixed.test.ts",
      reasons: ["Calls staticCaller(), which reaches changed changed()."],
      evidenceIds: ["ev:static-test", "ev:static-call"],
    },
  ]);
});
