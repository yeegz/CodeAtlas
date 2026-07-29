import type { ChangedSymbol } from "@codeatlas/analyzer";
import {
  ChangePassportSchema,
  FindingSchema,
  TestExecutionSchema,
  type ChangePassport,
  type Finding,
  type TestExecution,
} from "@codeatlas/evidence";
import {
  hasValidExecutionResultBinding,
  type ExecutionResult,
} from "@codeatlas/runner";
import { canonicalize } from "json-canonicalize";

const INPUT_FIELDS = new Set([
  "baseSha",
  "headSha",
  "engineVersion",
  "findings",
  "runs",
  "tests",
  "changedSymbols",
  "unverifiedAreas",
  "retentionPolicy",
  "manifestDigest",
]);

export interface BuildPassportInput {
  baseSha: string;
  headSha: string;
  engineVersion: string;
  findings: readonly Finding[];
  runs: readonly ExecutionResult[];
  tests: readonly TestExecution[];
  changedSymbols: readonly ChangedSymbol[];
  unverifiedAreas: readonly string[];
  retentionPolicy: string;
  manifestDigest: string;
}

export type PassportOverallState = "ACTION_REQUIRED" | "PARTIAL" | "VERIFIED";

export interface PassportSummary {
  findings: {
    acceptedChanges: number;
    confirmedChanges: number;
    confirmedRegressions: number;
    probableImpacts: number;
    unverified: number;
  };
  runs: { base: number; completed: number; head: number; total: number };
  tests: {
    executedOnBase: number;
    executedOnHead: number;
    generated: number;
    total: number;
  };
}

export interface PassportChangedSymbol {
  id: string;
  name: string;
  path: string;
  changedLines: number[];
  signatureChanged: boolean;
}

export interface BuiltChangePassport extends ChangePassport {
  overallState: PassportOverallState;
  summary: PassportSummary;
  changedFiles: string[];
  changedSymbols: PassportChangedSymbol[];
  evidenceIds: string[];
  replayCommands: string[];
}

export function buildPassport(input: BuildPassportInput): BuiltChangePassport {
  assertExactInput(input);
  if (!Array.isArray(input.runs)) {
    throw new TypeError("runs are required to derive executed-test counts");
  }
  if (!Array.isArray(input.changedSymbols)) {
    throw new TypeError("changedSymbols are required");
  }
  if (!Array.isArray(input.unverifiedAreas)) {
    throw new TypeError("unverifiedAreas are required");
  }

  const findings = input.findings
    .map((finding) => FindingSchema.parse(finding))
    .sort((left, right) => compareText(left.id, right.id));
  const runs = input.runs.map((run) => validateRun(run, input));
  const tests = input.tests
    .map((test) => TestExecutionSchema.parse(test))
    .map((test) => deriveExecutionState(test, runs))
    .sort((left, right) => compareText(left.id, right.id));
  const changedSymbols = input.changedSymbols
    .map(validateChangedSymbol)
    .sort(
      (left, right) =>
        compareText(left.path, right.path) ||
        compareText(left.name, right.name) ||
        compareText(left.id, right.id),
    );
  const changedFiles = uniqueSorted(changedSymbols.map(({ path }) => path));
  const unverifiedAreas = uniqueSorted([
    ...input.unverifiedAreas,
    ...findings
      .filter(({ state }) => state === "UNVERIFIED")
      .flatMap(({ proofCard }) => proofCard.limitations),
  ]);

  const core = ChangePassportSchema.parse({
    baseSha: input.baseSha,
    headSha: input.headSha,
    engineVersion: input.engineVersion,
    findings,
    executedTests: tests,
    unverifiedAreas,
    retentionPolicy: input.retentionPolicy,
    manifestDigest: input.manifestDigest,
  });
  const summary = summarize(core, runs);
  const incompleteRun = runs.some(
    ({ terminalState }) => terminalState !== "COMPLETED",
  );
  const overallState: PassportOverallState =
    summary.findings.confirmedRegressions > 0
      ? "ACTION_REQUIRED"
      : summary.findings.unverified > 0 ||
          unverifiedAreas.length > 0 ||
          incompleteRun
        ? "PARTIAL"
        : "VERIFIED";
  const evidenceIds = uniqueSorted([
    ...findings.flatMap(({ proofCard }) => proofCard.evidenceIds),
    ...tests.flatMap(({ evidenceIds: ids }) => ids),
  ]);
  const replayCommands = uniqueSorted(
    findings.map(({ proofCard }) => proofCard.reproductionCommand),
  );

  return deepFreeze({
    ...core,
    overallState,
    summary,
    changedFiles,
    changedSymbols,
    evidenceIds,
    replayCommands,
  });
}

export function passportToJson(passport: BuiltChangePassport): string {
  const validated = validateBuiltPassport(passport);
  return canonicalize(validated);
}

