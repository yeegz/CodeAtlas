import { describe, expect, it } from "vitest";

import {
  computeExecutionResultDigest,
  hasValidExecutionResultBinding,
  type BoundExecutionResult,
} from "../src/index.js";
import * as RunnerModule from "../src/index.js";

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

  it.each([
    {
      name: "unknown top-level field",
      mutate(value: Record<string, unknown>) {
        value.untrusted = true;
      },
    },
    {
      name: "unknown test-case field",
      mutate(value: Record<string, unknown>) {
        (value.testCases as Record<string, unknown>[])[0]!.untrusted = true;
      },
    },
    {
      name: "unknown coverage field",
      mutate(value: Record<string, unknown>) {
        (value.coverage as Record<string, unknown>[])[0]!.untrusted = true;
      },
    },
    {
      name: "unknown observation field",
      mutate(value: Record<string, unknown>) {
        (value.observations as Record<string, unknown>[])[0]!.untrusted = true;
      },
    },
    {
      name: "unknown behavior field",
      mutate(value: Record<string, unknown>) {
        const observation = (
          value.observations as Record<string, unknown>[]
        )[0]!;
        (observation.actual as Record<string, unknown>).untrusted = true;
      },
    },
    {
      name: "traversal test path",
      mutate(value: Record<string, unknown>) {
        (value.testCases as Record<string, unknown>[])[0]!.path =
          "../escape.test.ts";
      },
    },
    {
      name: "absolute coverage path",
      mutate(value: Record<string, unknown>) {
        (value.coverage as Record<string, unknown>[])[0]!.path = "/tmp/auth.ts";
      },
    },
    {
      name: "non-integer covered line",
      mutate(value: Record<string, unknown>) {
        (value.coverage as Record<string, unknown>[])[0]!.coveredLines = ["17"];
      },
    },
    {
      name: "malformed execution id",
      mutate(value: Record<string, unknown>) {
        value.executionId = "execution-1";
      },
    },
    {
      name: "malformed digest",
      mutate(value: Record<string, unknown>) {
        value.resultDigest = "sha256:invalid";
      },
    },
  ])("strictly rejects $name", ({ mutate }) => {
    const bound = executionResult();
    const candidate = structuredClone({
      ...bound,
      resultDigest: computeExecutionResultDigest(bound),
    }) as unknown as Record<string, unknown>;
    mutate(candidate);

    expect("ExecutionResultSchema" in RunnerModule).toBe(true);
    const schema = (
      RunnerModule as unknown as {
        ExecutionResultSchema: {
          safeParse(value: unknown): { success: boolean };
        };
      }
    ).ExecutionResultSchema;
    expect(schema.safeParse(candidate).success).toBe(false);
    expect(hasValidExecutionResultBinding(candidate)).toBe(false);
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
