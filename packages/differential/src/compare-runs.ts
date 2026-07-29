import type { ChangedSymbol } from "@codeatlas/analyzer";
import {
  EvidenceItemSchema,
  type EvidenceItem,
  type Finding,
  type FindingEvidence,
  type FindingState,
} from "@codeatlas/evidence";
import type { GeneratedTest, TestObjective } from "@codeatlas/generator";
import type { ExecutionResult } from "@codeatlas/runner";
import type { SelectionEdge, TestSelection } from "@codeatlas/selector";

export interface ExecutionComparison {
  readonly base: ExecutionResult;
  readonly head: ExecutionResult;
}

export type ComparedTest =
  | {
      readonly provenance: "GENERATED";
      readonly generatedTest: GeneratedTest;
      readonly objective: TestObjective;
    }
  | {
      readonly provenance: "EXISTING";
      readonly selection: TestSelection;
    };

export interface ComparisonInput {
  readonly findingId: string;
  readonly comparisons: readonly ExecutionComparison[];
  readonly test: ComparedTest;
  readonly changedSymbols: readonly ChangedSymbol[];
  readonly graphPath: readonly SelectionEdge[];
  readonly evidenceItems: readonly EvidenceItem[];
}

export interface ComparisonConfidence {
  readonly level: "HIGH" | "MEDIUM" | "LOW";
  readonly factors: readonly string[];
}

export interface ComparisonFinding extends Finding {
  readonly graphPath: string;
  readonly confidence: ComparisonConfidence;
}

interface TestIdentity {
  path: string;
  objectiveId: string | null;
  expected: Behavior | null;
  evidenceIds: string[];
  targetName: string;
  entryPointName: string;
  valid: boolean;
}

interface Behavior {
  httpStatus: number;
  code: string;
}

interface PairOutcome {
  baseStatus: "PASSED" | "FAILED" | "SKIPPED" | null;
  headStatus: "PASSED" | "FAILED" | "SKIPPED" | null;
  baseObserved: Behavior | null;
  headObserved: Behavior | null;
}

