import type { ChangedSymbol } from "@codeatlas/analyzer";
import {
  ChangePassportSchema,
  FindingSchema,
  SourceLocationSchema,
  TestExecutionSchema,
  type ChangePassport,
  type Finding,
  type SourceLocation,
  type TestExecution,
} from "@codeatlas/evidence";
import { ExecutionResultSchema, type ExecutionResult } from "@codeatlas/runner";
import { canonicalize } from "json-canonicalize";
import { z } from "zod";

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

export type PassportOverallState =
  "ACTION_REQUIRED" | "INCOMPLETE" | "VERIFIED";

export interface PassportSummary {
  findings: {
    acceptedChanges: number;
    confirmedChanges: number;
    confirmedRegressions: number;
    possibleImpacts: number;
    probableImpacts: number;
    resolved: number;
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
  baseLocation: SourceLocation | null;
  headLocation: SourceLocation | null;
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
  runs: ExecutionResult[];
}

const SafeRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !/^[A-Za-z]:/u.test(value) &&
      !value.split(/[\\/]/u).includes(".."),
    "path must be repository-relative and traversal-free",
  );

const PassportChangedSymbolSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  path: SafeRelativePathSchema,
  baseLocation: SourceLocationSchema.nullable(),
  headLocation: SourceLocationSchema.nullable(),
  changedLines: z.array(z.number().int().positive()),
  signatureChanged: z.boolean(),
});

