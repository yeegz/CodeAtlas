import { describe, expect, it } from "vitest";

import {
  computeExecutionResultDigest,
  hasValidExecutionResultBinding,
  type BoundExecutionResult,
} from "../src/index.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

describe("execution result digest", () => {
  it("binds genuine plain execution results", () => {
    const bound = executionResult();
    const result = {
      ...bound,
      resultDigest: computeExecutionResultDigest(bound),
    };

    expect(hasValidExecutionResultBinding(result)).toBe(true);
  });

  it("does not let a top-level toJSON hide a changed snapshot", () => {
    const original = executionResult();
    const originalDigest = computeExecutionResultDigest(original);
    const tampered = {
      ...original,
      snapshotSha: headSha,
      toJSON: () => original,
    };

    expect(
      computeExecutionResultDigest(tampered as unknown as BoundExecutionResult),
    ).not.toBe(originalDigest);
    expect(
      hasValidExecutionResultBinding({
        ...tampered,
        resultDigest: originalDigest,
      }),
    ).toBe(false);
  });

  it.each([
    {
      nestedField: "testCases",
      tamper(original: BoundExecutionResult): BoundExecutionResult {
        const originalCase = original.testCases[0]!;
        return {
          ...original,
          testCases: [
            {
              ...originalCase,
              generatedObjectiveId: "objective:unrelated",
              toJSON: () => originalCase,
            },
          ],
        };
      },
    },
    {
      nestedField: "coverage",
      tamper(original: BoundExecutionResult): BoundExecutionResult {
        const originalCoverage = original.coverage[0]!;
        return {
          ...original,
          coverage: [
            {
              ...originalCoverage,
              path: "src/unrelated.ts",
              toJSON: () => originalCoverage,
            },
          ],
        };
      },
    },
    {
      nestedField: "observations",
      tamper(original: BoundExecutionResult): BoundExecutionResult {
        const originalObservation = original.observations[0]!;
        return {
          ...original,
          observations: [
            {
              ...originalObservation,
              path: "test/unrelated.test.ts",
              toJSON: () => originalObservation,
            },
          ],
        };
      },
    },
  ])(
    "does not let nested $nestedField toJSON hide changed security fields",
    ({ tamper }) => {
      const original = executionResult();
      const originalDigest = computeExecutionResultDigest(original);
      const tampered = tamper(original);

      expect(computeExecutionResultDigest(tampered)).not.toBe(originalDigest);
      expect(
        hasValidExecutionResultBinding({
          ...tampered,
          resultDigest: originalDigest,
        }),
      ).toBe(false);
    },
  );
});

function executionResult(): BoundExecutionResult {
  return {
    coverage: [{ coveredLines: [17, 18], path: "src/auth.ts" }],
    durationMs: 10,
    environmentDigest: "environment-digest",
    executionId: "00000000-0000-4000-8000-000000000001",
    exitCode: 1,
    observations: [
      {
        actual: { code: "INTERNAL_ERROR", httpStatus: 500 },
        expected: { code: "SESSION_EXPIRED", httpStatus: 401 },
        generatedObjectiveId: "objective:expired-session",
        path: "test/codeatlas.expired-session.test.ts",
        source: "TEST_ASSERTION",
        testName: "generated: expired session regression",
      },
    ],
    revision: "base",
    snapshotSha: baseSha,
    stderr: "",
    stdout: "",
    terminalState: "COMPLETED",
    testCases: [
      {
        failureMessage: "assertion failed",
        generatedObjectiveId: "objective:expired-session",
        name: "generated: expired session regression",
        path: "test/codeatlas.expired-session.test.ts",
        status: "FAILED",
      },
    ],
  };
}