const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export function compareRuns(input: ComparisonInput): ComparisonFinding[] {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.findingId !== "string" ||
    input.findingId.length === 0
  ) {
    return Object.freeze([]) as unknown as ComparisonFinding[];
  }

  const limitations: string[] = [];
  const identity = identifyTest(input.test);
  if (!identity.valid) {
    addLimitation(
      limitations,
      "The compared test identity does not match its objective.",
    );
  }

  const revisions = expectedRevisions(
    input.changedSymbols,
    identity.targetName,
  );
  const path = resolveGraphPath(
    input.graphPath,
    identity.entryPointName,
    identity.targetName,
  );
  const exactPath =
    revisions !== null &&
    path !== null &&
    path.targetId === revisions.target.id &&
    objectiveMatchesChange(input.test, revisions.target);
  if (!exactPath) {
    addLimitation(
      limitations,
      "The graph path does not resolve the exact changed symbol and objective.",
    );
  }

  const comparisons = Array.isArray(input.comparisons) ? input.comparisons : [];
  if (comparisons.length < 2) {
    addLimitation(
      limitations,
      "Fewer than two base/head comparisons were available.",
    );
  }

  const snapshotsConsistent =
    revisions !== null &&
    comparisons.length > 0 &&
    comparisons.every(
      ({ base, head }) =>
        base?.revision === "base" &&
        head?.revision === "head" &&
        base.snapshotSha === revisions.baseSha &&
        head.snapshotSha === revisions.headSha,
    );
  if (!snapshotsConsistent) {
    addLimitation(
      limitations,
      "Execution results are not bound to one consistent base/head snapshot pair.",
    );
  }

  const completed =
    comparisons.length > 0 &&
    comparisons.every(
      ({ base, head }) =>
        base?.terminalState === "COMPLETED" &&
        head?.terminalState === "COMPLETED",
    );
  if (!completed) {
    addLimitation(limitations, "Base and head did not both complete.");
  }

  const environmentDigests = comparisons.flatMap(({ base, head }) => [
    base?.environmentDigest,
    head?.environmentDigest,
  ]);
  const environmentsMatch =
    environmentDigests.length > 0 &&
    environmentDigests.every(
      (digest) =>
        typeof digest === "string" &&
        digest.length > 0 &&
        digest === environmentDigests[0],
    );
  if (!environmentsMatch) {
    addLimitation(
      limitations,
      "Base and head environment digests do not match.",
    );
  }

  const observedExpected =
    identity.expected ?? expectedFromObservations(comparisons, identity);
  const evaluatedIdentity: TestIdentity = {
    ...identity,
    expected: observedExpected,
  };
  const pairOutcomes = comparisons.map((comparison) =>
    outcomeForPair(comparison, evaluatedIdentity),
  );
  const exactTestExecuted =
    pairOutcomes.length > 0 &&
    pairOutcomes.every(
      ({ baseStatus, headStatus }) =>
        baseStatus !== null &&
        headStatus !== null &&
        baseStatus !== "SKIPPED" &&
        headStatus !== "SKIPPED",
    );
  if (!exactTestExecuted) {
    addLimitation(
      limitations,
      input.test.provenance === "GENERATED"
        ? "The exact generated test was not executed on both revisions."
        : "The exact existing test was not executed on both revisions.",
    );
  }

  const evidence = assessEvidence(
    input.evidenceItems,
    revisions,
    identity,
    path,
  );
  for (const limitation of evidence.limitations) {
    addLimitation(limitations, limitation);
  }

  const baseStatuses = pairOutcomes.map(({ baseStatus }) => baseStatus);
  const headStatuses = pairOutcomes.map(({ headStatus }) => headStatus);
  const basePassed =
    baseStatuses.length > 0 &&
    baseStatuses.every((status) => status === "PASSED");
  const baseFailed =
    baseStatuses.length > 0 &&
    baseStatuses.every((status) => status === "FAILED");
  const headFailed =
    headStatuses.length > 0 &&
    headStatuses.every((status) => status === "FAILED");
  const headPassed =
    headStatuses.length > 0 &&
    headStatuses.every((status) => status === "PASSED");
  const headBehavior = repeatedBehavior(
    pairOutcomes.map(({ headObserved }) => headObserved),
  );
  const baseBehavior = basePassed
    ? evaluatedIdentity.expected
    : repeatedBehavior(pairOutcomes.map(({ baseObserved }) => baseObserved));

  const contradictory =
    (headFailed && headBehavior === "CONTRADICTORY") ||
    (baseFailed && baseBehavior === "CONTRADICTORY") ||
    (!basePassed && !baseFailed) ||
    (!headPassed && !headFailed);
  if (contradictory) {
    addLimitation(
      limitations,
      "Differential observations were contradictory across repeats.",
    );
  }

  const validatedHeadDifference =
    headFailed &&
    headBehavior !== null &&
    typeof headBehavior === "object" &&
    evaluatedIdentity.expected !== null &&
    !sameBehavior(headBehavior, evaluatedIdentity.expected);
  if (headPassed) {
    addLimitation(
      limitations,
      "No validated structured behavioral difference was observed on head.",
    );
  } else if (headFailed && !validatedHeadDifference && !contradictory) {
    addLimitation(
      limitations,
      "The head failure did not contain a validated structured behavioral observation.",
    );
  }

  const commonConfirmationGates =
    identity.valid &&
    exactPath &&
    snapshotsConsistent &&
    completed &&
    environmentsMatch &&
    exactTestExecuted &&
    comparisons.length >= 2 &&
    !contradictory &&
    validatedHeadDifference &&
    evidence.current;

  let state: FindingState = "UNVERIFIED";
  if (commonConfirmationGates && basePassed) {
    state = "CONFIRMED_REGRESSION";
  } else if (
    commonConfirmationGates &&
    baseFailed &&
    baseBehavior !== null &&
    typeof baseBehavior === "object" &&
    headBehavior !== null &&
    typeof headBehavior === "object" &&
    !sameBehavior(baseBehavior, headBehavior)
  ) {
    state = "CONFIRMED_CHANGE";
    addLimitation(
      limitations,
      "The base assertion did not pass, so this is a confirmed change rather than a confirmed regression.",
    );
  } else if (
    identity.valid &&
    exactPath &&
    snapshotsConsistent &&
    completed &&
    environmentsMatch &&
    exactTestExecuted &&
    evidence.current &&
    basePassed &&
    headPassed
  ) {
    state = "PROBABLE_IMPACT";
  }

  const displayedBase = behaviorOrExpected(
    baseBehavior,
    evaluatedIdentity.expected,
  );
  const displayedHead = behaviorOrExpected(
    headBehavior,
    evaluatedIdentity.expected,
  );
  const repeatable =
    comparisons.length >= 2 && !contradictory && validatedHeadDifference;
  const factors = confidenceFactors({
    differential: validatedHeadDifference,
    exactTest: identity.valid && exactTestExecuted,
    exactPath,
    environmentsMatch,
    currentEvidence: evidence.current,
    repeatable,
    repeatCount: comparisons.length,
  });
  const confidence: ComparisonConfidence = deepFreeze({
    level:
      state === "CONFIRMED_REGRESSION" && comparisons.length >= 3
        ? "HIGH"
        : state === "CONFIRMED_REGRESSION" || state === "CONFIRMED_CHANGE"
          ? "MEDIUM"
          : "LOW",
    factors,
  });

  const findingEvidence = buildFindingEvidence(
    input.evidenceItems,
    revisions,
    comparisons.length,
  );
  const proofCard = deepFreeze({
    baseBehavior: describeBehavior(displayedBase),
    headBehavior: describeBehavior(displayedHead),
    evidenceIds: evidence.ids,
    affectedJourney:
      "Returning user → Restore session → Validate expired token",
    reproductionCommand: `codeatlas replay ${input.findingId}`,
    recommendedAction:
      "Restore the unconditional expiration guard or accept the changed behavior with a contract update",
    limitations: [...limitations],
  });
  const finding: Finding = {
    id: input.findingId,
    state,
    title: "Expired sessions return an internal error",
    summary: `${describeBehavior(displayedBase)} changed to ${describeBehavior(displayedHead)} on the expired-session journey.`,
    proofCard,
    evidence: findingEvidence,
  };

  Object.defineProperties(finding, {
    graphPath: {
      value: path?.display ?? "restoreSession → validateToken",
      enumerable: false,
    },
    confidence: { value: confidence, enumerable: false },
  });

  return Object.freeze([
    deepFreeze(finding as ComparisonFinding),
  ]) as unknown as ComparisonFinding[];
}

