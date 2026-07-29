import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeSnapshotDigest } from "../../analyzer/src/index.js";
import { LocalExecutionProvider } from "../../runner/src/index.js";
import {
  TemplateTestGenerator,
  deriveTestObjectives,
  type DeriveTestObjectivesInput,
  type TestObjective,
} from "../src/index.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const generatedContent = `import { describe, expect, it } from "vitest";
import { restoreSession } from "../src/auth.js";

describe("generated: expired session regression", () => {
  it("returns SESSION_EXPIRED for a non-refreshable expired token", () => {
    const response = restoreSession({ subject: null, expiresAt: 50, refreshable: false }, 100);
    expect({
      httpStatus: response.status,
      code: "code" in response.body ? response.body.code : null,
    }).toEqual({ httpStatus: 401, code: "SESSION_EXPIRED" });
  });
});
`;

const objectiveInput: DeriveTestObjectivesInput = {
  changedSymbols: [
    {
      id: "symbol:validateToken",
      name: "validateToken",
      path: "src/auth.ts",
      changedLines: [17, 18, 19],
      evidenceIds: ["ev:changed-symbol"],
    },
  ],
  branches: [
    {
      id: "branch:validateToken:17",
      symbolId: "symbol:validateToken",
      line: 17,
      kind: "IF",
      evidenceIds: ["ev:branch"],
    },
  ],
  coveredLines: [18, 22, 27],
  publicEntryPoints: [
    {
      name: "restoreSession",
      path: "src/auth.ts",
      evidenceIds: ["ev:entry-point"],
    },
  ],
  selectedTestEvidence: [
    { testId: "test:auth", evidenceIds: ["ev:selected-test"] },
  ],
};

describe("deriveTestObjectives", () => {
  it("targets the uncovered changed expiration branch", () => {
    const objectives = deriveTestObjectives({
      changedSymbols: [
        {
          id: "symbol:validateToken",
          name: "validateToken",
          path: "src/auth.ts",
          changedLines: [17, 18, 19],
        },
      ],
      branches: [{ symbolId: "symbol:validateToken", line: 17, kind: "IF" }],
      coveredLines: [18, 22, 27],
      publicEntryPoints: [{ name: "restoreSession", path: "src/auth.ts" }],
    });
    expect(objectives).toEqual([
      expect.objectContaining({
        category: "REGRESSION_TEST",
        targetSymbol: "validateToken",
        entryPoint: "restoreSession",
        reason:
          "Changed expiration branch at src/auth.ts:17 has no mapped runtime coverage.",
      }),
    ]);
  });

  it("subtracts covered branches and emits stable sorted objectives with provenance", () => {
    const input: DeriveTestObjectivesInput = {
      changedSymbols: [
        {
          id: "symbol:zeta",
          name: "zeta",
          path: "src/z.ts",
          changedLines: [9, 7],
          evidenceIds: ["ev:z", "ev:shared"],
        },
        {
          id: "symbol:alpha",
          name: "alpha",
          path: "src/a.ts",
          changedLines: [4],
          evidenceIds: ["ev:a"],
        },
      ],
      branches: [
        {
          id: "branch:zeta:9",
          symbolId: "symbol:zeta",
          line: 9,
          kind: "IF",
          evidenceIds: ["ev:branch-z"],
        },
        {
          id: "branch:alpha:4",
          symbolId: "symbol:alpha",
          line: 4,
          kind: "IF",
          evidenceIds: ["ev:branch-a"],
        },
        {
          id: "branch:zeta:7",
          symbolId: "symbol:zeta",
          line: 7,
          kind: "IF",
          evidenceIds: ["ev:covered"],
        },
      ],
      coveredLines: [7],
      publicEntryPoints: [
        {
          name: "zEntry",
          path: "src/z.ts",
          evidenceIds: ["ev:entry-z"],
        },
        {
          name: "aEntry",
          path: "src/a.ts",
          evidenceIds: ["ev:entry-a"],
        },
      ],
      selectedTestEvidence: [
        { testId: "test:z", evidenceIds: ["ev:shared", "ev:test"] },
      ],
    };

    const first = deriveTestObjectives(input);
    const second = deriveTestObjectives({
      ...input,
      changedSymbols: [...input.changedSymbols].reverse(),
      branches: [...input.branches].reverse(),
      coveredLines: [...input.coveredLines].reverse(),
      publicEntryPoints: [...input.publicEntryPoints].reverse(),
    });

    expect(first).toEqual(second);
    expect(first).toEqual([
      {
        id: "objective:regression-test:symbol%3Aalpha:4:aEntry",
        category: "REGRESSION_TEST",
        targetSymbol: "alpha",
        entryPoint: "aEntry",
        reason: "Changed branch at src/a.ts:4 has no mapped runtime coverage.",
        source: { path: "src/a.ts", startLine: 4, endLine: 4 },
        evidenceIds: [
          "ev:a",
          "ev:branch-a",
          "ev:entry-a",
          "ev:shared",
          "ev:test",
        ],
      },
      {
        id: "objective:regression-test:symbol%3Azeta:9:zEntry",
        category: "REGRESSION_TEST",
        targetSymbol: "zeta",
        entryPoint: "zEntry",
        reason: "Changed branch at src/z.ts:9 has no mapped runtime coverage.",
        source: { path: "src/z.ts", startLine: 9, endLine: 9 },
        evidenceIds: [
          "ev:branch-z",
          "ev:entry-z",
          "ev:shared",
          "ev:test",
          "ev:z",
        ],
      },
    ]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0]?.source)).toBe(true);
    expect(Object.isFrozen(first[0]?.evidenceIds)).toBe(true);
  });
});

describe("TemplateTestGenerator", () => {
  it("emits the exact expired-session template without mutating objective evidence", async () => {
    const objective = deriveTestObjectives(objectiveInput)[0];
    expect(objective).toBeDefined();
    const evidenceBefore = [...objective!.evidenceIds];

    const result = await new TemplateTestGenerator().generate(objective!);

    expect(result).toEqual({
      state: "GENERATED",
      test: {
        path: "test/codeatlas.expired-session.test.ts",
        content: generatedContent,
        objectiveId: objective!.id,
        evidenceIds: evidenceBefore,
        expectedBehavior: { httpStatus: 401, code: "SESSION_EXPIRED" },
        generated: true,
        executed: false,
      },
    });
    expect(objective!.evidenceIds).toEqual(evidenceBefore);
    if (result.state === "GENERATED") {
      expect(result.test.evidenceIds).not.toBe(objective!.evidenceIds);
      expect(Object.isFrozen(result.test)).toBe(true);
      expect(Object.isFrozen(result.test.evidenceIds)).toBe(true);
      expect(Object.isFrozen(result.test.expectedBehavior)).toBe(true);
    }
  });

  it("returns a typed unsupported result instead of inventing another test", async () => {
    const objective: TestObjective = Object.freeze({
      id: "objective:unsupported",
      category: "REGRESSION_TEST",
      targetSymbol: "unrelatedSymbol",
      entryPoint: "otherEntry",
      reason: "An uncovered changed branch needs a regression test.",
      source: Object.freeze({ path: "src/other.ts", startLine: 3, endLine: 3 }),
      evidenceIds: Object.freeze(["ev:other"]),
    });

    await expect(
      new TemplateTestGenerator().generate(objective),
    ).resolves.toEqual({
      state: "UNSUPPORTED_OBJECTIVE",
      objectiveId: "objective:unsupported",
      reason:
        "No deterministic template supports unrelatedSymbol through otherEntry at src/other.ts:3.",
    });
  });

  it("executes the generated test as a base pass and head regression observation", async () => {
    const objective = deriveTestObjectives(objectiveInput)[0];
    expect(objective).toBeDefined();
    const generated = await new TemplateTestGenerator().generate(objective!);
    expect(generated.state).toBe("GENERATED");
    if (generated.state !== "GENERATED") throw new Error(generated.reason);

    const provider = new LocalExecutionProvider({ workspaceRoot });
    const revisions = ["base", "head"] as const;
    const results = await Promise.all(
      revisions.map(async (revision) => {
        const snapshotRoot = resolve(
          workspaceRoot,
          `fixtures/auth-regression/${revision}`,
        );
        return provider.run({
          analysisId: `analysis-generator-${revision}`,
          revision,
          snapshotRoot,
          snapshotSha: await computeSnapshotDigest(snapshotRoot),
          testPaths: [],
          generatedFiles: [generated.test],
          policy: {
            timeoutMs: 10_000,
            maxOutputBytes: 64 * 1024,
            maxFiles: 20,
          },
        });
      }),
    );
    const [base, head] = results;

    expect(base).toEqual(
      expect.objectContaining({
        terminalState: "COMPLETED",
        exitCode: 0,
        testCases: [
          expect.objectContaining({
            name: expect.stringContaining(
              "generated: expired session regression",
            ),
            status: "PASSED",
            generatedObjectiveId: objective!.id,
          }),
        ],
      }),
    );
    expect(head).toEqual(
      expect.objectContaining({
        terminalState: "COMPLETED",
        exitCode: 1,
        testCases: [
          expect.objectContaining({
            name: expect.stringContaining(
              "generated: expired session regression",
            ),
            status: "FAILED",
            generatedObjectiveId: objective!.id,
          }),
        ],
        observations: [
          expect.objectContaining({
            expected: { httpStatus: 401, code: "SESSION_EXPIRED" },
            actual: { httpStatus: 500, code: "INTERNAL_ERROR" },
          }),
        ],
      }),
    );
  }, 20_000);
});