const PassportSummarySchema = z.strictObject({
  findings: z.strictObject({
    acceptedChanges: z.number().int().nonnegative(),
    confirmedChanges: z.number().int().nonnegative(),
    confirmedRegressions: z.number().int().nonnegative(),
    possibleImpacts: z.number().int().nonnegative(),
    probableImpacts: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    unverified: z.number().int().nonnegative(),
  }),
  runs: z.strictObject({
    base: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    head: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  tests: z.strictObject({
    executedOnBase: z.number().int().nonnegative(),
    executedOnHead: z.number().int().nonnegative(),
    generated: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});

export const BuiltChangePassportSchema = z
  .strictObject({
    baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
    headSha: z.string().regex(/^[0-9a-f]{40}$/u),
    engineVersion: z.string().min(1),
    findings: z.array(FindingSchema),
    executedTests: z.array(TestExecutionSchema),
    unverifiedAreas: z.array(z.string().min(1)),
    retentionPolicy: z.string().min(1),
    manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    overallState: z.enum(["ACTION_REQUIRED", "INCOMPLETE", "VERIFIED"]),
    summary: PassportSummarySchema,
    changedFiles: z.array(SafeRelativePathSchema),
    changedSymbols: z.array(PassportChangedSymbolSchema),
    evidenceIds: z.array(z.string().min(1)),
    replayCommands: z.array(z.string().min(1)),
    runs: z.array(ExecutionResultSchema),
  })
  .superRefine((passport, context) => {
    const core = coreProjection(passport);
    const coreResult = ChangePassportSchema.safeParse(core);
    if (!coreResult.success) {
      context.addIssue({
        code: "custom",
        message: "Built Passport does not satisfy the Change Passport schema",
      });
      return;
    }
    if (
      passport.runs.some(
        (run) =>
          run.snapshotSha !==
          (run.revision === "base" ? passport.baseSha : passport.headSha),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["runs"],
        message: "Execution result revision does not match the Passport",
      });
    }
    const expectedSummary = summarize(coreResult.data, passport.runs);
    const expectedState = deriveOverallState(
      expectedSummary,
      passport.unverifiedAreas,
      passport.runs,
    );
    const expectedChangedFiles = uniqueSorted(
      passport.changedSymbols.map(({ path }) => path),
    );
    const expectedEvidenceIds = uniqueSorted([
      ...passport.findings.flatMap(({ proofCard }) => proofCard.evidenceIds),
      ...passport.executedTests.flatMap(({ evidenceIds }) => evidenceIds),
    ]);
    const expectedReplayCommands = uniqueSorted(
      passport.findings.map(({ proofCard }) => proofCard.reproductionCommand),
    );
    let expectedTests: TestExecution[];
    let expectedSymbols: PassportChangedSymbol[];
    try {
      expectedTests = passport.executedTests
        .map((test) => deriveExecutionState(test, passport.runs))
        .sort((left, right) => compareText(left.id, right.id));
      expectedSymbols = passport.changedSymbols
        .map((symbol) =>
          validateChangedSymbol(symbol as ChangedSymbol, {
            baseSha: passport.baseSha,
            headSha: passport.headSha,
          }),
        )
        .sort(compareChangedSymbols);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Built Passport derived evidence is invalid",
      });
      return;
    }
    const expectedUnverifiedAreas = uniqueSorted([
      ...passport.unverifiedAreas,
      ...passport.findings
        .filter(({ state }) => state === "UNVERIFIED")
        .flatMap(({ proofCard }) => proofCard.limitations),
    ]);
    const derivedFields = [
      ["overallState", passport.overallState, expectedState],
      ["summary", passport.summary, expectedSummary],
      ["changedFiles", passport.changedFiles, expectedChangedFiles],
      ["changedSymbols", passport.changedSymbols, expectedSymbols],
      ["evidenceIds", passport.evidenceIds, expectedEvidenceIds],
      ["replayCommands", passport.replayCommands, expectedReplayCommands],
      ["executedTests", passport.executedTests, expectedTests],
      ["unverifiedAreas", passport.unverifiedAreas, expectedUnverifiedAreas],
    ] as const;
    for (const [field, actual, expected] of derivedFields) {
      if (canonicalize(actual) !== canonicalize(expected)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Built Passport ${field} is not derived from its evidence`,
        });
      }
    }
  });

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
    .map((symbol) => validateChangedSymbol(symbol, input))
    .sort(compareChangedSymbols);
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
  const overallState = deriveOverallState(summary, unverifiedAreas, runs);
  const evidenceIds = uniqueSorted([
    ...findings.flatMap(({ proofCard }) => proofCard.evidenceIds),
    ...tests.flatMap(({ evidenceIds: ids }) => ids),
  ]);
  const replayCommands = uniqueSorted(
    findings.map(({ proofCard }) => proofCard.reproductionCommand),
  );

  return deepFreeze(
    validateBuiltPassport({
      ...core,
      overallState,
      summary,
      changedFiles,
      changedSymbols,
      evidenceIds,
      replayCommands,
      runs,
    }),
  );
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
  return BuiltChangePassportSchema.parse(value) as BuiltChangePassport;
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
  const parsed = ExecutionResultSchema.parse(run);
  const expectedSha =
    parsed.revision === "base" ? input.baseSha : input.headSha;
  if (parsed.snapshotSha !== expectedSha) {
    throw new TypeError(
      "Execution result revision does not match the Passport",
    );
  }
  return structuredClone(parsed);
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

function validateChangedSymbol(
  value: ChangedSymbol,
  snapshots: Pick<BuildPassportInput, "baseSha" | "headSha">,
): PassportChangedSymbol {
  const parsed = PassportChangedSymbolSchema.parse(value);
  if (
    (parsed.baseLocation !== null &&
      (parsed.baseLocation.path !== parsed.path ||
        parsed.baseLocation.snapshotSha !== snapshots.baseSha)) ||
    (parsed.headLocation !== null &&
      (parsed.headLocation.path !== parsed.path ||
        parsed.headLocation.snapshotSha !== snapshots.headSha))
  ) {
    throw new TypeError(
      "Changed symbol source location does not match its path and snapshot",
    );
  }
  return {
    ...parsed,
    baseLocation:
      parsed.baseLocation === null ? null : { ...parsed.baseLocation },
    headLocation:
      parsed.headLocation === null ? null : { ...parsed.headLocation },
    changedLines: [...new Set(parsed.changedLines)].sort((a, b) => a - b),
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
      possibleImpacts: count("POSSIBLE_IMPACT"),
      probableImpacts: count("PROBABLE_IMPACT"),
      resolved: count("RESOLVED"),
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

function deriveOverallState(
  summary: PassportSummary,
  unverifiedAreas: readonly string[],
  runs: readonly ExecutionResult[],
): PassportOverallState {
  if (
    summary.findings.unverified > 0 ||
    unverifiedAreas.length > 0 ||
    runs.some(({ terminalState }) => terminalState !== "COMPLETED")
  ) {
    return "INCOMPLETE";
  }
  if (
    summary.findings.confirmedRegressions > 0 ||
    summary.findings.confirmedChanges > 0 ||
    summary.findings.probableImpacts > 0 ||
    summary.findings.possibleImpacts > 0
  ) {
    return "ACTION_REQUIRED";
  }
  return "VERIFIED";
}

function compareChangedSymbols(
  left: PassportChangedSymbol,
  right: PassportChangedSymbol,
): number {
  return (
    compareText(left.path, right.path) ||
    compareText(left.name, right.name) ||
    compareText(left.id, right.id)
  );
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
