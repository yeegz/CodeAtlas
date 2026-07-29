import { describe, expect, it } from "vitest";

import type { ChangedSymbol } from "@codeatlas/analyzer";
import {
  FindingSchema,
  type EvidenceItem,
  type Finding,
} from "@codeatlas/evidence";
import type { GeneratedTest, TestObjective } from "@codeatlas/generator";
import type { ExecutionResult } from "@codeatlas/runner";
import type { SelectionEdge } from "@codeatlas/selector";

import { compareRuns, type ComparisonInput } from "../src/index.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const objectiveId =
  "objective:regression-test:symbol%3AvalidateToken:branch%3Aexpiration:if:17:restoreSession";
const generatedPath = "test/codeatlas.expired-session.test.ts";
const generatedName =
  "generated: expired session regression returns SESSION_EXPIRED for a non-refreshable expired token";

describe("compareRuns", () => {
  it("confirms the repeatable 401 to 500 regression from current bound evidence", () => {
    const findings = compareRuns(comparison());

    expect(findings).toEqual([
      expect.objectContaining({
        id: "finding_expired_session",
        state: "CONFIRMED_REGRESSION",
        title: "Expired sessions return an internal error",
        graphPath: "restoreSession → validateToken",
        confidence: {
          level: "HIGH",
          factors: [
            "DIFFERENTIAL_EXECUTION",
            "EXACT_TEST_IDENTITY",
            "EXACT_SYMBOL_PATH",
            "MATCHING_ENVIRONMENT",
            "CURRENT_EVIDENCE",
            "REPEATABLE_3_OF_3",
          ],
        },
        proofCard: {
          baseBehavior: "HTTP 401 with SESSION_EXPIRED",
          headBehavior: "HTTP 500 with INTERNAL_ERROR",
          evidenceIds: [
            "ev:branch",
            "ev:call",
            "ev:contract",
            "ev:differential",
          ],
          affectedJourney:
            "Returning user → Restore session → Validate expired token",
          reproductionCommand: "codeatlas replay finding_expired_session",
          recommendedAction:
            "Restore the unconditional expiration guard or accept the changed behavior with a contract update",
          limitations: [],
        },
      }),
    ]);
  });

  it("remains assignable to and runtime-valid as the shared evidence finding", () => {
    const finding = compareRuns(comparison())[0];
    expect(finding).toBeDefined();
    const sharedFinding: Finding = finding!;

    expect(FindingSchema.parse(sharedFinding)).toEqual(
      expect.objectContaining({
        id: "finding_expired_session",
        state: "CONFIRMED_REGRESSION",
        proofCard: expect.objectContaining({
          reproductionCommand: "codeatlas replay finding_expired_session",
        }),
      }),
    );
  });

  it.each([
    {
      name: "environment mismatch",
      mutate(input: MutableComparison) {
        input.comparisons[0]!.head.environmentDigest = "other-environment";
      },
      limitation: "Base and head environment digests do not match.",
    },
    {
      name: "head timeout",
      mutate(input: MutableComparison) {
        input.comparisons[1]!.head.terminalState = "TIMED_OUT";
        input.comparisons[1]!.head.exitCode = null;
      },
      limitation: "Base and head did not both complete.",
    },
    {
      name: "one contradictory repeat",
      mutate(input: MutableComparison) {
        input.comparisons[2]!.head.observations[0]!.actual = {
          httpStatus: 503,
          code: "SERVICE_UNAVAILABLE",
        };
      },
      limitation:
        "Differential observations were contradictory across repeats.",
    },
    {
      name: "unexecuted generated test",
      mutate(input: MutableComparison) {
        input.comparisons[0]!.head.testCases[0]!.status = "SKIPPED";
      },
      limitation:
        "The exact generated test was not executed on both revisions.",
    },
  ])("keeps $name unverified", ({ mutate, limitation }) => {
    const input = structuredClone(comparison()) as MutableComparison;
    mutate(input);

    const [finding] = compareRuns(input);

    expect(finding?.state).toBe("UNVERIFIED");
    expect(finding?.proofCard.limitations).toContain(limitation);
    expect(finding?.state).not.toBe("CONFIRMED_REGRESSION");
  });

  it("does not confirm stale or malformed evidence from caller claims", () => {
    const stale = structuredClone(comparison()) as MutableComparison;
    stale.evidenceItems[0]!.source!.snapshotSha = "c".repeat(40);
    stale.evidenceItems[1]!.artifactDigest = "not-a-digest";

    const [finding] = compareRuns(stale);

    expect(finding?.state).toBe("UNVERIFIED");
    expect(finding?.proofCard.limitations).toEqual(
      expect.arrayContaining([
        "Cited evidence is not bound to a current comparison snapshot.",
        "Cited evidence has a malformed artifact digest.",
      ]),
    );
  });

  it("fails closed when a run is bound to the wrong revision snapshot", () => {
    const input = structuredClone(comparison()) as MutableComparison;
    input.comparisons[0]!.base.snapshotSha = headSha;

    const [finding] = compareRuns(input);

    expect(finding?.state).toBe("UNVERIFIED");
    expect(finding?.proofCard.limitations).toContain(
      "Execution results are not bound to one consistent base/head snapshot pair.",
    );
  });

  it("reports probable impact when the exact changed path has no behavioral difference", () => {
    const input = structuredClone(comparison()) as MutableComparison;
    for (const pair of input.comparisons) {
      pair.head.testCases[0]!.status = "PASSED";
      pair.head.exitCode = 0;
      pair.head.observations = [];
    }

    const [finding] = compareRuns(input);

    expect(finding?.state).toBe("PROBABLE_IMPACT");
    expect(finding?.proofCard.limitations).toContain(
      "No validated structured behavioral difference was observed on head.",
    );
  });

  it("reports a confirmed change when both revisions repeat different observed behavior", () => {
    const input = structuredClone(comparison()) as MutableComparison;
    for (const pair of input.comparisons) {
      pair.base.testCases[0]!.status = "FAILED";
      pair.base.exitCode = 1;
      pair.base.observations = [
        {
          testName: generatedName,
          source: "TEST_ASSERTION",
          expected: { httpStatus: 401, code: "SESSION_EXPIRED" },
          actual: { httpStatus: 403, code: "SESSION_REJECTED" },
        },
      ];
    }

    const [finding] = compareRuns(input);

    expect(finding?.state).toBe("CONFIRMED_CHANGE");
    expect(finding?.proofCard.baseBehavior).toBe(
      "HTTP 403 with SESSION_REJECTED",
    );
    expect(finding?.proofCard.headBehavior).toBe(
      "HTTP 500 with INTERNAL_ERROR",
    );
    expect(finding?.proofCard.limitations).toContain(
      "The base assertion did not pass, so this is a confirmed change rather than a confirmed regression.",
    );
  });

  it("confirms an exact existing selected test from its structured expected behavior", () => {
    const input = structuredClone(comparison()) as MutableComparison;
    input.test = {
      provenance: "EXISTING",
      selection: {
        testId: "test:auth",
        path: generatedPath,
        reasons: ["Reaches validateToken."],
        evidenceIds: ["ev:contract"],
      },
    };
    for (const pair of input.comparisons) {
      pair.base.testCases[0]!.generatedObjectiveId = null;
      pair.head.testCases[0]!.generatedObjectiveId = null;
    }

    const [finding] = compareRuns(input);

    expect(finding?.state).toBe("CONFIRMED_REGRESSION");
    expect(finding?.proofCard.baseBehavior).toBe(
      "HTTP 401 with SESSION_EXPIRED",
    );
  });

  it("is deterministic and does not mutate frozen upstream records", () => {
    const input = comparison();
    const before = structuredClone(input);
    deepFreeze(input);

    const first = compareRuns(input);
    const second = compareRuns(input);

    expect(first).toEqual(second);
    expect(input).toEqual(before);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0]?.proofCard)).toBe(true);
    expect(Object.isFrozen(first[0]?.confidence.factors)).toBe(true);
  });
});

