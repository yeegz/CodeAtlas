import { expect, it } from "vitest";

import type { ChangedSymbol } from "../../analyzer/src/index.js";
import {
  ChangePassportSchema,
  type Finding,
  type TestExecution,
} from "../../evidence/src/index.js";
import {
  computeExecutionResultDigest,
  type ExecutionResult,
} from "../../runner/src/index.js";

import {
  buildPassport,
  passportToJson,
  passportToMarkdown,
  type BuildPassportInput,
} from "../src/index.js";
import * as PassportModule from "../src/index.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const manifestDigest = `sha256:${"d".repeat(64)}`;

it.each([
  "baseSha",
  "headSha",
  "engineVersion",
  "runs",
  "unverifiedAreas",
  "retentionPolicy",
  "manifestDigest",
] as const)("rejects a Passport without required %s evidence", (field) => {
  const invalid = { ...passportInput() } as Record<string, unknown>;
  delete invalid[field];

  expect(() =>
    buildPassport(invalid as unknown as BuildPassportInput),
  ).toThrow();
});

it("derives the fixture state and every summary count from validated evidence", () => {
  const input = passportInput();
  const passport = buildPassport(input);

  expect(passport.overallState).toBe("ACTION_REQUIRED");
  expect(passport.summary).toEqual({
    findings: {
      acceptedChanges: 0,
      confirmedChanges: 0,
      confirmedRegressions: 1,
      possibleImpacts: 0,
      probableImpacts: 0,
      resolved: 0,
      unverified: 0,
    },
    runs: { base: 3, completed: 6, head: 3, total: 6 },
    tests: {
      executedOnBase: 2,
      executedOnHead: 2,
      generated: 1,
      total: 2,
    },
  });
  expect(passport.findings[0]?.state).toBe("CONFIRMED_REGRESSION");
  expect(passport.executedTests).toContainEqual(
    expect.objectContaining({
      provenance: "GENERATED",
      executedOnBase: true,
      executedOnHead: true,
    }),
  );
  expect(passport.replayCommands).toEqual([
    "codeatlas replay finding_expired_session",
  ]);
  expect(
    ChangePassportSchema.parse({
      baseSha: passport.baseSha,
      headSha: passport.headSha,
      engineVersion: passport.engineVersion,
      findings: passport.findings,
      executedTests: passport.executedTests,
      unverifiedAreas: passport.unverifiedAreas,
      retentionPolicy: passport.retentionPolicy,
      manifestDigest: passport.manifestDigest,
    }),
  ).toEqual(
    expect.objectContaining({
      baseSha,
      headSha,
      manifestDigest,
    }),
  );
});

it("sorts canonical inventory and renders JSON and Markdown from that object", () => {
  const input = passportInput();
  input.changedSymbols = [input.changedSymbols[1]!, input.changedSymbols[0]!];
  input.tests = [input.tests[1]!, input.tests[0]!];
  input.findings = [
    unverifiedFinding("finding_z"),
    input.findings[0]!,
    unverifiedFinding("finding_a"),
  ];

  const passport = buildPassport(input);
  const json = passportToJson(passport);
  const markdown = passportToMarkdown(passport);

  expect(passport.changedFiles).toEqual(["src/auth.ts", "src/zeta.ts"]);
  expect(passport.changedSymbols.map(({ name }) => name)).toEqual([
    "validateToken",
    "zeta",
  ]);
  expect(passport.executedTests.map(({ id }) => id)).toEqual([
    "generated_expired_session",
    "test_auth",
  ]);
  expect(passport.findings.map(({ id }) => id)).toEqual([
    "finding_a",
    "finding_expired_session",
    "finding_z",
  ]);
  expect(passport.evidenceIds).toEqual(["ev:differential", "ev:static"]);
  expect(JSON.parse(json)).toEqual(passport);
  expect(markdown).toContain("Overall state: ACTION_REQUIRED");
  expect(markdown).toContain("codeatlas replay finding_expired_session");
  expect(markdown).toContain(manifestDigest);
});

it("does not accept caller-provided totals or state overrides", () => {
  const invalid = {
    ...passportInput(),
    overallState: "VERIFIED",
    summary: { findings: { confirmedRegressions: 0 } },
  };

  expect(() => buildPassport(invalid as unknown as BuildPassportInput)).toThrow(
    /caller-provided|unknown/i,
  );
});

it.each([
  ["PROBABLE_IMPACT", "probableImpacts"],
  ["POSSIBLE_IMPACT", "possibleImpacts"],
] as const)(
  "requires action for a %s finding and counts it explicitly",
  (state, countName) => {
    const input = passportInput();
    input.findings = [{ ...confirmedFinding(), state }];

    const passport = buildPassport(input);

    expect(passport.overallState).toBe("ACTION_REQUIRED");
    expect(passport.summary.findings[countName]).toBe(1);
  },
);