function identifyTest(test: ComparedTest): TestIdentity {
  if (test.provenance === "GENERATED") {
    const { generatedTest, objective } = test;
    return {
      path: generatedTest.path,
      objectiveId: generatedTest.objectiveId,
      expected: { ...generatedTest.expectedBehavior },
      evidenceIds: uniqueSorted([
        ...generatedTest.evidenceIds,
        ...objective.evidenceIds,
      ]),
      targetName: objective.targetSymbol,
      entryPointName: objective.entryPoint,
      valid:
        generatedTest.generated === true &&
        generatedTest.objectiveId === objective.id &&
        generatedTest.path.length > 0,
    };
  }

  return {
    path: test.selection.path,
    objectiveId: null,
    expected: null,
    evidenceIds: [...test.selection.evidenceIds],
    targetName: "validateToken",
    entryPointName: "restoreSession",
    valid: test.selection.testId.length > 0 && test.selection.path.length > 0,
  };
}

function expectedRevisions(
  changedSymbols: readonly ChangedSymbol[],
  targetName: string,
): { baseSha: string; headSha: string; target: ChangedSymbol } | null {
  const targets = changedSymbols.filter(
    (symbol) =>
      symbol.name === targetName &&
      symbol.baseLocation !== null &&
      symbol.headLocation !== null,
  );
  if (targets.length !== 1) return null;
  const target = targets[0]!;
  return {
    baseSha: target.baseLocation!.snapshotSha,
    headSha: target.headLocation!.snapshotSha,
    target,
  };
}

function objectiveMatchesChange(
  test: ComparedTest,
  changedSymbol: ChangedSymbol,
): boolean {
  if (test.provenance === "EXISTING") return true;
  const { objective } = test;
  return (
    objective.targetSymbol === changedSymbol.name &&
    objective.source.path === changedSymbol.path &&
    changedSymbol.headLocation?.snapshotSha === objective.source.snapshotSha &&
    changedSymbol.changedLines.includes(objective.source.startLine)
  );
}

