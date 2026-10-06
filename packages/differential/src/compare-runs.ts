import type { ChangedSymbol } from "@codeatlas/analyzer";
import {
  EvidenceItemSchema,
  FindingSchema,
  type ConfidenceFactor,
  type EvidenceItem,
  type Finding,
  type FindingConfidence,
  type FindingEvidence,
  type FindingState,
} from "@codeatlas/evidence";
import type { GeneratedTest, TestObjective } from "@codeatlas/generator";
import {
  hasValidExecutionResultBinding,
  type ExecutionResult,
} from "@codeatlas/runner";
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

export type ComparisonConfidence = FindingConfidence;

export interface ComparisonFinding extends Finding {
  readonly graphPath: string;
  readonly confidence: FindingConfidence;
}

interface TestIdentity {
  provenance: "GENERATED" | "EXISTING";
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

interface RevisionIdentity {
  baseSha: string;
  headSha: string;
  target: ChangedSymbol;
}

interface ResolvedPath {
  display: string;
  targetId: string;
  evidenceIds: string[];
}

interface EvidenceAssessment {
  current: boolean;
  ids: string[];
  items: EvidenceItem[];
  limitations: string[];
}

interface ExecutionAssessment {
  integrity: boolean;
  baseCount: number;
  headCount: number;
  limitations: string[];
}

type RuntimePair = { base: unknown; head: unknown; reference: object };

const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const FALLBACK_SHA = "0".repeat(40);

export function compareRuns(input: ComparisonInput): ComparisonFinding[] {
  const rawInput: unknown = input;
  if (!isRecord(rawInput) || !validIdentifier(rawInput.findingId)) {
    return frozenEmpty();
  }

  const findingId = rawInput.findingId;
  const limitations: string[] = [];
  const identity = identifyTest(rawInput.test);
  if (!identity.valid) {
    addLimitation(
      limitations,
      "The compared test identity does not match its objective.",
    );
  }
  if (identity.provenance === "EXISTING") {
    addLimitation(
      limitations,
      "Existing selected tests do not provide a trusted structured behavioral observation.",
    );
  }

  const revisions = expectedRevisions(
    Array.isArray(rawInput.changedSymbols) ? rawInput.changedSymbols : [],
    identity.targetName,
  );
  const path = resolveGraphPath(
    Array.isArray(rawInput.graphPath) ? rawInput.graphPath : [],
    identity.entryPointName,
    identity.targetName,
  );
  const exactPath =
    revisions !== null &&
    path !== null &&
    path.targetId === revisions.target.id &&
    objectiveMatchesChange(rawInput.test, revisions.target);
  if (!exactPath) {
    addLimitation(
      limitations,
      "The graph path does not resolve the exact changed symbol and objective.",
    );
  }

  const rawComparisons = Array.isArray(rawInput.comparisons)
    ? rawInput.comparisons
    : [];
  const pairs = runtimePairs(rawComparisons);
  if (rawComparisons.length !== pairs.length) {
    addLimitation(limitations, "A base/head execution pair is malformed.");
  }
  if (pairs.length < 2) {
    addLimitation(
      limitations,
      "Fewer than two base/head comparisons were available.",
    );
  }

  const execution = assessExecutionBindings(pairs);
  for (const limitation of execution.limitations) {
    addLimitation(limitations, limitation);
  }

  const completePairs = pairs.filter(
    (
      pair,
    ): pair is RuntimePair & {
      base: ExecutionResult;
      head: ExecutionResult;
    } => isExecutionResultShape(pair.base) && isExecutionResultShape(pair.head),
  );
  const snapshotsConsistent =
    revisions !== null &&
    completePairs.length === pairs.length &&
    completePairs.length > 0 &&
    completePairs.every(
      ({ base, head }) =>
        base.revision === "base" &&
        head.revision === "head" &&
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
    completePairs.length === pairs.length &&
    completePairs.length > 0 &&
    completePairs.every(
      ({ base, head }) =>
        base.terminalState === "COMPLETED" &&
        head.terminalState === "COMPLETED",
    );
  if (!completed) {
    addLimitation(limitations, "Base and head did not both complete.");
  }

  const environmentDigests = completePairs.flatMap(({ base, head }) => [
    base.environmentDigest,
    head.environmentDigest,
  ]);
  const environmentsMatch =
    completePairs.length === pairs.length &&
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

  const pairOutcomes = completePairs.map((comparison) =>
    outcomeForPair(comparison, identity),
  );
  const exactTestExecuted =
    pairOutcomes.length === pairs.length &&
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
      identity.provenance === "GENERATED"
        ? "The exact generated test was not executed on both revisions."
        : "The exact existing test was not executed on both revisions.",
    );
  }