it("marks incomplete evidence as INCOMPLETE instead of verified", () => {
  const input = passportInput();
  input.findings = [unverifiedFinding("finding_unverified")];

  const passport = buildPassport(input);

  expect(passport.overallState).toBe("INCOMPLETE");
  expect(passport.summary.findings.unverified).toBe(1);
});

it("counts every shared FindingState in the derived summary", () => {
  const input = passportInput();
  input.findings = [
    { ...confirmedFinding(), id: "confirmed-regression" },
    {
      ...confirmedFinding(),
      id: "confirmed-change",
      state: "CONFIRMED_CHANGE",
    },
    {
      ...confirmedFinding(),
      id: "probable-impact",
      state: "PROBABLE_IMPACT",
    },
    {
      ...confirmedFinding(),
      id: "possible-impact",
      state: "POSSIBLE_IMPACT",
    },
    unverifiedFinding("unverified"),
    { ...confirmedFinding(), id: "resolved", state: "RESOLVED" },
    {
      ...confirmedFinding(),
      id: "accepted",
      state: "ACCEPTED_CHANGE",
    },
  ];

  expect(buildPassport(input).summary.findings).toEqual({
    acceptedChanges: 1,
    confirmedChanges: 1,
    confirmedRegressions: 1,
    possibleImpacts: 1,
    probableImpacts: 1,
    resolved: 1,
    unverified: 1,
  });
});

it.each([
  {
    name: "overall state",
    mutate(value: Record<string, unknown>) {
      value.overallState = "VERIFIED";
    },
  },
  {
    name: "summary count",
    mutate(value: Record<string, unknown>) {
      const summary = value.summary as {
        findings: { confirmedRegressions: number };
      };
      summary.findings.confirmedRegressions = 0;
    },
  },
  {
    name: "file inventory",
    mutate(value: Record<string, unknown>) {
      value.changedFiles = ["src/invented.ts"];
    },
  },
  {
    name: "evidence inventory",
    mutate(value: Record<string, unknown>) {
      value.evidenceIds = ["ev:invented"];
    },
  },
  {
    name: "replay inventory",
    mutate(value: Record<string, unknown>) {
      value.replayCommands = ["codeatlas replay invented"];
    },
  },
  {
    name: "unknown field",
    mutate(value: Record<string, unknown>) {
      value.callerSummary = { safe: true };
    },
  },
])("exporters reject a caller-fabricated $name", ({ mutate }) => {
  const fabricated = structuredClone(
    buildPassport(passportInput()),
  ) as unknown as Record<string, unknown>;
  mutate(fabricated);

  expect(() => passportToJson(fabricated as never)).toThrow();
  expect(() => passportToMarkdown(fabricated as never)).toThrow();
});

it.each([
  {
    name: "traversal path",
    mutate(symbol: Record<string, unknown>) {
      symbol.path = "../escape.ts";
    },
  },
  {
    name: "mismatched base source path",
    mutate(symbol: Record<string, unknown>) {
      (symbol.baseLocation as Record<string, unknown>).path = "src/other.ts";
    },
  },
  {
    name: "malformed source SHA",
    mutate(symbol: Record<string, unknown>) {
      (symbol.headLocation as Record<string, unknown>).snapshotSha = "head";
    },
  },
  {
    name: "non-boolean signature flag",
    mutate(symbol: Record<string, unknown>) {
      symbol.signatureChanged = "false";
    },
  },
])("rejects a ChangedSymbol with a $name", ({ mutate }) => {
  const input = passportInput();
  const symbol = structuredClone(input.changedSymbols[0]!) as unknown as Record<
    string,
    unknown
  >;
  mutate(symbol);
  input.changedSymbols = [symbol as unknown as ChangedSymbol];

  expect(() => buildPassport(input)).toThrow(/changed symbol|source|path/i);
});

it("exports a strict complete BuiltChangePassport runtime schema", () => {
  expect("BuiltChangePassportSchema" in PassportModule).toBe(true);
  const schema = (
    PassportModule as unknown as {
      BuiltChangePassportSchema: {
        safeParse(value: unknown): { success: boolean };
      };
    }
  ).BuiltChangePassportSchema;
  expect(schema.safeParse(buildPassport(passportInput())).success).toBe(true);
  expect(
    schema.safeParse({ ...buildPassport(passportInput()), unknown: true })
      .success,
  ).toBe(false);
});

