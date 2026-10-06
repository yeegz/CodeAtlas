import type { TestObjective } from "./derive-objectives.js";

export interface GeneratedTest {
  path: string;
  content: string;
  objectiveId: string;
  evidenceIds: string[];
  expectedBehavior: { httpStatus: 401; code: "SESSION_EXPIRED" };
  generated: true;
  executed: false;
}

export type TestGenerationResult =
  | { state: "GENERATED"; test: GeneratedTest }
  | { state: "UNSUPPORTED_OBJECTIVE"; objectiveId: string; reason: string };

export interface TestGenerator {
  generate(objective: TestObjective): Promise<TestGenerationResult>;
}

const GENERATED_TEST_FIELDS = [
  "content",
  "evidenceIds",
  "executed",
  "expectedBehavior",
  "generated",
  "objectiveId",
  "path",
] as const;

const EXPIRED_SESSION_TEST = `import { describe, expect, it } from "vitest";
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

export class TemplateTestGenerator implements TestGenerator {
  async generate(objective: TestObjective): Promise<TestGenerationResult> {
    if (!supportsExpiredSessionObjective(objective)) {
      return Object.freeze({
        state: "UNSUPPORTED_OBJECTIVE" as const,
        objectiveId: objective.id,
        reason: `No deterministic template supports ${objective.targetSymbol} through ${objective.entryPoint} at ${objective.source.path}:${objective.source.startLine}.`,
      });
    }

    const test = expectedGeneratedTest(objective);

    return Object.freeze({ state: "GENERATED" as const, test });
  }
}

export function validateGeneratedTest(
  objective: TestObjective,
  value: unknown,
): GeneratedTest {
  if (!supportsExpiredSessionObjective(objective)) {
    throw new TypeError("Generated test objective is not supported");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Generated test candidate must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const fields = Object.keys(candidate).sort();
  if (
    fields.length !== GENERATED_TEST_FIELDS.length ||
    fields.some((field, index) => field !== GENERATED_TEST_FIELDS[index])
  ) {
    throw new TypeError("Generated test candidate has unexpected fields");
  }
  const expected = expectedGeneratedTest(objective);
  const evidenceIds = candidate.evidenceIds;
  const behavior = candidate.expectedBehavior;
  if (
    candidate.path !== expected.path ||
    candidate.content !== expected.content ||
    candidate.objectiveId !== expected.objectiveId ||
    candidate.generated !== true ||
    candidate.executed !== false ||
    !Array.isArray(evidenceIds) ||
    evidenceIds.length !== expected.evidenceIds.length ||
    evidenceIds.some(
      (evidenceId, index) => evidenceId !== expected.evidenceIds[index],
    ) ||
    typeof behavior !== "object" ||
    behavior === null ||
    Array.isArray(behavior) ||
    Object.keys(behavior).sort().join("\0") !== "code\0httpStatus" ||
    (behavior as Record<string, unknown>).httpStatus !== 401 ||
    (behavior as Record<string, unknown>).code !== "SESSION_EXPIRED"
  ) {
    throw new TypeError(
      "Generated test candidate does not match the canonical objective template",
    );
  }
  return expected;
}

function expectedGeneratedTest(objective: TestObjective): GeneratedTest {
  const evidenceIds = Object.freeze([...objective.evidenceIds]) as string[];
  const expectedBehavior = Object.freeze({
    httpStatus: 401 as const,
    code: "SESSION_EXPIRED" as const,
  });
  return Object.freeze({
    path: "test/codeatlas.expired-session.test.ts",
    content: EXPIRED_SESSION_TEST,
    objectiveId: objective.id,
    evidenceIds,
    expectedBehavior,
    generated: true as const,
    executed: false as const,
  });
}

function supportsExpiredSessionObjective(objective: TestObjective): boolean {
  return (
    objective.category === "REGRESSION_TEST" &&
    objective.targetSymbol === "validateToken" &&
    objective.entryPoint === "restoreSession" &&
    objective.source.path === "src/auth.ts"
  );
}