function resolveGraphPath(
  edges: readonly SelectionEdge[],
  entryPointName: string,
  targetName: string,
): { display: string; targetId: string; evidenceIds: string[] } | null {
  if (!Array.isArray(edges) || edges.length === 0) return null;
  const names: string[] = [];
  const evidenceIds: string[] = [];
  let priorTo: string | null = null;
  for (const edge of edges) {
    if (
      typeof edge.from !== "string" ||
      typeof edge.to !== "string" ||
      typeof edge.fromName !== "string" ||
      typeof edge.toName !== "string" ||
      edge.relation !== "CALLS" ||
      (priorTo !== null && edge.from !== priorTo)
    ) {
      return null;
    }
    if (names.length === 0) names.push(edge.fromName);
    names.push(edge.toName);
    evidenceIds.push(...(edge.evidenceIds ?? []));
    priorTo = edge.to;
  }
  if (names[0] !== entryPointName || names.at(-1) !== targetName) return null;
  return {
    display: names.join(" → "),
    targetId: edges.at(-1)!.to,
    evidenceIds: uniqueSorted(evidenceIds),
  };
}

function outcomeForPair(
  pair: ExecutionComparison,
  identity: TestIdentity,
): PairOutcome {
  const baseCases = matchingCases(pair.base, identity);
  const headCases = matchingCases(pair.head, identity);
  return {
    baseStatus: baseCases.length === 1 ? baseCases[0]!.status : null,
    headStatus: headCases.length === 1 ? headCases[0]!.status : null,
    baseObserved: matchingObservation(pair.base, baseCases[0]?.name, identity),
    headObserved: matchingObservation(pair.head, headCases[0]?.name, identity),
  };
}

function expectedFromObservations(
  comparisons: readonly ExecutionComparison[],
  identity: TestIdentity,
): Behavior | null {
  const expected = comparisons.map(({ head }) => {
    const cases = matchingCases(head, identity);
    if (cases.length !== 1) return null;
    const observations = head.observations.filter(
      (observation) => observation.testName === cases[0]!.name,
    );
    if (
      observations.length !== 1 ||
      !validBehavior(observations[0]!.expected)
    ) {
      return null;
    }
    return { ...observations[0]!.expected };
  });
  const repeated = repeatedBehavior(expected);
  return typeof repeated === "object" && repeated !== null ? repeated : null;
}

function matchingCases(result: ExecutionResult, identity: TestIdentity) {
  return result.testCases.filter(
    (testCase) =>
      testCase.path === identity.path &&
      testCase.generatedObjectiveId === identity.objectiveId,
  );
}

function matchingObservation(
  result: ExecutionResult,
  testName: string | undefined,
  identity: TestIdentity,
): Behavior | null {
  if (testName === undefined) return null;
  const observations = result.observations.filter(
    (observation) => observation.testName === testName,
  );
  if (observations.length !== 1) return null;
  const observation = observations[0]!;
  if (
    observation.source !== "TEST_ASSERTION" ||
    (identity.expected !== null &&
      !sameBehavior(observation.expected, identity.expected)) ||
    !validBehavior(observation.actual)
  ) {
    return null;
  }
  return { ...observation.actual };
}

function repeatedBehavior(
  behaviors: readonly (Behavior | null)[],
): Behavior | "CONTRADICTORY" | null {
  if (
    behaviors.length === 0 ||
    behaviors.every((behavior) => behavior === null)
  ) {
    return null;
  }
  if (behaviors.some((behavior) => behavior === null)) return "CONTRADICTORY";
  const first = behaviors[0]!;
  return behaviors.every(
    (behavior) => behavior !== null && sameBehavior(behavior, first),
  )
    ? first
    : "CONTRADICTORY";
}