export function passportToMarkdown(passport: BuiltChangePassport): string {
  const value = validateBuiltPassport(passport);
  const lines = [
    "# CodeAtlas Change Passport",
    "",
    `Overall state: ${value.overallState}`,
    `Base: ${value.baseSha}`,
    `Head: ${value.headSha}`,
    `Engine: ${value.engineVersion}`,
    `Manifest: ${value.manifestDigest}`,
    `Retention: ${value.retentionPolicy}`,
    "",
    "## Summary",
    "",
    `- Confirmed regressions: ${value.summary.findings.confirmedRegressions}`,
    `- Confirmed changes: ${value.summary.findings.confirmedChanges}`,
    `- Unverified findings: ${value.summary.findings.unverified}`,
    `- Completed runs: ${value.summary.runs.completed}/${value.summary.runs.total}`,
    `- Tests executed on base: ${value.summary.tests.executedOnBase}`,
    `- Tests executed on head: ${value.summary.tests.executedOnHead}`,
    "",
    "## Findings",
    "",
    ...value.findings.flatMap((finding) => [
      `### ${finding.title}`,
      "",
      `${finding.state}: ${finding.summary}`,
      "",
      `Replay: \`${finding.proofCard.reproductionCommand}\``,
      "",
    ]),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function validateBuiltPassport(
  value: BuiltChangePassport,
): BuiltChangePassport {
  ChangePassportSchema.parse(coreProjection(value));
  if (
    value.overallState !== "ACTION_REQUIRED" &&
    value.overallState !== "PARTIAL" &&
    value.overallState !== "VERIFIED"
  ) {
    throw new TypeError("Passport overallState is invalid");
  }
  return value;
}

function coreProjection(value: BuiltChangePassport): ChangePassport {
  return {
    baseSha: value.baseSha,
    headSha: value.headSha,
    engineVersion: value.engineVersion,
    findings: value.findings,
    executedTests: value.executedTests,
    unverifiedAreas: value.unverifiedAreas,
    retentionPolicy: value.retentionPolicy,
    manifestDigest: value.manifestDigest,
  };
}

function validateRun(
  run: ExecutionResult,
  input: Pick<BuildPassportInput, "baseSha" | "headSha">,
): ExecutionResult {
  if (!hasValidExecutionResultBinding(run)) {
    throw new TypeError(
      "Execution result does not have a valid digest binding",
    );
  }
  const expectedSha = run.revision === "base" ? input.baseSha : input.headSha;
  if (run.snapshotSha !== expectedSha) {
    throw new TypeError(
      "Execution result revision does not match the Passport",
    );
  }
  return structuredClone(run);
}

function deriveExecutionState(
  test: TestExecution,
  runs: readonly ExecutionResult[],
): TestExecution {
  const path = test.command.split(/\s+/u).at(-1);
  if (!path) throw new TypeError(`Test ${test.id} has no command path`);
  const executed = (revision: "base" | "head") =>
    runs.some(
      (run) =>
        run.revision === revision &&
        run.terminalState === "COMPLETED" &&
        run.testCases.some(
          (testCase) =>
            testCase.path === path &&
            testCase.status !== "SKIPPED" &&
            (test.provenance === "GENERATED"
              ? testCase.generatedObjectiveId !== null
              : testCase.generatedObjectiveId === null),
        ),
    );
  return {
    ...test,
    executedOnBase: executed("base"),
    executedOnHead: executed("head"),
    evidenceIds: uniqueSorted(test.evidenceIds),
  };
}

function validateChangedSymbol(value: ChangedSymbol): PassportChangedSymbol {
  if (
    typeof value?.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    !Array.isArray(value.changedLines) ||
    value.changedLines.some((line) => !Number.isSafeInteger(line) || line <= 0)
  ) {
    throw new TypeError("Changed symbol does not match the analyzer contract");
  }
  return {
    id: value.id,
    name: value.name,
    path: value.path,
    changedLines: [...new Set(value.changedLines)].sort((a, b) => a - b),
    signatureChanged: value.signatureChanged,
  };
}

function summarize(
  passport: ChangePassport,
  runs: readonly ExecutionResult[],
): PassportSummary {
  const count = (state: Finding["state"]) =>
    passport.findings.filter((finding) => finding.state === state).length;
  return {
    findings: {
      acceptedChanges: count("ACCEPTED_CHANGE"),
      confirmedChanges: count("CONFIRMED_CHANGE"),
      confirmedRegressions: count("CONFIRMED_REGRESSION"),
      probableImpacts: count("PROBABLE_IMPACT"),
      unverified: count("UNVERIFIED"),
    },
    runs: {
      base: runs.filter(({ revision }) => revision === "base").length,
      completed: runs.filter(
        ({ terminalState }) => terminalState === "COMPLETED",
      ).length,
      head: runs.filter(({ revision }) => revision === "head").length,
      total: runs.length,
    },
    tests: {
      executedOnBase: passport.executedTests.filter(
        ({ executedOnBase }) => executedOnBase,
      ).length,
      executedOnHead: passport.executedTests.filter(
        ({ executedOnHead }) => executedOnHead,
      ).length,
      generated: passport.executedTests.filter(
        ({ provenance }) => provenance === "GENERATED",
      ).length,
      total: passport.executedTests.length,
    },
  };
}

function assertExactInput(input: BuildPassportInput): void {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("Passport input is required");
  }
  const unknown = Object.keys(input).filter(
    (field) => !INPUT_FIELDS.has(field),
  );
  if (unknown.length > 0) {
    throw new TypeError(
      `Unknown or caller-provided Passport fields: ${unknown.join(", ")}`,
    );
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