function passportInput(): BuildPassportInput & {
  changedSymbols: ChangedSymbol[];
  findings: Finding[];
  runs: ExecutionResult[];
  tests: TestExecution[];
} {
  const changedSymbols: ChangedSymbol[] = [
    changedSymbol("symbol_validate", "validateToken", "src/auth.ts", 14),
    changedSymbol("symbol_zeta", "zeta", "src/zeta.ts", 3),
  ];
  const tests: TestExecution[] = [
    {
      id: "test_auth",
      command: "pnpm vitest run test/auth.test.ts",
      provenance: "EXISTING",
      executedOnBase: true,
      executedOnHead: true,
      evidenceIds: ["ev:static"],
    },
    {
      id: "generated_expired_session",
      command: "pnpm vitest run test/codeatlas.expired-session.test.ts",
      provenance: "GENERATED",
      executedOnBase: true,
      executedOnHead: true,
      evidenceIds: ["ev:differential"],
    },
  ];
  return {
    baseSha,
    headSha,
    engineVersion: "0.1.0",
    findings: [confirmedFinding()],
    runs: [0, 1, 2].flatMap((repeat) => [
      execution("base", repeat),
      execution("head", repeat),
    ]),
    tests,
    changedSymbols,
    unverifiedAreas: [],
    retentionPolicy: "7 days",
    manifestDigest,
  };
}

function confirmedFinding(): Finding {
  return {
    id: "finding_expired_session",
    state: "CONFIRMED_REGRESSION",
    title: "Expired sessions return an internal error",
    summary: "HTTP 401 changed to HTTP 500.",
    graphPath: "restoreSession → validateToken",
    confidence: {
      level: "HIGH",
      factors: ["DIFFERENTIAL_EXECUTION", "REPEATABLE_3_OF_3"],
    },
    proofCard: {
      baseBehavior: "HTTP 401 with SESSION_EXPIRED",
      headBehavior: "HTTP 500 with INTERNAL_ERROR",
      evidenceIds: ["ev:differential", "ev:static"],
      affectedJourney:
        "Returning user → Restore session → Validate expired token",
      reproductionCommand: "codeatlas replay finding_expired_session",
      recommendedAction: "Restore the expiration guard.",
      limitations: [],
    },
    evidence: [
      {
        id: "ev:differential",
        type: "DIFFERENTIAL_EXECUTION",
        reproducibility: "REPRODUCIBLE",
        baseSha,
        headSha,
        executions: { base: 3, head: 3 },
        testExecutionId: "generated_expired_session",
      },
      {
        id: "ev:static",
        type: "STATIC_CALLGRAPH",
        reproducibility: "REPRODUCIBLE",
        baseSha,
        headSha,
        executions: { base: 0, head: 0 },
      },
    ],
  };
}

function unverifiedFinding(id: string): Finding {
  return {
    id,
    state: "UNVERIFIED",
    title: "Unverified path",
    summary: "A path remains unverified.",
    proofCard: {
      baseBehavior: "Not observed",
      headBehavior: "Not observed",
      evidenceIds: [],
      affectedJourney: "Unknown",
      reproductionCommand: `codeatlas replay ${id}`,
      recommendedAction: "Run the missing path.",
      limitations: ["The path was not executed."],
    },
    evidence: [],
  };
}

function changedSymbol(
  id: string,
  name: string,
  path: string,
  line: number,
): ChangedSymbol {
  return {
    id,
    name,
    path,
    baseLocation: {
      snapshotSha: baseSha,
      path,
      startLine: line,
      endLine: line,
    },
    headLocation: {
      snapshotSha: headSha,
      path,
      startLine: line,
      endLine: line,
    },
    changedLines: [line],
    signatureChanged: false,
  };
}

function execution(revision: "base" | "head", repeat: number): ExecutionResult {
  const result = {
    executionId: `00000000-0000-4000-${revision === "base" ? "8" : "9"}000-${String(repeat + 1).padStart(12, "0")}`,
    revision,
    snapshotSha: revision === "base" ? baseSha : headSha,
    terminalState: "COMPLETED" as const,
    exitCode: revision === "base" ? 0 : 1,
    durationMs: 10,
    testCases: [
      {
        name: "restoreSession restores a valid session",
        path: "test/auth.test.ts",
        status: "PASSED" as const,
        failureMessage: null,
        generatedObjectiveId: null,
      },
      {
        name: "generated: expired session regression",
        path: "test/codeatlas.expired-session.test.ts",
        status: revision === "base" ? ("PASSED" as const) : ("FAILED" as const),
        failureMessage: revision === "base" ? null : "assertion failed",
        generatedObjectiveId: "objective_expired_session",
      },
    ],
    coverage: [],
    observations: [],
    stdout: "",
    stderr: "",
    environmentDigest: "environment",
  };
  return { ...result, resultDigest: computeExecutionResultDigest(result) };
}