function assessEvidence(
  items: readonly EvidenceItem[],
  revisions: ReturnType<typeof expectedRevisions>,
  identity: TestIdentity,
  path: ReturnType<typeof resolveGraphPath>,
): { current: boolean; ids: string[]; limitations: string[] } {
  const limitations: string[] = [];
  const ids = uniqueSorted(items.map(({ id }) => id));
  if (ids.length !== items.length) {
    limitations.push("Cited evidence identifiers are duplicated.");
  }
  if (items.some((item) => !ARTIFACT_DIGEST.test(item.artifactDigest))) {
    limitations.push("Cited evidence has a malformed artifact digest.");
  }
  if (items.some((item) => !EvidenceItemSchema.safeParse(item).success)) {
    limitations.push("Cited evidence does not satisfy the evidence schema.");
  }
  if (
    revisions === null ||
    items.some(
      (item) =>
        item.source === undefined ||
        (item.source.snapshotSha !== revisions.baseSha &&
          item.source.snapshotSha !== revisions.headSha),
    )
  ) {
    limitations.push(
      "Cited evidence is not bound to a current comparison snapshot.",
    );
  }
  const requiredIds = uniqueSorted([
    ...identity.evidenceIds,
    ...(path?.evidenceIds ?? []),
  ]);
  if (requiredIds.some((id) => !ids.includes(id))) {
    limitations.push(
      "Required test, objective, or graph-path evidence is missing.",
    );
  }
  if (!items.some((item) => item.type === "DIFFERENTIAL_EXECUTION")) {
    limitations.push("Differential execution evidence is missing.");
  }
  if (
    !items.some(
      (item) =>
        item.type !== "DIFFERENTIAL_EXECUTION" && item.type !== "AI_INFERENCE",
    )
  ) {
    limitations.push("Independent corroborating evidence is missing.");
  }
  return {
    current: limitations.length === 0,
    ids,
    limitations,
  };
}

function buildFindingEvidence(
  items: readonly EvidenceItem[],
  revisions: ReturnType<typeof expectedRevisions>,
  repeatCount: number,
): FindingEvidence[] {
  const fallbackSha = "0".repeat(40);
  const baseSha = revisions?.baseSha ?? fallbackSha;
  const headSha = revisions?.headSha ?? fallbackSha;
  return deepFreeze(
    [...items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({
        id: item.id,
        type: item.type,
        reproducibility: item.reproducibility,
        baseSha,
        headSha,
        executions:
          item.type === "DIFFERENTIAL_EXECUTION"
            ? { base: repeatCount, head: repeatCount }
            : { base: 0, head: 0 },
      })),
  );
}

function confidenceFactors(input: {
  differential: boolean;
  exactTest: boolean;
  exactPath: boolean;
  environmentsMatch: boolean;
  currentEvidence: boolean;
  repeatable: boolean;
  repeatCount: number;
}): string[] {
  const factors: string[] = [];
  if (input.differential) factors.push("DIFFERENTIAL_EXECUTION");
  if (input.exactTest) factors.push("EXACT_TEST_IDENTITY");
  if (input.exactPath) factors.push("EXACT_SYMBOL_PATH");
  if (input.environmentsMatch) factors.push("MATCHING_ENVIRONMENT");
  if (input.currentEvidence) factors.push("CURRENT_EVIDENCE");
  if (input.repeatable) {
    factors.push(`REPEATABLE_${input.repeatCount}_OF_${input.repeatCount}`);
  }
  return factors;
}

function behaviorOrExpected(
  behavior: Behavior | "CONTRADICTORY" | null,
  expected: Behavior | null,
): Behavior | null {
  return typeof behavior === "object" ? behavior : expected;
}

function describeBehavior(behavior: Behavior | null): string {
  return behavior === null
    ? "Behavior unavailable"
    : `HTTP ${behavior.httpStatus} with ${behavior.code}`;
}

function validBehavior(value: Behavior): boolean {
  return (
    Number.isInteger(value.httpStatus) &&
    value.httpStatus >= 100 &&
    value.httpStatus <= 599 &&
    typeof value.code === "string" &&
    value.code.length > 0
  );
}

function sameBehavior(left: Behavior, right: Behavior): boolean {
  return left.httpStatus === right.httpStatus && left.code === right.code;
}

function addLimitation(limitations: string[], limitation: string): void {
  if (!limitations.includes(limitation)) limitations.push(limitation);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
