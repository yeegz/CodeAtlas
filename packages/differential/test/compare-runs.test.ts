import { describe, expect, it } from "vitest";

import type { ChangedSymbol } from "@codeatlas/analyzer";
import {
  FindingSchema,
  type EvidenceItem,
  type Finding,
} from "@codeatlas/evidence";
import type { GeneratedTest, TestObjective } from "@codeatlas/generator";
import {
  computeExecutionResultDigest,
  type ExecutionResult,
} from "@codeatlas/runner";
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

    const spread = { ...sharedFinding };
    const cloned = structuredClone(sharedFinding);
    const serialized = JSON.parse(JSON.stringify(sharedFinding));

    for (const value of [spread, cloned, serialized]) {
      expect(value).toEqual(
        expect.objectContaining({
          graphPath: "restoreSession → validateToken",
          confidence: {
            level: "HIGH",
            factors: expect.arrayContaining(["REPEATABLE_3_OF_3"]),
          },
        }),
      );
      expect(FindingSchema.parse(value)).toEqual(value);
    }
  });

  it.each([
    {
      name: "the same pair object",
      mutate(input: MutableComparison) {
        input.comparisons[1] = input.comparisons[0]!;
      },
      counts: { base: 2, head: 2 },
    },
    {
      name: "a repeated execution id",
      mutate(input: MutableComparison) {
        input.comparisons[1]!.base.executionId =
          input.comparisons[0]!.base.executionId;
      },
      counts: { base: 2, head: 3 },
    },
    {
      name: "a repeated result digest",
      mutate(input: MutableComparison) {
        input.comparisons[1]!.head.resultDigest =
          input.comparisons[0]!.head.resultDigest;
      },
      counts: { base: 3, head: 2 },
    },
  ])("rejects repeat inflation from $name", ({ mutate, counts }) => {
    const input = structuredClone(comparison()) as MutableComparison;
    mutate(input);

    const [finding] = compareRuns(input);

    expect(finding?.state).toBe("UNVERIFIED");
    expect(finding?.proofCard.limitations).toContain(
      "Each repeat must contain unique run-bound execution identities and result digests.",
    );
    expect(
      finding?.evidence.find(({ id }) => id === "ev:differential")?.executions,
    ).toEqual(counts);
  });

  it("rejects a result whose digest no longer binds its content", () => {
    const input = structuredClone(comparison()) as MutableComparison;
    input.comparisons[0]!.head.stderr = "mutated after execution";

    const [finding] = compareRuns(input);

    expect(finding?.state).toBe("UNVERIFIED");
    expect(finding?.proofCard.limitations).toContain(
      "An execution result digest does not match its run-bound result.",
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
    rebind(input);

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
    rebind(input);

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
    rebind(input);

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
          path: generatedPath,
          generatedObjectiveId: objectiveId,
          source: "TEST_ASSERTION",
          expected: { httpStatus: 401, code: "SESSION_EXPIRED" },
          actual: { httpStatus: 403, code: "SESSION_REJECTED" },
        },
      ];
    }
    rebind(input);

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

  it("leaves an existing selected test unverified without an upstream structured observation", () => {
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
    rebind(input);

    const [finding] = compareRuns(input);

    expect(finding?.state).toBe("UNVERIFIED");
    expect(finding?.proofCard.limitations).toContain(
      "Existing selected tests do not provide a trusted structured behavioral observation.",
    );
  });

  it.each([
    {
      name: "path",
      mutate(observation: MutableObservation) {
        observation.path = "test/unrelated.test.ts";
      },
    },
    {
      name: "objective",
      mutate(observation: MutableObservation) {
        observation.generatedObjectiveId = "objective:unrelated";
      },
    },
  ])(
    "does not match a same-named observation with another $name",
    ({ mutate }) => {
      const input = structuredClone(comparison()) as MutableComparison;
      for (const pair of input.comparisons) {
        mutate(pair.head.observations[0]!);
      }
      rebind(input);

      const [finding] = compareRuns(input);

      expect(finding?.state).toBe("UNVERIFIED");
      expect(finding?.proofCard.limitations).toContain(
        "The head failure did not contain a validated structured behavioral observation.",
      );
    },
  );

  it("merges identical evidence ids without inflating finding evidence", () => {
    const input = structuredClone(comparison()) as MutableComparison;
    input.evidenceItems.push(structuredClone(input.evidenceItems[0]!));

    const [finding] = compareRuns(input);

    expect(finding?.state).toBe("CONFIRMED_REGRESSION");
    expect(finding?.evidence.map(({ id }) => id)).toEqual([
      "ev:branch",
      "ev:call",
      "ev:contract",
      "ev:differential",
    ]);
    expect(FindingSchema.safeParse(finding).success).toBe(true);
  });

  it.each(["PARTIALLY_REPRODUCIBLE", "NOT_REPRODUCIBLE"] as const)(
    "does not confirm %s differential evidence",
    (reproducibility) => {
      const input = structuredClone(comparison()) as MutableComparison;
      input.evidenceItems.find(
        ({ id }) => id === "ev:differential",
      )!.reproducibility = reproducibility;

      const [finding] = compareRuns(input);

      expect(finding?.state).toBe("UNVERIFIED");
      expect(finding?.proofCard.limitations).toContain(
        "Differential execution evidence is not reproducible.",
      );
      expect(FindingSchema.safeParse(finding).success).toBe(true);
    },
  );

  it("fails closed on conflicting duplicate evidence ids", () => {
    const input = structuredClone(comparison()) as MutableComparison;
    input.evidenceItems.push({
      ...structuredClone(input.evidenceItems.at(-1)!),
      reproducibility: "NOT_REPRODUCIBLE",
    });

    const [finding] = compareRuns(input);

    expect(finding?.state).toBe("UNVERIFIED");
    expect(finding?.proofCard.limitations).toContain(
      "Conflicting evidence records share an identifier.",
    );
    expect(FindingSchema.safeParse(finding).success).toBe(true);
  });

  it.each([
    {
      name: "missing evidence",
      mutate(input: Record<string, unknown>) {
        delete input.evidenceItems;
      },
    },
    {
      name: "entirely malformed evidence",
      mutate(input: Record<string, unknown>) {
        input.evidenceItems = [null, {}, "not-evidence"];
      },
    },
  ])("returns a frozen unverified finding for $name", ({ mutate }) => {
    const input = structuredClone(comparison()) as unknown as Record<
      string,
      unknown
    >;
    mutate(input);

    const findings = compareRuns(input as unknown as ComparisonInput);
    const [finding] = findings;

    expect(findings).toHaveLength(1);
    expect(finding?.state).toBe("UNVERIFIED");
    expect(finding?.proofCard.evidenceIds).toEqual([]);
    expect(finding?.evidence).toEqual([]);
    expect(finding?.proofCard.limitations).toContain(
      "No usable evidence items were provided for this finding.",
    );
    expect(FindingSchema.safeParse(finding).success).toBe(true);
    expect(Object.isFrozen(findings)).toBe(true);
    expect(Object.isFrozen(finding)).toBe(true);
  });

  it("explains identical repeated base and head failures", () => {
    const input = structuredClone(comparison()) as MutableComparison;
    for (const pair of input.comparisons) {
      pair.base.testCases[0]!.status = "FAILED";
      pair.base.exitCode = 1;
      pair.base.observations = structuredClone(pair.head.observations);
    }
    rebind(input);

    const [finding] = compareRuns(input);

    expect(finding?.state).toBe("UNVERIFIED");
    expect(finding?.proofCard.limitations).toContain(
      "Base and head failed with the same observed behavior, so no differential change was established.",
    );
  });

  it.each([
    {
      name: "a non-array comparison collection",
      mutate(input: Record<string, unknown>) {
        input.comparisons = null;
      },
    },
    {
      name: "a malformed execution pair",
      mutate(input: Record<string, unknown>) {
        input.comparisons = [{ base: null, head: 42 }];
      },
    },
    {
      name: "a malformed graph path",
      mutate(input: Record<string, unknown>) {
        input.graphPath = [null];
      },
    },
    {
      name: "a malformed evidence member",
      mutate(input: Record<string, unknown>) {
        input.evidenceItems = [null, ...(input.evidenceItems as unknown[])];
      },
    },
    {
      name: "a malformed nested test case",
      mutate(input: Record<string, unknown>) {
        const pair = (
          input.comparisons as Array<{
            base: Record<string, unknown>;
          }>
        )[0]!;
        pair.base.testCases = [null];
      },
    },
  ])("returns a frozen unverified finding for $name", ({ mutate }) => {
    const input = structuredClone(comparison()) as unknown as Record<
      string,
      unknown
    >;
    mutate(input);

    expect(() =>
      compareRuns(input as unknown as ComparisonInput),
    ).not.toThrow();
    const findings = compareRuns(input as unknown as ComparisonInput);

    expect(findings[0]?.state).toBe("UNVERIFIED");
    expect(findings[0]?.proofCard.limitations.length).toBeGreaterThan(0);
    expect(Object.isFrozen(findings)).toBe(true);
    expect(Object.isFrozen(findings[0])).toBe(true);
  });

  it.each([null, {}, { findingId: "" }, { findingId: 42 }])(
    "returns a frozen empty result when no finding identity exists for %j",
    (input) => {
      const findings = compareRuns(input as unknown as ComparisonInput);
      expect(findings).toEqual([]);
      expect(Object.isFrozen(findings)).toBe(true);
    },
  );

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
    comparisons: [0, 1, 2].map((repeat) => ({
      base: execution("base", "PASSED", repeat),
      head: execution("head", "FAILED", repeat),
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
  repeat: number,
): ExecutionResult {
  const result = {
    executionId: executionId(revision, repeat),
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
              path: generatedPath,
              generatedObjectiveId: objectiveId,
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
  return {
    ...result,
    resultDigest: computeExecutionResultDigest(result),
  };
}

function executionId(revision: "base" | "head", repeat: number): string {
  const variant = revision === "base" ? "8" : "9";
  return `00000000-0000-4000-${variant}000-${String(repeat + 1).padStart(12, "0")}`;
}

function rebind(input: MutableComparison): void {
  for (const pair of input.comparisons) {
    for (const result of [pair.base, pair.head]) {
      const { resultDigest: _resultDigest, ...boundResult } = result;
      void _resultDigest;
      result.resultDigest = computeExecutionResultDigest(boundResult);
    }
  }
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

type MutableObservation = Mutable<
  ExecutionResult["observations"][number] & {
    path: string;
    generatedObjectiveId: string | null;
  }
>;
