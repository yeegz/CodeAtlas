import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExecutionRequest,
  ExecutionResult,
} from "./execution-provider.js";

interface ParseOptions {
  temporaryRoot: string;
  generatedFiles: ExecutionRequest["generatedFiles"];
}

export interface ParsedVitestResult {
  valid: boolean;
  testCases: ExecutionResult["testCases"];
  coverage: ExecutionResult["coverage"];
  observations: ExecutionResult["observations"];
}

type UnknownRecord = Record<string, unknown>;

export function parseVitestResult(
  raw: string,
  options: ParseOptions,
): ParsedVitestResult {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return emptyResult();
  }

  if (!isRecord(document) || !Array.isArray(document.testResults))
    return emptyResult();

  const generated = new Map(
    options.generatedFiles.map(
      (file) => [normalizeRelative(file.path), file] as const,
    ),
  );
  const testCases: ExecutionResult["testCases"] = [];
  const observations: ExecutionResult["observations"] = [];

  for (const testFile of document.testResults) {
    if (!isRecord(testFile) || typeof testFile.name !== "string")
      return emptyResult();
    const path = repositoryRelativePath(options.temporaryRoot, testFile.name);
    if (path === null || !Array.isArray(testFile.assertionResults))
      return emptyResult();

    for (const assertion of testFile.assertionResults) {
      if (!isRecord(assertion)) return emptyResult();
      const name =
        stringField(assertion, "fullName") ?? stringField(assertion, "title");
      const status = parseStatus(assertion.status);
      if (name === null || status === null) return emptyResult();

      const failureMessages = Array.isArray(assertion.failureMessages)
        ? assertion.failureMessages.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const generatedFile = generated.get(path);
      testCases.push({
        name,
        path,
        status,
        failureMessage:
          failureMessages.length === 0 ? null : failureMessages.join("\n"),
        generatedObjectiveId: generatedFile?.objectiveId ?? null,
      });

      if (generatedFile !== undefined) {
        const actual =
          status === "PASSED"
            ? generatedFile.expectedBehavior
            : parseActualBehavior(failureMessages.join("\n"));
        if (actual !== null) {
          observations.push({
            testName: name,
            source: "TEST_ASSERTION",
            expected: generatedFile.expectedBehavior,
            actual,
          });
        }
      }
    }
  }

  const coverage = parseCoverage(document.coverageMap, options.temporaryRoot);
  if (coverage === null) return emptyResult();
  return { valid: true, testCases, coverage, observations };
}

function parseCoverage(
  value: unknown,
  temporaryRoot: string,
): ExecutionResult["coverage"] | null {
  if (value === undefined) return [];
  if (!isRecord(value)) return null;
  const coverage: ExecutionResult["coverage"] = [];

  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) return null;
    const sourcePath = typeof entry.path === "string" ? entry.path : key;
    const path = repositoryRelativePath(temporaryRoot, sourcePath);
    if (path === null || !isRecord(entry.statementMap) || !isRecord(entry.s))
      return null;
    const lines = new Set<number>();
    for (const [statementId, count] of Object.entries(entry.s)) {
      if (typeof count !== "number" || count <= 0) continue;
      const statement = entry.statementMap[statementId];
      if (!isRecord(statement) || !isRecord(statement.start)) return null;
      const line = statement.start.line;
      if (typeof line !== "number" || !Number.isInteger(line) || line < 1)
        return null;
      lines.add(line);
    }
    coverage.push({
      path,
      coveredLines: [...lines].sort((left, right) => left - right),
    });
  }
  return coverage.sort((left, right) => left.path.localeCompare(right.path));
}

function repositoryRelativePath(
  root: string,
  candidate: string,
): string | null {
  if (!isAbsolute(candidate)) return null;
  const resolved = resolve(candidate);
  const result = relative(root, resolved);
  if (
    result === "" ||
    result === ".." ||
    result.startsWith(`..${sep}`) ||
    isAbsolute(result)
  ) {
    return null;
  }
  return normalizeRelative(result);
}

function normalizeRelative(path: string): string {
  return path.split(sep).join("/");
}

function parseStatus(value: unknown): "PASSED" | "FAILED" | "SKIPPED" | null {
  if (value === "passed") return "PASSED";
  if (value === "failed") return "FAILED";
  if (
    value === "pending" ||
    value === "skipped" ||
    value === "todo" ||
    value === "disabled"
  ) {
    return "SKIPPED";
  }
  return null;
}

function parseActualBehavior(
  message: string,
): { httpStatus: number; code: string } | null {
  const assertion =
    /expected\s+(\{[^\n]*\})\s+to\s+(?:deeply\s+)?(?:equal|be)\s+(\{[^\n]*\})/iu.exec(
      message,
    );
  if (assertion?.[1] !== undefined) {
    const behavior = parseSerializedBehavior(assertion[1]);
    if (behavior !== null) return behavior;
  }

  const jsonCandidates = [
    ...message.matchAll(/(?:Received|Actual):\s*(\{[^\n]*\})/giu),
    ...message.matchAll(/^\+\s*(\{[^\n]*\})$/gmu),
  ];
  for (const match of jsonCandidates) {
    if (match[1] === undefined) continue;
    try {
      const behavior = findBehavior(JSON.parse(match[1]));
      if (behavior !== null) return behavior;
    } catch {
      // A serialized assertion value is optional evidence, never a reason to fabricate one.
    }
  }
  return null;
}

function parseSerializedBehavior(
  value: string,
): { httpStatus: number; code: string } | null {
  const status = /(?:httpStatus|status)\s*:\s*(-?\d+)/iu.exec(value)?.[1];
  const code = /code\s*:\s*(["'])(.*?)\1/iu.exec(value)?.[2];
  if (status === undefined || code === undefined) return null;
  const httpStatus = Number(status);
  return Number.isInteger(httpStatus) ? { httpStatus, code } : null;
}

function findBehavior(
  value: unknown,
): { httpStatus: number; code: string } | null {
  if (!isRecord(value)) return null;
  const status = value.httpStatus ?? value.status;
  const code = value.code;
  if (
    typeof status === "number" &&
    Number.isInteger(status) &&
    typeof code === "string"
  ) {
    return { httpStatus: status, code };
  }
  for (const nested of Object.values(value)) {
    const found = findBehavior(nested);
    if (found !== null) return found;
  }
  return null;
}

function stringField(value: UnknownRecord, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyResult(): ParsedVitestResult {
  return { valid: false, testCases: [], coverage: [], observations: [] };
}