  const evidence = assessEvidence(
    rawInput.evidenceItems,
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
    ? identity.expected
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
    identity.provenance === "GENERATED" &&
    headFailed &&
    isBehavior(headBehavior) &&
    identity.expected !== null &&
    !sameBehavior(headBehavior, identity.expected);
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

  const baseAndHeadSame =
    baseFailed &&
    headFailed &&
    isBehavior(baseBehavior) &&
    isBehavior(headBehavior) &&
    sameBehavior(baseBehavior, headBehavior);
  if (baseAndHeadSame) {
    addLimitation(
      limitations,
      "Base and head failed with the same observed behavior, so no differential change was established.",
    );
  }

  const commonConfirmationGates =
    identity.valid &&
    identity.provenance === "GENERATED" &&
    exactPath &&
    execution.integrity &&
    snapshotsConsistent &&
    completed &&
    environmentsMatch &&
    exactTestExecuted &&
    execution.baseCount >= 2 &&
    execution.headCount >= 2 &&
    !contradictory &&
    validatedHeadDifference &&
    evidence.current;

  let state: FindingState = "UNVERIFIED";
  if (commonConfirmationGates && basePassed) {
    state = "CONFIRMED_REGRESSION";
  } else if (
    commonConfirmationGates &&
    baseFailed &&
    isBehavior(baseBehavior) &&
    isBehavior(headBehavior) &&
    !sameBehavior(baseBehavior, headBehavior)
  ) {
    state = "CONFIRMED_CHANGE";
    addLimitation(
      limitations,
      "The base assertion did not pass, so this is a confirmed change rather than a confirmed regression.",
    );
  } else if (
    identity.valid &&
    identity.provenance === "GENERATED" &&
    exactPath &&
    execution.integrity &&
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

  if (state !== "CONFIRMED_REGRESSION" && limitations.length === 0) {
    addLimitation(
      limitations,
      "Confirmation eligibility was not established from the supplied execution and evidence records.",
    );
  }

  const displayedBase = behaviorOrExpected(baseBehavior, identity.expected);
  const displayedHead = behaviorOrExpected(headBehavior, identity.expected);
  const repeatCount = Math.min(execution.baseCount, execution.headCount);
  const repeatable =
    execution.integrity &&
    repeatCount >= 2 &&
    !contradictory &&
    validatedHeadDifference;
  const confidence: FindingConfidence = deepFreeze({
    level:
      state === "CONFIRMED_REGRESSION" && repeatCount >= 3
        ? "HIGH"
        : state === "CONFIRMED_REGRESSION" || state === "CONFIRMED_CHANGE"
          ? "MEDIUM"
          : "LOW",
    factors: confidenceFactors({
      differential: validatedHeadDifference,
      exactTest: identity.valid && exactTestExecuted,
      exactPath,
      environmentsMatch,
      currentEvidence: evidence.current,
      repeatable,
      repeatCount,
    }),
  });

  const findingEvidence = buildFindingEvidence(
    evidence.items,
    revisions,
    execution.baseCount,
    execution.headCount,
  );
  const finding: ComparisonFinding = {
    id: findingId,
    state,
    title: "Expired sessions return an internal error",
    summary: `${describeBehavior(displayedBase)} changed to ${describeBehavior(displayedHead)} on the expired-session journey.`,
    graphPath: path?.display ?? "restoreSession → validateToken",
    confidence,
    proofCard: {
      baseBehavior: describeBehavior(displayedBase),
      headBehavior: describeBehavior(displayedHead),
      evidenceIds: evidence.ids,
      affectedJourney:
        "Returning user → Restore session → Validate expired token",
      reproductionCommand: `codeatlas replay ${findingId}`,
      recommendedAction:
        "Restore the unconditional expiration guard or accept the changed behavior with a contract update",
      limitations: [...limitations],
    },
    evidence: findingEvidence,
  };

  const parsed = FindingSchema.safeParse(finding);
  if (!parsed.success) return frozenEmpty();
  return Object.freeze([
    deepFreeze(parsed.data as ComparisonFinding),
  ]) as unknown as ComparisonFinding[];
}

function identifyTest(value: unknown): TestIdentity {
  const invalid: TestIdentity = {
    provenance: "GENERATED",
    path: "",
    objectiveId: null,
    expected: null,
    evidenceIds: [],
    targetName: "validateToken",
    entryPointName: "restoreSession",
    valid: false,
  };
  if (!isRecord(value)) return invalid;
  if (value.provenance === "GENERATED") {
    if (!isRecord(value.generatedTest) || !isRecord(value.objective)) {
      return invalid;
    }
    const generatedTest = value.generatedTest;
    const objective = value.objective;
    const expected = parseBehavior(generatedTest.expectedBehavior);
    const generatedEvidence = stringArray(generatedTest.evidenceIds);
    const objectiveEvidence = stringArray(objective.evidenceIds);
    const path = stringValue(generatedTest.path);
    const objectiveId = stringValue(generatedTest.objectiveId);
    const targetName = stringValue(objective.targetSymbol);
    const entryPointName = stringValue(objective.entryPoint);
    return {
      provenance: "GENERATED",
      path,
      objectiveId: objectiveId || null,
      expected,
      evidenceIds: uniqueSorted([...generatedEvidence, ...objectiveEvidence]),
      targetName: targetName || "validateToken",
      entryPointName: entryPointName || "restoreSession",
      valid:
        generatedTest.generated === true &&
        objectiveId.length > 0 &&
        objectiveId === objective.id &&
        path.length > 0 &&
        expected !== null &&
        targetName.length > 0 &&
        entryPointName.length > 0,
    };
  }
  if (value.provenance === "EXISTING" && isRecord(value.selection)) {
    const path = stringValue(value.selection.path);
    return {
      provenance: "EXISTING",
      path,
      objectiveId: null,
      expected: null,
      evidenceIds: stringArray(value.selection.evidenceIds),
      targetName: "validateToken",
      entryPointName: "restoreSession",
      valid: validIdentifier(value.selection.testId) && path.length > 0,
    };
  }
  return invalid;
}

function expectedRevisions(
  values: readonly unknown[],
  targetName: string,
): RevisionIdentity | null {
  const targets = values.filter(
    (value): value is ChangedSymbol =>
      isChangedSymbol(value) &&
      value.name === targetName &&
      value.baseLocation !== null &&
      value.headLocation !== null,
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
  test: unknown,
  changedSymbol: ChangedSymbol,
): boolean {
  if (!isRecord(test)) return false;
  if (test.provenance === "EXISTING") return true;
  if (test.provenance !== "GENERATED" || !isRecord(test.objective)) {
    return false;
  }
  const source = test.objective.source;
  return (
    isRecord(source) &&
    test.objective.targetSymbol === changedSymbol.name &&
    source.path === changedSymbol.path &&
    changedSymbol.headLocation?.snapshotSha === source.snapshotSha &&
    typeof source.startLine === "number" &&
    changedSymbol.changedLines.includes(source.startLine)
  );
}

function resolveGraphPath(
  values: readonly unknown[],
  entryPointName: string,
  targetName: string,
): ResolvedPath | null {
  if (values.length === 0) return null;
  const names: string[] = [];
  const evidenceIds: string[] = [];
  let priorTo: string | null = null;
  let targetId = "";
  for (const value of values) {
    if (
      !isRecord(value) ||
      !validIdentifier(value.from) ||
      !validIdentifier(value.to) ||
      !validIdentifier(value.fromName) ||
      !validIdentifier(value.toName) ||
      value.relation !== "CALLS" ||
      (priorTo !== null && value.from !== priorTo)
    ) {
      return null;
    }
    if (names.length === 0) names.push(value.fromName);
    names.push(value.toName);
    evidenceIds.push(...stringArray(value.evidenceIds));
    priorTo = value.to;
    targetId = value.to;
  }
  if (names[0] !== entryPointName || names.at(-1) !== targetName) return null;
  return {
    display: names.join(" → "),
    targetId,
    evidenceIds: uniqueSorted(evidenceIds),
  };
}

function runtimePairs(values: readonly unknown[]): RuntimePair[] {
  return values.flatMap((value) =>
    isRecord(value) && "base" in value && "head" in value
      ? [{ base: value.base, head: value.head, reference: value }]
      : [],
  );
}

function assessExecutionBindings(
  pairs: readonly RuntimePair[],
): ExecutionAssessment {
  const limitations: string[] = [];
  const results = pairs.flatMap(({ base, head }) => [base, head]);
  const malformed = results.some((result) => !isExecutionResultShape(result));
  const invalidBinding = results.some(
    (result) =>
      isExecutionResultShape(result) && !hasValidExecutionResultBinding(result),
  );
  if (malformed) {
    limitations.push(
      "An execution result is malformed or missing run-bound identity.",
    );
  }
  if (invalidBinding) {
    limitations.push(
      "An execution result digest does not match its run-bound result.",
    );
  }

  const records = results.filter(
    (result): result is ExecutionResult =>
      isExecutionResultShape(result) && hasValidExecutionResultBinding(result),
  );
  const references = new Set(pairs.map(({ reference }) => reference));
  const suppliedIds = results.flatMap((result) =>
    isRecord(result) && typeof result.executionId === "string"
      ? [result.executionId]
      : [],
  );
  const suppliedDigests = results.flatMap((result) =>
    isRecord(result) && typeof result.resultDigest === "string"
      ? [result.resultDigest]
      : [],
  );
  const duplicate =
    references.size !== pairs.length ||
    new Set(suppliedIds).size !== suppliedIds.length ||
    new Set(suppliedDigests).size !== suppliedDigests.length;
  if (duplicate) {
    limitations.push(
      "Each repeat must contain unique run-bound execution identities and result digests.",
    );
  }

  const uniqueBase = uniqueBoundResults(
    records.filter(({ revision }) => revision === "base"),
  );
  const uniqueHead = uniqueBoundResults(
    records.filter(({ revision }) => revision === "head"),
  );
  return {
    integrity:
      !malformed &&
      !invalidBinding &&
      !duplicate &&
      records.length === results.length,
    baseCount: uniqueBase.length,
    headCount: uniqueHead.length,
    limitations,
  };
}

function uniqueBoundResults(
  values: readonly ExecutionResult[],
): ExecutionResult[] {
  const byBinding = new Map<string, ExecutionResult>();
  for (const value of values) {
    byBinding.set(`${value.executionId}\u0000${value.resultDigest}`, value);
  }
  return [...byBinding.values()];
}

function outcomeForPair(
  pair: { base: ExecutionResult; head: ExecutionResult },
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
  if (testName === undefined || identity.provenance !== "GENERATED")
    return null;
  const observations = result.observations.filter(
    (observation) =>
      observation.testName === testName &&
      observation.path === identity.path &&
      observation.generatedObjectiveId === identity.objectiveId,
  );
  if (observations.length !== 1) return null;
  const observation = observations[0]!;
  if (
    observation.source !== "TEST_ASSERTION" ||
    identity.expected === null ||
    !sameBehavior(observation.expected, identity.expected) ||
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
  value: unknown,
  revisions: RevisionIdentity | null,
  identity: TestIdentity,
  path: ResolvedPath | null,
): EvidenceAssessment {
  const limitations: string[] = [];
  const rawItems = Array.isArray(value) ? value : [];
  if (!Array.isArray(value)) {
    limitations.push("Cited evidence is not an array.");
  }
  if (
    rawItems.some(
      (item) =>
        isRecord(item) && !ARTIFACT_DIGEST.test(String(item.artifactDigest)),
    )
  ) {
    limitations.push("Cited evidence has a malformed artifact digest.");
  }

  const parsedItems: EvidenceItem[] = [];
  for (const rawItem of rawItems) {
    const parsed = EvidenceItemSchema.safeParse(rawItem);
    if (parsed.success) parsedItems.push(parsed.data);
    else
      limitations.push("Cited evidence does not satisfy the evidence schema.");
  }
  if (parsedItems.length === 0) {
    limitations.push(
      "No usable evidence items were provided for this finding.",
    );
  }

  const groups = new Map<string, EvidenceItem[]>();
  for (const item of parsedItems) {
    const group = groups.get(item.id) ?? [];
    group.push(item);
    groups.set(item.id, group);
  }
  const items: EvidenceItem[] = [];
  for (const id of [...groups.keys()].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const group = groups.get(id)!;
    const canonical = uniqueSorted(group.map((item) => JSON.stringify(item)));
    if (canonical.length > 1) {
      limitations.push("Conflicting evidence records share an identifier.");
    }
    items.push(JSON.parse(canonical[0]!) as EvidenceItem);
  }
  const ids = items.map(({ id }) => id);

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
  const differential = items.filter(
    (item) => item.type === "DIFFERENTIAL_EXECUTION",
  );
  if (differential.length === 0) {
    limitations.push("Differential execution evidence is missing.");
  } else if (
    differential.some(
      ({ reproducibility }) => reproducibility !== "REPRODUCIBLE",
    )
  ) {
    limitations.push("Differential execution evidence is not reproducible.");
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
    items,
    limitations: uniqueInOrder(limitations),
  };
}

function buildFindingEvidence(
  items: readonly EvidenceItem[],
  revisions: RevisionIdentity | null,
  baseCount: number,
  headCount: number,
): FindingEvidence[] {
  return items.map((item) => ({
    id: item.id,
    type: item.type,
    reproducibility: item.reproducibility,
    baseSha: revisions?.baseSha ?? FALLBACK_SHA,
    headSha: revisions?.headSha ?? FALLBACK_SHA,
    executions:
      item.type === "DIFFERENTIAL_EXECUTION"
        ? { base: baseCount, head: headCount }
        : { base: 0, head: 0 },
  }));
}

function confidenceFactors(input: {
  differential: boolean;
  exactTest: boolean;
  exactPath: boolean;
  environmentsMatch: boolean;
  currentEvidence: boolean;
  repeatable: boolean;
  repeatCount: number;
}): ConfidenceFactor[] {
  const factors: ConfidenceFactor[] = [];
  if (input.differential) factors.push("DIFFERENTIAL_EXECUTION");
  if (input.exactTest) factors.push("EXACT_TEST_IDENTITY");
  if (input.exactPath) factors.push("EXACT_SYMBOL_PATH");
  if (input.environmentsMatch) factors.push("MATCHING_ENVIRONMENT");
  if (input.currentEvidence) factors.push("CURRENT_EVIDENCE");
  if (input.repeatable) {
    factors.push(
      `REPEATABLE_${input.repeatCount}_OF_${input.repeatCount}` as ConfidenceFactor,
    );
  }
  if (factors.length === 0) factors.push("INSUFFICIENT_EVIDENCE");
  return factors;
}

function isExecutionResultShape(value: unknown): value is ExecutionResult {
  return (
    isRecord(value) &&
    typeof value.executionId === "string" &&
    (value.revision === "base" || value.revision === "head") &&
    typeof value.snapshotSha === "string" &&
    ["COMPLETED", "TIMED_OUT", "OUTPUT_LIMIT", "FAILED"].includes(
      String(value.terminalState),
    ) &&
    (value.exitCode === null || Number.isInteger(value.exitCode)) &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0 &&
    Array.isArray(value.testCases) &&
    value.testCases.every(isTestCase) &&
    Array.isArray(value.coverage) &&
    value.coverage.every(isCoverageRecord) &&
    Array.isArray(value.observations) &&
    value.observations.every(isObservation) &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    typeof value.environmentDigest === "string" &&
    typeof value.resultDigest === "string"
  );
}

function isTestCase(value: unknown): boolean {
  return (
    isRecord(value) &&
    validIdentifier(value.name) &&
    validIdentifier(value.path) &&
    ["PASSED", "FAILED", "SKIPPED"].includes(String(value.status)) &&
    (value.failureMessage === null ||
      typeof value.failureMessage === "string") &&
    (value.generatedObjectiveId === null ||
      typeof value.generatedObjectiveId === "string")
  );
}

function isCoverageRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    validIdentifier(value.path) &&
    Array.isArray(value.coveredLines) &&
    value.coveredLines.every((line) => Number.isInteger(line))
  );
}

function isObservation(value: unknown): boolean {
  return (
    isRecord(value) &&
    validIdentifier(value.testName) &&
    validIdentifier(value.path) &&
    (value.generatedObjectiveId === null ||
      typeof value.generatedObjectiveId === "string") &&
    value.source === "TEST_ASSERTION" &&
    parseBehavior(value.expected) !== null &&
    parseBehavior(value.actual) !== null
  );
}

function isChangedSymbol(value: unknown): value is ChangedSymbol {
  return (
    isRecord(value) &&
    validIdentifier(value.id) &&
    validIdentifier(value.name) &&
    typeof value.path === "string" &&
    Array.isArray(value.changedLines) &&
    value.changedLines.every((line) => Number.isInteger(line)) &&
    (value.baseLocation === null || isSourceLocation(value.baseLocation)) &&
    (value.headLocation === null || isSourceLocation(value.headLocation))
  );
}

function isSourceLocation(
  value: unknown,
): value is ChangedSymbol["headLocation"] {
  return (
    isRecord(value) &&
    typeof value.snapshotSha === "string" &&
    typeof value.path === "string" &&
    typeof value.startLine === "number" &&
    typeof value.endLine === "number"
  );
}

function parseBehavior(value: unknown): Behavior | null {
  return isRecord(value) && validBehavior(value as unknown as Behavior)
    ? { httpStatus: value.httpStatus as number, code: value.code as string }
    : null;
}

function isBehavior(
  value: Behavior | "CONTRADICTORY" | null,
): value is Behavior {
  return typeof value === "object" && value !== null;
}

function behaviorOrExpected(
  behavior: Behavior | "CONTRADICTORY" | null,
  expected: Behavior | null,
): Behavior | null {
  return isBehavior(behavior) ? behavior : expected;
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => validIdentifier(item))
    : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frozenEmpty(): ComparisonFinding[] {
  return Object.freeze([]) as unknown as ComparisonFinding[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
