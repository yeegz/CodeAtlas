import { isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type {
  ExecutionRequest,
  ExecutionResult,
} from "./execution-provider.js";

interface ParseOptions {
  snapshotRoot: string;
  requestedTestPaths: string[];
  generatedFiles: ExecutionRequest["generatedFiles"];
  allowedCoverage: ReadonlyMap<string, number>;
  coverageArtifact: string;
  exitCode: 0 | 1;
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
  const generatedAssertions = new Map(
    options.generatedFiles.map((file) => [
      normalizeRelative(file.path),
      validateGeneratedAssertion(file),
    ]),
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
    if (
      generatedAssertions.get(path)?.kind === "valid" &&
      testFile.assertionResults.length !== 1
    ) {
      structurallyValid = false;
    }

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
      const generatedValidation = generatedAssertions.get(path);
      if (generatedValidation?.kind === "invalid-provenance")
        structurallyValid = false;
      const generatedAssertion =
        generatedValidation?.kind === "valid"
          ? generatedValidation.assertion
          : null;
      testCases.push({
        name,
        path,
        status,
        failureMessage:
          failureMessages.length === 0 ? null : failureMessages.join("\n"),
        generatedObjectiveId: generatedFile?.objectiveId ?? null,
      });

      if (
        generatedFile !== undefined &&
        generatedAssertion !== null &&
        stringField(assertion, "title") === generatedAssertion.testName
      ) {
        const actual =
          status === "PASSED"
            ? generatedFile.expectedBehavior
            : parseActualBehavior(assertion, failureMessages.join("\n"), {
                path,
                line: generatedAssertion.line,
                column: generatedAssertion.column,
                expected: generatedFile.expectedBehavior,
              });
        if (actual !== null) {
          observations.push({
            testName: name,
            path,
            generatedObjectiveId: generatedFile.objectiveId,
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
  let artifactDocument: unknown;
  try {
    artifactDocument = JSON.parse(options.coverageArtifact);
  } catch {
    artifactDocument = null;
  }
  const artifactCoverage = parseCoverage(
    artifactDocument,
    options.snapshotRoot,
    options.allowedCoverage,
  );
  const reporterCoverage =
    document.coverageMap === undefined
      ? artifactCoverage
      : parseCoverage(
          document.coverageMap,
          options.snapshotRoot,
          options.allowedCoverage,
        );
  const coverageIsConsistent =
    artifactCoverage !== null &&
    reporterCoverage !== null &&
    JSON.stringify(reporterCoverage) === JSON.stringify(artifactCoverage);
  const hasFailedCase = testCases.some(({ status }) => status === "FAILED");
  const exitCodeIsConsistent =
    options.exitCode === 0 ? !hasFailedCase : hasFailedCase;
  const valid =
    structurallyValid &&
    exactRequestedSet &&
    coverageIsConsistent &&
    exitCodeIsConsistent;
  return {
    valid,
    testCases,
    coverage: valid && artifactCoverage !== null ? artifactCoverage : [],
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
    if (path === null || maxLine === undefined) {
      return null;
    }
    const lines = new Set<number>();
    if (
      !addCoveredLocations(lines, entry.statementMap, entry.s, maxLine, false)
    )
      return null;
    const hasFunctionMap = entry.fnMap !== undefined;
    const hasFunctionCounts = entry.f !== undefined;
    if (hasFunctionMap !== hasFunctionCounts) return null;
    if (
      hasFunctionMap &&
      !addCoveredLocations(lines, entry.fnMap, entry.f, maxLine, true)
    )
      return null;
    coverage.push({
      path,
      coveredLines: [...lines].sort((left, right) => left - right),
    });
  }
  return coverage.sort((left, right) => left.path.localeCompare(right.path));
}

function addCoveredLocations(
  lines: Set<number>,
  mapValue: unknown,
  countValue: unknown,
  maxLine: number,
  functionMap: boolean,
): boolean {
  if (!isRecord(mapValue) || !isRecord(countValue)) return false;
  const mapIds = Object.keys(mapValue).sort();
  const countIds = Object.keys(countValue).sort();
  if (JSON.stringify(mapIds) !== JSON.stringify(countIds)) return false;
  for (const id of mapIds) {
    const count = countValue[id];
    const mapped = mapValue[id];
    if (
      typeof count !== "number" ||
      !Number.isFinite(count) ||
      count < 0 ||
      !isRecord(mapped)
    ) {
      return false;
    }
    const location = functionMap ? mapped.loc : mapped;
    if (!isRecord(location) || !isRecord(location.start)) return false;
    const line = location.start.line;
    if (
      typeof line !== "number" ||
      !Number.isInteger(line) ||
      line < 1 ||
      line > maxLine
    ) {
      return false;
    }
    if (count > 0) lines.add(line);
  }
  return true;
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
  assertionResult: UnknownRecord,
  _message: string,
  binding: {
    path: string;
    line: number;
    column: number;
    expected: { httpStatus: number; code: string };
  },
): { httpStatus: number; code: string } | null {
  return parseStructuredActualBehavior(assertionResult, binding);
}

function parseStructuredActualBehavior(
  assertionResult: UnknownRecord,
  binding: {
    path: string;
    line: number;
    column: number;
    expected: { httpStatus: number; code: string };
  },
): { httpStatus: number; code: string } | null {
  const details = assertionResult.failureDetails;
  if (!Array.isArray(details) || details.length !== 1) return null;
  const detail = details[0];
  if (
    !isRecord(detail) ||
    detail.assertionAuthentic !== true ||
    typeof detail.stack !== "string" ||
    !failureBindsToAssertion(
      detail.stack,
      binding.path,
      binding.line,
      binding.column,
    )
  ) {
    return null;
  }
  const actual = behaviorValue(detail.actual);
  const expected = behaviorValue(detail.expected);
  return actual !== null &&
    expected?.httpStatus === binding.expected.httpStatus &&
    expected.code === binding.expected.code
    ? actual
    : null;
}

function behaviorValue(
  value: unknown,
): { httpStatus: number; code: string } | null {
  if (typeof value === "string") return parseSerializedBehavior(value);
  if (!isRecord(value) || Object.keys(value).length !== 2) return null;
  return typeof value.httpStatus === "number" &&
    Number.isFinite(value.httpStatus) &&
    typeof value.code === "string"
    ? { httpStatus: value.httpStatus, code: value.code }
    : null;
}

interface GeneratedAssertion {
  testName: string;
  line: number;
  column: number;
}

interface DirectGeneratedTest {
  testCall: ts.CallExpression;
  wrapperCallback: ts.ArrowFunction | ts.FunctionExpression | null;
}

type GeneratedAssertionValidation =
  | { kind: "valid"; assertion: GeneratedAssertion }
  | { kind: "invalid-provenance" }
  | { kind: "unsupported" };

export const CANONICAL_GENERATED_TEST_PATH =
  "test/codeatlas.expired-session.test.ts";
export const CANONICAL_GENERATED_TEST_CONTENT = `import { describe, expect, it } from "vitest";
import { restoreSession } from "../src/auth.js";

describe("generated: expired session regression", () => {
  it("returns SESSION_EXPIRED for a non-refreshable expired token", () => {
    const response = restoreSession({ subject: null, expiresAt: 50, refreshable: false }, 100);
    expect({
      httpStatus: response.status,
      code: "code" in response.body ? response.body.code : null,
    }).toEqual({ httpStatus: 401, code: "SESSION_EXPIRED" });
  });
});
`;

export function requiresStructuredReporter(
  files: ExecutionRequest["generatedFiles"],
): boolean {
  return files.some(
    (file) => validateGeneratedAssertion(file).kind === "valid",
  );
}

function validateGeneratedAssertion(
  file: ExecutionRequest["generatedFiles"][number],
): GeneratedAssertionValidation {
  if (
    file.path !== CANONICAL_GENERATED_TEST_PATH ||
    file.content !== CANONICAL_GENERATED_TEST_CONTENT ||
    file.objectiveId.length === 0 ||
    file.evidenceIds.length === 0 ||
    file.evidenceIds.some((id) => id.length === 0) ||
    file.expectedBehavior.httpStatus !== 401 ||
    file.expectedBehavior.code !== "SESSION_EXPIRED"
  ) {
    return { kind: "unsupported" };
  }
  const source = ts.createSourceFile(
    file.path,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const executableStatements = source.statements.filter(
    (statement) => !ts.isImportDeclaration(statement),
  );
  if (executableStatements.length !== 1) return { kind: "unsupported" };
  const testStatement = executableStatements[0];
  if (testStatement === undefined || !ts.isExpressionStatement(testStatement))
    return { kind: "unsupported" };
  const directTest = directGeneratedTest(testStatement.expression);
  if (directTest === null) return { kind: "unsupported" };
  const { testCall, wrapperCallback } = directTest;
  if (
    !ts.isIdentifier(testCall.expression) ||
    (testCall.expression.text !== "it" &&
      testCall.expression.text !== "test") ||
    testCall.arguments.length !== 2
  ) {
    return { kind: "unsupported" };
  }
  const [nameArgument, callbackArgument] = testCall.arguments;
  if (
    nameArgument === undefined ||
    !ts.isStringLiteral(nameArgument) ||
    callbackArgument === undefined ||
    (!ts.isArrowFunction(callbackArgument) &&
      !ts.isFunctionExpression(callbackArgument)) ||
    !ts.isBlock(callbackArgument.body) ||
    callbackArgument.body.statements.length !== 2
  ) {
    return { kind: "unsupported" };
  }
  const [responseStatement, assertionStatement] =
    callbackArgument.body.statements;
  if (
    responseStatement === undefined ||
    !isResponseDeclaration(responseStatement) ||
    assertionStatement === undefined ||
    !ts.isExpressionStatement(assertionStatement)
  ) {
    return { kind: "unsupported" };
  }
  const assertionCall = assertionStatement.expression;
  if (
    !ts.isCallExpression(assertionCall) ||
    assertionCall.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(assertionCall.expression) ||
    assertionCall.expression.name.text !== "toEqual"
  ) {
    return { kind: "unsupported" };
  }
  const expectCall = assertionCall.expression.expression;
  const expectedObject = assertionCall.arguments[0];
  if (
    !ts.isCallExpression(expectCall) ||
    !ts.isIdentifier(expectCall.expression) ||
    expectCall.expression.text !== "expect" ||
    expectCall.arguments.length !== 1 ||
    expectedObject === undefined ||
    !ts.isObjectLiteralExpression(expectedObject) ||
    !isObservedObject(expectCall.arguments[0]) ||
    !isExpectedObject(expectedObject, file.expectedBehavior)
  ) {
    return { kind: "unsupported" };
  }
  if (
    callbackArgument.parameters.length !== 0 ||
    (wrapperCallback !== null && wrapperCallback.parameters.length !== 0) ||
    !hasDirectVitestImports(
      source,
      testCall.expression.text,
      wrapperCallback !== null,
    )
  )
    return { kind: "invalid-provenance" };
  const { line, character } = source.getLineAndCharacterOfPosition(
    assertionCall.expression.name.getStart(source),
  );
  return {
    kind: "valid",
    assertion: {
      testName: nameArgument.text,
      line: line + 1,
      column: character + 1,
    },
  };
}

function directGeneratedTest(
  expression: ts.Expression,
): DirectGeneratedTest | null {
  if (!ts.isCallExpression(expression)) return null;
  if (
    ts.isIdentifier(expression.expression) &&
    (expression.expression.text === "it" ||
      expression.expression.text === "test")
  ) {
    return { testCall: expression, wrapperCallback: null };
  }
  if (
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "describe" ||
    expression.arguments.length !== 2
  ) {
    return null;
  }
  const [nameArgument, callbackArgument] = expression.arguments;
  if (
    nameArgument === undefined ||
    !ts.isStringLiteral(nameArgument) ||
    callbackArgument === undefined ||
    (!ts.isArrowFunction(callbackArgument) &&
      !ts.isFunctionExpression(callbackArgument)) ||
    !ts.isBlock(callbackArgument.body) ||
    callbackArgument.body.statements.length !== 1
  ) {
    return null;
  }
  const innerStatement = callbackArgument.body.statements[0];
  if (
    innerStatement === undefined ||
    !ts.isExpressionStatement(innerStatement) ||
    !ts.isCallExpression(innerStatement.expression) ||
    !ts.isIdentifier(innerStatement.expression.expression) ||
    (innerStatement.expression.expression.text !== "it" &&
      innerStatement.expression.expression.text !== "test")
  ) {
    return null;
  }
  return {
    testCall: innerStatement.expression,
    wrapperCallback: callbackArgument,
  };
}

function hasDirectVitestImports(
  source: ts.SourceFile,
  testIdentifier: "it" | "test",
  usesDescribe: boolean,
): boolean {
  const requiredImports = new Map<string, number>([
    ["expect", 0],
    [testIdentifier, 0],
  ]);
  if (usesDescribe) requiredImports.set("describe", 0);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (statement.importClause?.isTypeOnly === true) continue;
    const moduleName = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : null;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      if (requiredImports.has(bindings.name.text)) return false;
      continue;
    }
    for (const specifier of bindings.elements) {
      if (specifier.isTypeOnly) continue;
      const localName = specifier.name.text;
      if (!requiredImports.has(localName)) continue;
      const importedName = specifier.propertyName?.text ?? localName;
      if (
        moduleName !== "vitest" ||
        specifier.propertyName !== undefined ||
        importedName !== localName
      ) {
        return false;
      }
      requiredImports.set(localName, (requiredImports.get(localName) ?? 0) + 1);
    }
  }
  return [...requiredImports.values()].every((count) => count === 1);
}

function isResponseDeclaration(statement: ts.Statement): boolean {
  if (!ts.isVariableStatement(statement)) return false;
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0)
    return false;
  const declarations = statement.declarationList.declarations;
  return (
    declarations.length === 1 &&
    declarations[0] !== undefined &&
    ts.isIdentifier(declarations[0].name) &&
    declarations[0].name.text === "response" &&
    declarations[0].initializer !== undefined
  );
}

function isObservedObject(value: ts.Expression | undefined): boolean {
  if (value === undefined || !ts.isObjectLiteralExpression(value)) return false;
  const properties = objectProperties(value);
  if (properties === null) return false;
  const status = properties.get("httpStatus");
  const code = properties.get("code");
  return (
    properties.size === 2 &&
    status !== undefined &&
    propertyPath(status).join(".") === "response.status" &&
    code !== undefined &&
    isObservedCodeExpression(code)
  );
}

function isObservedCodeExpression(value: ts.Expression): boolean {
  const directPath = propertyPath(value);
  if (directPath.at(0) === "response" && directPath.at(-1) === "code") {
    return true;
  }
  if (
    !ts.isConditionalExpression(value) ||
    !ts.isBinaryExpression(value.condition) ||
    value.condition.operatorToken.kind !== ts.SyntaxKind.InKeyword ||
    !ts.isStringLiteral(value.condition.left) ||
    value.condition.left.text !== "code" ||
    propertyPath(value.condition.right).join(".") !== "response.body" ||
    propertyPath(value.whenTrue).join(".") !== "response.body.code" ||
    value.whenFalse.kind !== ts.SyntaxKind.NullKeyword
  ) {
    return false;
  }
  return true;
}

function isExpectedObject(
  value: ts.ObjectLiteralExpression,
  expected: { httpStatus: number; code: string },
): boolean {
  const properties = objectProperties(value);
  if (properties === null || properties.size !== 2) return false;
  const status = properties.get("httpStatus");
  const code = properties.get("code");
  return (
    status !== undefined &&
    ts.isNumericLiteral(status) &&
    Number(status.text) === expected.httpStatus &&
    code !== undefined &&
    ts.isStringLiteral(code) &&
    code.text === expected.code
  );
}

function objectProperties(
  value: ts.ObjectLiteralExpression,
): Map<string, ts.Expression> | null {
  const result = new Map<string, ts.Expression>();
  for (const property of value.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) ||
      result.has(property.name.text)
    ) {
      return null;
    }
    result.set(property.name.text, property.initializer);
  }
  return result;
}

function propertyPath(value: ts.Expression): string[] {
  if (ts.isIdentifier(value)) return [value.text];
  if (!ts.isPropertyAccessExpression(value)) return [];
  const parent = propertyPath(value.expression);
  return parent.length === 0 ? [] : [...parent, value.name.text];
}

function failureBindsToAssertion(
  message: string,
  path: string,
  line: number,
  column: number,
): boolean {
  const pathPattern = path.split("/").map(escapeRegExp).join("[\\\\/]");
  return new RegExp(
    `(?:^|\\n)[^\\r\\n]*${pathPattern}:${line}:${column}(?:$|\\s)`,
    "u",
  ).test(message);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseSerializedBehavior(
  value: string,
): { httpStatus: number; code: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      isRecord(parsed) &&
      Object.keys(parsed).length === 2 &&
      typeof parsed.httpStatus === "number" &&
      Number.isInteger(parsed.httpStatus) &&
      typeof parsed.code === "string"
    ) {
      return { httpStatus: parsed.httpStatus, code: parsed.code };
    }
  } catch {
    // Vitest's legacy assertion text is JavaScript-like rather than JSON.
  }
  const status = /["']?(?:httpStatus|status)["']?\s*:\s*(-?\d+)/u.exec(
    value,
  )?.[1];
  const code = /["']?code["']?\s*:\s*(["'])(.*?)\1/u.exec(value)?.[2];
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
