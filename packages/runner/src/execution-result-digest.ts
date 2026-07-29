import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

import type { ExecutionResult } from "./execution-provider.js";

export type BoundExecutionResult = Omit<ExecutionResult, "resultDigest">;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export function computeExecutionResultDigest(
  result: BoundExecutionResult,
): string {
  const projected = projectBoundExecutionResult(result);
  if (projected === null) {
    throw new TypeError("Execution result does not match the digest schema.");
  }
  return `sha256:${createHash("sha256")
    .update(canonicalize(projected), "utf8")
    .digest("hex")}`;
}

export function hasValidExecutionResultBinding(
  value: unknown,
): value is ExecutionResult {
  if (!isRecord(value)) return false;
  if (
    typeof value.executionId !== "string" ||
    !UUID.test(value.executionId) ||
    typeof value.resultDigest !== "string" ||
    !SHA256.test(value.resultDigest)
  ) {
    return false;
  }
  try {
    return (
      value.resultDigest ===
      computeExecutionResultDigest(value as unknown as BoundExecutionResult)
    );
  } catch {
    return false;
  }
}

function projectBoundExecutionResult(
  value: unknown,
): BoundExecutionResult | null {
  if (!isRecord(value)) return null;
  const executionId = requiredString(value, "executionId");
  const revision = value.revision;
  const snapshotSha = requiredString(value, "snapshotSha");
  const terminalState = value.terminalState;
  const exitCode = value.exitCode;
  const durationMs = value.durationMs;
  const stdout = stringValue(value, "stdout");
  const stderr = stringValue(value, "stderr");
  const environmentDigest = requiredString(value, "environmentDigest");
  const testCases = projectArray(value.testCases, projectTestCase);
  const coverage = projectArray(value.coverage, projectCoverage);
  const observations = projectArray(value.observations, projectObservation);

  if (
    executionId === null ||
    !UUID.test(executionId) ||
    !isRevision(revision) ||
    snapshotSha === null ||
    !/^[0-9a-f]{40}$/u.test(snapshotSha) ||
    !isTerminalState(terminalState) ||
    (exitCode !== null && !Number.isInteger(exitCode)) ||
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    testCases === null ||
    coverage === null ||
    observations === null ||
    stdout === null ||
    stderr === null ||
    environmentDigest === null
  ) {
    return null;
  }

  return plainRecord({
    executionId,
    revision,
    snapshotSha,
    terminalState,
    exitCode: exitCode as number | null,
    durationMs,
    testCases,
    coverage,
    observations,
    stdout,
    stderr,
    environmentDigest,
  });
}

function projectTestCase(
  value: unknown,
): BoundExecutionResult["testCases"][number] | null {
  if (!isRecord(value)) return null;
  const name = requiredString(value, "name");
  const path = requiredString(value, "path");
  const status = value.status;
  const failureMessage = nullableString(value, "failureMessage");
  const generatedObjectiveId = nullableString(value, "generatedObjectiveId");
  if (
    name === null ||
    path === null ||
    !isTestStatus(status) ||
    failureMessage === undefined ||
    generatedObjectiveId === undefined
  ) {
    return null;
  }
  return plainRecord({
    name,
    path,
    status,
    failureMessage,
    generatedObjectiveId,
  });
}

function projectCoverage(
  value: unknown,
): BoundExecutionResult["coverage"][number] | null {
  if (!isRecord(value)) return null;
  const path = requiredString(value, "path");
  const coveredLines = projectIntegerArray(value.coveredLines);
  if (path === null || coveredLines === null) return null;
  return plainRecord({ path, coveredLines });
}

function projectObservation(
  value: unknown,
): BoundExecutionResult["observations"][number] | null {
  if (!isRecord(value)) return null;
  const testName = requiredString(value, "testName");
  const path = requiredString(value, "path");
  const generatedObjectiveId = nullableString(value, "generatedObjectiveId");
  const expected = projectBehavior(value.expected);
  const actual = projectBehavior(value.actual);
  if (
    testName === null ||
    path === null ||
    generatedObjectiveId === undefined ||
    value.source !== "TEST_ASSERTION" ||
    expected === null ||
    actual === null
  ) {
    return null;
  }
  return plainRecord({
    testName,
    path,
    generatedObjectiveId,
    source: "TEST_ASSERTION" as const,
    expected,
    actual,
  });
}

function projectBehavior(
  value: unknown,
): BoundExecutionResult["observations"][number]["actual"] | null {
  if (!isRecord(value)) return null;
  const httpStatus = value.httpStatus;
  const code = requiredString(value, "code");
  if (
    !Number.isInteger(httpStatus) ||
    (httpStatus as number) < 100 ||
    (httpStatus as number) > 599 ||
    code === null
  ) {
    return null;
  }
  return plainRecord({ httpStatus: httpStatus as number, code });
}

function projectArray<T>(
  value: unknown,
  project: (item: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value)) return null;
  const projected: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = project(value[index]);
    if (item === null) return null;
    projected.push(item);
  }
  return projected;
}

function projectIntegerArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const projected: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!Number.isInteger(item)) return null;
    projected.push(item as number);
  }
  return projected;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function stringValue(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function nullableString(
  value: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const field = value[key];
  return field === null || typeof field === "string" ? field : undefined;
}

function isTerminalState(
  value: unknown,
): value is BoundExecutionResult["terminalState"] {
  return (
    value === "COMPLETED" ||
    value === "TIMED_OUT" ||
    value === "OUTPUT_LIMIT" ||
    value === "FAILED"
  );
}

function isRevision(value: unknown): value is BoundExecutionResult["revision"] {
  return value === "base" || value === "head";
}

function isTestStatus(
  value: unknown,
): value is BoundExecutionResult["testCases"][number]["status"] {
  return value === "PASSED" || value === "FAILED" || value === "SKIPPED";
}

function plainRecord<T extends object>(value: T): T {
  return Object.assign(Object.create(null) as T, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
