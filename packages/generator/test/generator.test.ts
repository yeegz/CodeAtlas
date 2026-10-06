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
import * as GeneratorModule from "../src/index.js";

/**
 * Cases below spawn real Vitest processes in an isolated snapshot, several per
 * execution. That cost is dominated by child process startup against the
 * workspace dependency tree, so the budget bounds behaviour, not performance,
 * and must not be read as a latency assertion.
 */
const EXECUTION_BUDGET_MS = 120_000;

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const snapshotSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
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
      baseLocation: {
        snapshotSha,
        path: "src/auth.ts",
        startLine: 14,
        endLine: 18,
      },
      headLocation: {
        snapshotSha,
        path: "src/auth.ts",
        startLine: 14,
        endLine: 19,
      },
      changedLines: [17, 18, 19],
      signatureChanged: false,
    },
  ],
  branches: [
    {
      id: "branch:expiration",
      kind: "if",
      source: {
        snapshotSha,
        path: "src/auth.ts",
        startLine: 17,
        endLine: 17,
      },
      evidenceIds: ["ev:branch"],
    },
  ],
  coverage: [{ path: "src/auth.ts", coveredLines: [18, 22, 27] }],
  publicEntryPoints: [
    {
      id: "contract:restoreSession",
      symbolId: "symbol:restoreSession",
      name: "restoreSession",
      signature: "restoreSession(token: Token, now: number): SessionResponse",
      signatureDigest: "digest:restoreSession",
      source: {
        snapshotSha,
        path: "src/auth.ts",
        startLine: 21,
        endLine: 29,
      },
      evidenceIds: ["ev:entry-point"],
    },
  ],
  selectedTests: [
    {
      testId: "test:auth",
      path: "test/auth.test.ts",
      reasons: ["Reaches validateToken."],
      evidenceIds: ["ev:selected-test"],
    },
  ],
};

describe("deriveTestObjectives", () => {
  it("targets the uncovered changed expiration branch", () => {
    const objectives = deriveTestObjectives(objectiveInput);
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
      source: Object.freeze({
        snapshotSha,
        path: "src/other.ts",
        startLine: 3,
        endLine: 3,
      }),
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

  it.each([
    {
      name: "alternate safe path",
      mutate(test: Record<string, unknown>) {
        test.path = "test/alternate.test.ts";
      },
    },
    {
      name: "changed source",
      mutate(test: Record<string, unknown>) {
        test.content = `${String(test.content)}\n// changed`;
      },
    },
    {
      name: "reordered evidence",
      mutate(test: Record<string, unknown>) {
        test.evidenceIds = [...(test.evidenceIds as string[])].reverse();
      },
    },
    {
      name: "changed expected behavior",
      mutate(test: Record<string, unknown>) {
        test.expectedBehavior = { httpStatus: 200, code: "OK" };
      },
    },
    {
      name: "wrong generated flag",
      mutate(test: Record<string, unknown>) {
        test.generated = false;
      },
    },
    {
      name: "wrong executed flag",
      mutate(test: Record<string, unknown>) {
        test.executed = true;
      },
    },
    {
      name: "wrong objective id",
      mutate(test: Record<string, unknown>) {
        test.objectiveId = "objective:other";
      },
    },
    {
      name: "extra runtime field",
      mutate(test: Record<string, unknown>) {
        test.certified = true;
      },
    },
  ])("rejects generated output with $name", async ({ mutate }) => {
    const objective = deriveTestObjectives(objectiveInput)[0]!;
    const result = await new TemplateTestGenerator().generate(objective);
    if (result.state !== "GENERATED") throw new Error(result.reason);
    const candidate = structuredClone(result.test) as unknown as Record<
      string,
      unknown
    >;
    mutate(candidate);

    expect("validateGeneratedTest" in GeneratorModule).toBe(true);
    const validateGeneratedTest = (
      GeneratorModule as unknown as {
        validateGeneratedTest(
          objective: TestObjective,
          value: unknown,
        ): unknown;
      }
    ).validateGeneratedTest;
    expect(() => validateGeneratedTest(objective, candidate)).toThrow();
  });

  it(
    "executes the generated test as a base pass and head regression observation",
    async () => {
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
    },
    EXECUTION_BUDGET_MS,
  );
});
