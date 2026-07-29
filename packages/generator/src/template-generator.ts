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

    const evidenceIds = Object.freeze([...objective.evidenceIds]) as string[];
    const expectedBehavior = Object.freeze({
      httpStatus: 401 as const,
      code: "SESSION_EXPIRED" as const,
    });
    const test = Object.freeze({
      path: "test/codeatlas.expired-session.test.ts",
      content: EXPIRED_SESSION_TEST,
      objectiveId: objective.id,
      evidenceIds,
      expectedBehavior,
      generated: true as const,
      executed: false as const,
    });

    return Object.freeze({ state: "GENERATED" as const, test });
  }
}

function supportsExpiredSessionObjective(objective: TestObjective): boolean {
  return (
    objective.category === "REGRESSION_TEST" &&
    objective.targetSymbol === "validateToken" &&
    objective.entryPoint === "restoreSession" &&
    objective.source.path === "src/auth.ts"
  );
}
