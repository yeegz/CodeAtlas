import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExecutionRequest,
  ExecutionResult,
} from "./execution-provider.js";

interface ParseOptions {
  snapshotRoot: string;
  requestedTestPaths: string[];
  generatedFiles: ExecutionRequest["generatedFiles"];
  allowedCoverage: ReadonlyMap<string, number>;
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
  const fallback = unexecutedResult(options.generatedFiles);
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!isRecord(document) || !Array.isArray(document.testResults))
    return fallback;

  const requested = new Set(options.requestedTestPaths);
  const generated = new Map(
    options.generatedFiles.map((file) => [normalizeRelative(file.path), file]),
  );
  const reported = new Set<string>();
  const testCases: ExecutionResult["testCases"] = [];
  const observations: ExecutionResult["observations"] = [];
  let structurallyValid = true;

  for (const testFile of document.testResults) {
    if (!isRecord(testFile) || typeof testFile.name !== "string") {
      structurallyValid = false;
      continue;
    }
    const path = repositoryRelativePath(options.snapshotRoot, testFile.name);
    if (
      path === null ||
      !requested.has(path) ||
      reported.has(path) ||
      !Array.isArray(testFile.assertionResults) ||
      testFile.assertionResults.length === 0
    ) {
      structurallyValid = false;
      continue;
    }
    reported.add(path);

    for (const assertion of testFile.assertionResults) {
      if (!isRecord(assertion)) {
        structurallyValid = false;
        continue;
      }
      const name =
        stringField(assertion, "fullName") ?? stringField(assertion, "title");
      const status = parseStatus(assertion.status);
      if (
        name === null ||
        status === null ||
        !Array.isArray(assertion.failureMessages) ||
        !assertion.failureMessages.every((value) => typeof value === "string")
      ) {
        structurallyValid = false;
        continue;
      }

      const failureMessages = assertion.failureMessages as string[];
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

  for (const file of options.generatedFiles) {
    const path = normalizeRelative(file.path);
    if (!reported.has(path)) testCases.push(unexecutedGeneratedTest(file));
  }

  const exactRequestedSet =
    requested.size > 0 &&
    reported.size === requested.size &&
    [...requested].every((path) => reported.has(path));
  const coverage = parseCoverage(
    document.coverageMap,
    options.snapshotRoot,
    options.allowedCoverage,
  );
  const valid = structurallyValid && exactRequestedSet && coverage !== null;
  return {
    valid,
    testCases,
    coverage: valid ? coverage : [],
    observations: valid ? observations : [],
  };
}

export function unexecutedGeneratedTests(
  generatedFiles: ExecutionRequest["generatedFiles"],
): ExecutionResult["testCases"] {
  return generatedFiles.map(unexecutedGeneratedTest);
}

function unexecutedResult(
  generatedFiles: ExecutionRequest["generatedFiles"],
): ParsedVitestResult {
  return {
    valid: false,
    testCases: unexecutedGeneratedTests(generatedFiles),
    coverage: [],
    observations: [],
  };
}

function unexecutedGeneratedTest(
  file: ExecutionRequest["generatedFiles"][number],
): ExecutionResult["testCases"][number] {
  const path = normalizeRelative(file.path);
  return {
    name: `Unexecuted generated test: ${path}`,
    path,
    status: "SKIPPED",
    failureMessage: null,
    generatedObjectiveId: file.objectiveId,
  };
}

function parseCoverage(
  value: unknown,
  snapshotRoot: string,
  allowedCoverage: ReadonlyMap<string, number>,
): ExecutionResult["coverage"] | null {
  if (value === undefined) return [];
  if (!isRecord(value)) return null;
  const coverage: ExecutionResult["coverage"] = [];

  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) return null;
    const sourcePath = typeof entry.path === "string" ? entry.path : key;
    const path = repositoryRelativePath(snapshotRoot, sourcePath);
    const maxLine = path === null ? undefined : allowedCoverage.get(path);
    if (
      path === null ||
      maxLine === undefined ||
      !isRecord(entry.statementMap) ||
      !isRecord(entry.s)
    ) {
      return null;
    }
    const lines = new Set<number>();
    for (const [statementId, count] of Object.entries(entry.s)) {
      if (typeof count !== "number") return null;
      if (count <= 0) continue;
      const statement = entry.statementMap[statementId];
      if (!isRecord(statement) || !isRecord(statement.start)) return null;
      const line = statement.start.line;
      if (
        typeof line !== "number" ||
        !Number.isInteger(line) ||
        line < 1 ||
        line > maxLine
      ) {
        return null;
      }
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
    /^AssertionError:\s+expected\s+(\{[^\n]*\})\s+to\s+(?:deeply\s+)?(?:equal|be)\s+(\{[^\n]*\})/u.exec(
      message,
    );
  return assertion?.[1] === undefined
    ? null
    : parseSerializedBehavior(assertion[1]);
}

function parseSerializedBehavior(
  value: string,
): { httpStatus: number; code: string } | null {
  const status = /(?:httpStatus|status)\s*:\s*(-?\d+)/u.exec(value)?.[1];
  const code = /code\s*:\s*(["'])(.*?)\1/u.exec(value)?.[2];
  if (status === undefined || code === undefined) return null;
  const httpStatus = Number(status);
  return Number.isInteger(httpStatus) ? { httpStatus, code } : null;
}

function stringField(value: UnknownRecord, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