function comparison(): ComparisonInput {
  const objective: TestObjective = {
    id: objectiveId,
    category: "REGRESSION_TEST",
    targetSymbol: "validateToken",
    entryPoint: "restoreSession",
    reason:
      "Changed expiration branch at src/auth.ts:17 has no mapped runtime coverage.",
    source: location(headSha, 17),
    evidenceIds: ["ev:branch", "ev:contract"],
  };
  const generatedTest: GeneratedTest = {
    path: generatedPath,
    content: "generated test source",
    objectiveId,
    evidenceIds: ["ev:branch", "ev:contract"],
    expectedBehavior: { httpStatus: 401, code: "SESSION_EXPIRED" },
    generated: true,
    executed: false,
  };
  const changedSymbols: ChangedSymbol[] = [
    {
      id: "symbol:validateToken",
      name: "validateToken",
      path: "src/auth.ts",
      baseLocation: location(baseSha, 14, 18),
      headLocation: location(headSha, 14, 19),
      changedLines: [17, 18, 19],
      signatureChanged: false,
    },
  ];
  const graphPath: SelectionEdge[] = [
    {
      from: "symbol:restoreSession",
      to: "symbol:validateToken",
      relation: "CALLS",
      evidenceType: "STATIC_CALLGRAPH",
      evidenceIds: ["ev:call"],
      fromName: "restoreSession",
      toName: "validateToken",
    },
  ];
  const evidenceItems: EvidenceItem[] = [
    evidence("ev:branch", "STATIC_AST", headSha, "1"),
    evidence("ev:call", "STATIC_CALLGRAPH", headSha, "2"),
    evidence("ev:contract", "CONTRACT_TEST", headSha, "3"),
    evidence("ev:differential", "DIFFERENTIAL_EXECUTION", headSha, "4"),
  ];

  return {
    findingId: "finding_expired_session",
    comparisons: [0, 1, 2].map(() => ({
      base: execution("base", "PASSED"),
      head: execution("head", "FAILED"),
    })),
    test: { provenance: "GENERATED", generatedTest, objective },
    changedSymbols,
    graphPath,
    evidenceItems,
  };
}

function execution(
  revision: "base" | "head",
  status: "PASSED" | "FAILED",
): ExecutionResult {
  return {
    revision,
    snapshotSha: revision === "base" ? baseSha : headSha,
    terminalState: "COMPLETED",
    exitCode: status === "PASSED" ? 0 : 1,
    durationMs: 10,
    testCases: [
      {
        name: generatedName,
        path: generatedPath,
        status,
        failureMessage: status === "FAILED" ? "assertion failed" : null,
        generatedObjectiveId: objectiveId,
      },
    ],
    coverage: [{ path: "src/auth.ts", coveredLines: [17, 22] }],
    observations:
      status === "FAILED"
        ? [
            {
              testName: generatedName,
              source: "TEST_ASSERTION",
              expected: { httpStatus: 401, code: "SESSION_EXPIRED" },
              actual: { httpStatus: 500, code: "INTERNAL_ERROR" },
            },
          ]
        : [],
    stdout: "",
    stderr: "",
    environmentDigest: "environment-digest",
  };
}

function evidence(
  id: string,
  type: EvidenceItem["type"],
  snapshotSha: string,
  digestCharacter: string,
): EvidenceItem {
  return {
    id,
    type,
    origin: "fixture@0.1.0",
    observedAt: "2026-07-29T00:00:00.000Z",
    reproducibility: "REPRODUCIBLE",
    source: location(snapshotSha, 17),
    artifactDigest: `sha256:${digestCharacter.repeat(64)}`,
  };
}

function location(snapshotSha: string, startLine: number, endLine = startLine) {
  return { snapshotSha, path: "src/auth.ts", startLine, endLine };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

type MutableComparison = {
  -readonly [
    Key in keyof ComparisonInput
  ]: ComparisonInput[Key] extends readonly (infer Item)[]
    ? Array<Mutable<Item>>
    : Mutable<ComparisonInput[Key]>;
};

type Mutable<Value> = Value extends object
  ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
  : Value;
