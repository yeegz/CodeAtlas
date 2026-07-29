import {
  createHash,
  createPublicKey,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { posix } from "node:path";

import {
  analyzeSnapshot,
  computeSnapshotDigest,
  mapChangedSymbols,
  type ChangedSymbol,
  type SnapshotAnalysis,
} from "@codeatlas/analyzer";
import {
  compareRuns,
  type ComparisonFinding,
  type ExecutionComparison,
} from "@codeatlas/differential";
import {
  ChangePassportSchema,
  EvidenceItemSchema,
  EvidenceManifestSchema,
  deriveAnalysisId,
  signManifest,
  verifyManifest,
  type EvidenceItem,
  type Finding,
  type TestExecution,
} from "@codeatlas/evidence";
import {
  deriveTestObjectives,
  type GeneratedTest,
  type TestGenerator,
  type TestObjective,
} from "@codeatlas/generator";
import { buildPassport, type BuiltChangePassport } from "@codeatlas/passport";
import {
  hasValidExecutionResultBinding,
  type ExecutionProvider,
  type ExecutionRequest,
  type ExecutionResult,
} from "@codeatlas/runner";
import {
  selectTests,
  type SelectionEdge,
  type TestSelection,
} from "@codeatlas/selector";
import { canonicalize } from "json-canonicalize";
import ts from "typescript";

import type { ArtifactStore } from "./local-artifact-store.js";

const EXECUTION_POLICY = Object.freeze({
  timeoutMs: 10_000,
  maxOutputBytes: 64 * 1024,
  maxFiles: 1_000,
});
const REPEAT_COUNT = 3;

export interface AnalyzeComparisonRequest {
  baseRoot: string;
  headRoot: string;
  engineVersion: string;
  configurationDigest: string;
  executionProvider: ExecutionProvider;
  artifactStore: ArtifactStore;
  testGenerator: TestGenerator;
  clock: { now(): Date };
  signingKey: KeyObject;
}

export type SignedEvidenceManifest = ReturnType<typeof signManifest>;

export interface ExecutedGeneratedTest extends GeneratedTest {
  executedOnBase: boolean;
  executedOnHead: boolean;
}

export interface ReproductionArtifact {
  kind: string;
  digest: string;
  path: string;
}

export interface ReproductionBundle {
  schemaVersion: "1.0";
  analysisId: string;
  baseSha: string;
  headSha: string;
  engineVersion: string;
  manifestDigest: string;
  findingIds: string[];
  artifacts: ReproductionArtifact[];
  commands: {
    base: string[];
    head: string[];
    replay: string;
  };
}

export interface AnalysisOutput {
  analysisId: string;
  attemptId: string;
  changedSymbols: ChangedSymbol[];
  selections: TestSelection[];
  runs: ExecutionResult[];
  generatedTests: ExecutedGeneratedTest[];
  findings: Finding[];
  passport: BuiltChangePassport;
  signedManifest: SignedEvidenceManifest;
  publicKey: KeyObject;
  reproductionBundle: ReproductionBundle;
}

export interface PipelineSelectionEdge extends SelectionEdge {
  snapshotSha: string;
}

type StoredArtifact = ReproductionArtifact;

export async function analyzeComparison(
  request: AnalyzeComparisonRequest,
): Promise<AnalysisOutput> {
  validateRequest(request);
  const observedAt = request.clock.now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.valueOf())) {
    throw new TypeError("clock.now() must return a valid Date");
  }
  const observedAtIso = observedAt.toISOString();

  const [baseSha, headSha] = await Promise.all([
    computeSnapshotDigest(request.baseRoot),
    computeSnapshotDigest(request.headRoot),
  ]);
  const analysisId = deriveAnalysisId({
    provider: "local",
    baseSha,
    headSha,
    configurationDigest: request.configurationDigest,
    engineVersion: request.engineVersion,
  });
  const attemptId = `attempt_${randomUUID()}`;
  const artifacts: StoredArtifact[] = [];
  const store = async <T>(
    kind: string,
    value: T,
    validate: (read: unknown) => void,
  ): Promise<StoredArtifact> => {
    const expectedCanonical = canonicalizeJson(value);
    const expectedDigest = sha256Digest(expectedCanonical);
    const stored = await request.artifactStore.putJson(kind, value);
    if (
      stored.digest !== expectedDigest ||
      typeof stored.path !== "string" ||
      stored.path.length === 0 ||
      stored.path.startsWith("/") ||
      stored.path.includes("\\") ||
      stored.path.split("/").includes("..")
    ) {
      throw new Error("Artifact digest or path mismatch");
    }
    const read = await request.artifactStore.readJson<unknown>(stored.path);
    validate(read);
    if (canonicalizeJson(read) !== expectedCanonical) {
      throw new Error("Artifact schema or digest mismatch after read");
    }
    const artifact = { kind, digest: stored.digest, path: stored.path };
    artifacts.push(artifact);
    return artifact;
  };

  const [baseAnalysis, headAnalysis] = await Promise.all([
    analyzeSnapshot({ root: request.baseRoot, snapshotSha: baseSha }),
    analyzeSnapshot({ root: request.headRoot, snapshotSha: headSha }),
  ]);
  await store("base-analysis", baseAnalysis, (value) =>
    validateSnapshotAnalysis(value, baseSha),
  );
  await store("head-analysis", headAnalysis, (value) =>
    validateSnapshotAnalysis(value, headSha),
  );

  const changedSymbols = mapChangedSymbols(baseAnalysis, headAnalysis);
  if (changedSymbols.length === 0) {
    throw new Error("Analysis produced no changed symbols");
  }
  const selectionEdges = deriveSelectionEdges(headAnalysis);
  const selections = selectTests({
    changedSymbolIds: changedSymbols.map(({ id }) => id),
    changedSymbols,
    analysis: headAnalysis,
    tests: headAnalysis.tests,
    edges: selectionEdges,
  });
  if (selections.length === 0) {
    throw new Error("No evidence-backed existing tests were selected");
  }

  const initialCoverageRun = await runAndValidate(
    request.executionProvider,
    executionRequest({
      analysisId,
      revision: "head",
      snapshotRoot: request.headRoot,
      snapshotSha: headSha,
      testPaths: selections.map(({ path }) => path),
      generatedFiles: [],
    }),
  );
  assertComplete(initialCoverageRun, "initial selected-test coverage");

  const publicEntryPoints = headAnalysis.contracts.filter((contract) =>
    changedSymbols.some(
      (changed) =>
        contract.symbolId !== changed.id &&
        findCallPath(headAnalysis, contract.symbolId, changed.id) !== null,
    ),
  );
  const objectives = deriveTestObjectives({
    changedSymbols,
    branches: headAnalysis.branches,
    coverage: coverageForObjectiveDerivation(
      initialCoverageRun.coverage,
      headAnalysis,
      changedSymbols,
    ),
    publicEntryPoints,
    selectedTests: selections,
  });
  if (objectives.length === 0) {
    throw new Error("No deterministic uncovered test objective was derived");
  }

  const generatedPairs: Array<{
    objective: TestObjective;
    test: GeneratedTest;
  }> = [];
  for (const objective of objectives) {
    const generated = await request.testGenerator.generate(objective);
    if (generated.state !== "GENERATED") {
      throw new Error(
        `Unsupported generated-test objective: ${generated.reason}`,
      );
    }
    if (generated.test.objectiveId !== objective.id) {
      throw new Error("Generated test does not match its objective");
    }
    generatedPairs.push({ objective, test: generated.test });
  }
  await store(
    "generated-tests",
    generatedPairs.map(({ test }) => test),
    (value) => validateGeneratedTests(value, generatedPairs),
  );

  const finalRuns: ExecutionResult[] = [];
  const comparisons: ExecutionComparison[] = [];
  for (let repeat = 0; repeat < REPEAT_COUNT; repeat += 1) {
    const base = await runAndValidate(
      request.executionProvider,
      executionRequest({
        analysisId,
        revision: "base",
        snapshotRoot: request.baseRoot,
        snapshotSha: baseSha,
        testPaths: selections.map(({ path }) => path),
        generatedFiles: generatedPairs.map(({ test }) => test),
      }),
    );
    const head = await runAndValidate(
      request.executionProvider,
      executionRequest({
        analysisId,
        revision: "head",
        snapshotRoot: request.headRoot,
        snapshotSha: headSha,
        testPaths: selections.map(({ path }) => path),
        generatedFiles: generatedPairs.map(({ test }) => test),
      }),
    );
    assertComplete(base, `base repeat ${repeat + 1}`);
    assertComplete(head, `head repeat ${repeat + 1}`);
    finalRuns.push(base, head);
    comparisons.push({ base, head });
  }
  const runs = [initialCoverageRun, ...finalRuns];
  await store("execution-runs", runs, (value) => validateRuns(value, runs));

  const semanticArtifact = await store(
    "differential-evidence",
    semanticExecutionProjection(comparisons),
    validateSemanticProjection,
  );
  const differentialItems = generatedPairs.map(({ objective }) =>
    EvidenceItemSchema.parse({
      id: `evidence:differential:${sha256Hex(objective.id)}`,
      type: "DIFFERENTIAL_EXECUTION",
      origin: `@codeatlas/differential@${request.engineVersion}`,
      observedAt: observedAtIso,
      reproducibility: "REPRODUCIBLE",
      source: objective.source,
      artifactDigest: semanticArtifact.digest,
    }),
  );

  const findings: ComparisonFinding[] = [];
  for (const [index, pair] of generatedPairs.entries()) {
    const graphPath = graphPathForObjective(
      headAnalysis,
      changedSymbols,
      pair.objective,
    );
    const evidenceItems = evidenceForComparison(
      headAnalysis.evidence,
      pair.objective,
      graphPath,
      differentialItems[index]!,
    );
    const compared = compareRuns({
      findingId:
        pair.objective.targetSymbol === "validateToken"
          ? "finding_expired_session"
          : `finding_${sha256Hex(pair.objective.id).slice(0, 24)}`,
      comparisons,
      test: {
        provenance: "GENERATED",
        generatedTest: pair.test,
        objective: pair.objective,
      },
      changedSymbols,
      graphPath,
      evidenceItems,
    });
    if (compared.length !== 1) {
      throw new Error("Differential comparison did not produce one finding");
    }
    findings.push(compared[0]!);
  }
  findings.sort((left, right) => compareText(left.id, right.id));

  const manifest = EvidenceManifestSchema.parse({
    schemaVersion: "1.0",
    repository: { provider: "local", baseSha, headSha },
    configurationDigest: request.configurationDigest,
    analysisId,
    engineVersion: request.engineVersion,
    evidence: uniqueEvidence([...headAnalysis.evidence, ...differentialItems]),
  });
  let signedManifest: SignedEvidenceManifest;
  let publicKey: KeyObject;
  try {
    signedManifest = signManifest(manifest, request.signingKey);
    publicKey = createPublicKey(request.signingKey);
  } catch (error) {
    throw new Error("Evidence Manifest signing failed", { cause: error });
  }
  if (!verifyManifest(signedManifest, publicKey)) {
    throw new Error("Evidence Manifest signing verification failed");
  }
  await store("signed-manifest", signedManifest, (value) => {
    if (!verifyManifest(value, publicKey)) {
      throw new Error("Stored signed manifest failed verification");
    }
  });

  const executedGenerated = generatedPairs.map(({ test }) => ({
    ...test,
    executedOnBase: executedOnRevision(finalRuns, test, "base"),
    executedOnHead: executedOnRevision(finalRuns, test, "head"),
  }));
  const testExecutions = buildTestExecutions(
    selections,
    executedGenerated,
    differentialItems,
  );
  const unverifiedAreas = uniqueSorted(
    findings.flatMap(({ proofCard }) => proofCard.limitations),
  );
  const passport = buildPassport({
    baseSha,
    headSha,
    engineVersion: request.engineVersion,
    findings,
    runs,
    tests: testExecutions,
    changedSymbols,
    unverifiedAreas,
    retentionPolicy: "7 days",
    manifestDigest: signedManifest.digest,
  });
  await store("change-passport", passport, (value) => {
    if (!isRecord(value)) throw new Error("Passport artifact schema mismatch");
    ChangePassportSchema.parse({
      baseSha: value.baseSha,
      headSha: value.headSha,
      engineVersion: value.engineVersion,
      findings: value.findings,
      executedTests: value.executedTests,
      unverifiedAreas: value.unverifiedAreas,
      retentionPolicy: value.retentionPolicy,
      manifestDigest: value.manifestDigest,
    });
  });

  const command = [
    "pnpm",
    "vitest",
    "run",
    ...uniqueSorted([
      ...selections.map(({ path }) => path),
      ...generatedPairs.map(({ test }) => test.path),
    ]),
  ];
  const reproductionBundle: ReproductionBundle = {
    schemaVersion: "1.0",
    analysisId,
    baseSha,
    headSha,
    engineVersion: request.engineVersion,
    manifestDigest: signedManifest.digest,
    findingIds: findings.map(({ id }) => id),
    artifacts: artifacts.map((artifact) => ({ ...artifact })),
    commands: {
      base: [...command],
      head: [...command],
      replay: findings[0]!.proofCard.reproductionCommand,
    },
  };
  validateReproductionBundle(reproductionBundle);
  await store("reproduction-bundle", reproductionBundle, (value) =>
    validateReproductionBundle(value),
  );

  return {
    analysisId,
    attemptId,
    changedSymbols,
    selections,
    runs,
    generatedTests: executedGenerated,
    findings,
    passport,
    signedManifest,
    publicKey,
    reproductionBundle,
  };
}

function coverageForObjectiveDerivation(
  coverage: ExecutionResult["coverage"],
  analysis: SnapshotAnalysis,
  changedSymbols: readonly ChangedSymbol[],
): ExecutionResult["coverage"] {
  const byPath = new Map(
    coverage.map((item) => [item.path, new Set(item.coveredLines)]),
  );
  for (const branch of analysis.branches) {
    const changedLines = changedSymbols
      .filter(
        (symbol) =>
          symbol.path === branch.source.path &&
          symbol.headLocation?.snapshotSha === branch.source.snapshotSha,
      )
      .flatMap(({ changedLines: lines }) => lines)
      .filter(
        (line) =>
          line >= branch.source.startLine && line <= branch.source.endLine,
      );
    if (changedLines.length === 0) continue;
    const covered = byPath.get(branch.source.path) ?? new Set<number>();
    if (!changedLines.every((line) => covered.has(line))) {
      covered.delete(branch.source.startLine);
      byPath.set(branch.source.path, covered);
    }
  }
  return [...byPath.entries()]
    .map(([path, lines]) => ({
      path,
      coveredLines: [...lines].sort((left, right) => left - right),
    }))
    .sort((left, right) => compareText(left.path, right.path));
}

export function deriveSelectionEdges(
  analysis: SnapshotAnalysis,
): PipelineSelectionEdge[] {
  const edges: PipelineSelectionEdge[] = analysis.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    evidenceType: edge.evidenceType,
    evidenceIds: [...edge.evidenceIds],
    fromName: edge.fromName,
    toName: edge.toName,
    snapshotSha: edge.snapshotSha,
  }));
  const files = new Map(analysis.files.map((file) => [file.path, file]));
  const testsByPath = new Map<string, SnapshotAnalysis["tests"]>();
  for (const test of analysis.tests) {
    const group = testsByPath.get(test.path) ?? [];
    group.push(test);
    testsByPath.set(test.path, group);
  }

  for (const [testPath, tests] of testsByPath) {
    const file = files.get(testPath);
    if (!file) continue;
    const sourceFile = ts.createSourceFile(
      testPath,
      file.text,
      ts.ScriptTarget.ES2023,
      true,
    );
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        continue;
      }
      const moduleSpecifier = statement.moduleSpecifier.text;
      const targetPath = resolveImportedSourcePath(
        testPath,
        moduleSpecifier,
        files,
      );
      if (!targetPath) continue;
      const importEvidence = analysis.edges
        .filter(
          (edge) =>
            edge.relation === "IMPORTS" &&
            edge.fromName === testPath &&
            edge.toName === moduleSpecifier &&
            edge.snapshotSha === analysis.snapshotSha,
        )
        .flatMap(({ evidenceIds }) => evidenceIds);
      for (const element of statement.importClause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        const target = analysis.symbols.find(
          (symbol) =>
            symbol.source.path === targetPath && symbol.name === importedName,
        );
        if (!target) continue;
        for (const test of tests) {
          const evidenceIds = uniqueSorted([
            ...test.evidenceIds,
            ...importEvidence,
          ]);
          if (evidenceIds.length === 0) continue;
          edges.push({
            from: test.id,
            to: target.id,
            relation: "TESTS",
            evidenceType: "STATIC_AST",
            evidenceIds,
            fromName: test.name,
            toName: target.name,
            snapshotSha: analysis.snapshotSha,
          });
        }
      }
    }
  }
  return edges.sort(compareSelectionEdges);
}

function executionRequest(
  request: Omit<ExecutionRequest, "policy">,
): ExecutionRequest {
  return {
    ...request,
    testPaths: uniqueSorted(request.testPaths),
    generatedFiles: [...request.generatedFiles],
    policy: { ...EXECUTION_POLICY },
  };
}

async function runAndValidate(
  provider: ExecutionProvider,
  request: ExecutionRequest,
): Promise<ExecutionResult> {
  const result = await provider.run(request);
  if (!hasValidExecutionResultBinding(result)) {
    throw new Error("Execution result digest binding is invalid");
  }
  if (
    result.revision !== request.revision ||
    result.snapshotSha !== request.snapshotSha
  ) {
    throw new Error("Execution result is bound to the wrong revision");
  }
  return result;
}

function assertComplete(result: ExecutionResult, stage: string): void {
  if (result.terminalState !== "COMPLETED") {
    throw new Error(
      `Incomplete ${stage} execution: terminal state ${result.terminalState}`,
    );
  }
}

function findCallPath(
  analysis: SnapshotAnalysis,
  from: string,
  to: string,
): PipelineSelectionEdge[] | null {
  const outgoing = new Map<string, SnapshotAnalysis["edges"]>();
  for (const edge of analysis.edges) {
    if (edge.relation !== "CALLS" || edge.snapshotSha !== analysis.snapshotSha)
      continue;
    const group = outgoing.get(edge.from) ?? [];
    group.push(edge);
    outgoing.set(edge.from, group);
  }
  for (const group of outgoing.values()) {
    group.sort((left, right) => compareText(left.id, right.id));
  }
  const queue: Array<{ id: string; path: SnapshotAnalysis["edges"] }> = [
    { id: from, path: [] },
  ];
  const visited = new Set([from]);
  for (const item of queue) {
    if (item.path.length >= 8) continue;
    for (const edge of outgoing.get(item.id) ?? []) {
      const path = [...item.path, edge];
      if (edge.to === to) {
        return path.map((value) => ({
          from: value.from,
          to: value.to,
          relation: value.relation,
          evidenceType: value.evidenceType,
          evidenceIds: [...value.evidenceIds],
          fromName: value.fromName,
          toName: value.toName,
          snapshotSha: value.snapshotSha,
        }));
      }
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push({ id: edge.to, path });
      }
    }
  }
  return null;
}

function graphPathForObjective(
  analysis: SnapshotAnalysis,
  changedSymbols: readonly ChangedSymbol[],
  objective: TestObjective,
): PipelineSelectionEdge[] {
  const from = analysis.symbols.find(
    ({ name }) => name === objective.entryPoint,
  );
  const changed = changedSymbols.find(
    ({ name }) => name === objective.targetSymbol,
  );
  if (!from || !changed) throw new Error("Objective graph path is unresolved");
  const path = findCallPath(analysis, from.id, changed.id);
  if (!path) throw new Error("Objective has no analyzer-observed call path");
  return path;
}

function evidenceForComparison(
  evidence: readonly EvidenceItem[],
  objective: TestObjective,
  path: readonly PipelineSelectionEdge[],
  differential: EvidenceItem,
): EvidenceItem[] {
  const required = new Set([
    ...objective.evidenceIds,
    ...path.flatMap(({ evidenceIds }) => evidenceIds ?? []),
  ]);
  const selected = evidence.filter(({ id }) => required.has(id));
  if (selected.length !== required.size) {
    throw new Error(
      "Objective evidence ids do not resolve to analyzer evidence",
    );
  }
  return uniqueEvidence([...selected, differential]);
}

function semanticExecutionProjection(
  comparisons: readonly ExecutionComparison[],
) {
  return {
    repeatCount: comparisons.length,
    comparisons: comparisons.map(({ base, head }) => ({
      base: semanticRun(base),
      head: semanticRun(head),
    })),
  };
}

function semanticRun(run: ExecutionResult) {
  return {
    revision: run.revision,
    snapshotSha: run.snapshotSha,
    terminalState: run.terminalState,
    exitCode: run.exitCode,
    testCases: run.testCases,
    coverage: run.coverage,
    observations: run.observations,
    environmentDigest: run.environmentDigest,
  };
}

function executedOnRevision(
  runs: readonly ExecutionResult[],
  test: GeneratedTest,
  revision: "base" | "head",
): boolean {
  return runs
    .filter((run) => run.revision === revision)
    .every(
      (run) =>
        run.testCases.filter(
          (testCase) =>
            testCase.path === test.path &&
            testCase.generatedObjectiveId === test.objectiveId &&
            testCase.status !== "SKIPPED",
        ).length === 1,
    );
}

function buildTestExecutions(
  selections: readonly TestSelection[],
  generated: readonly ExecutedGeneratedTest[],
  differentialItems: readonly EvidenceItem[],
): TestExecution[] {
  return [
    ...selections.map((selection) => ({
      id: selection.testId,
      command: `pnpm vitest run ${selection.path}`,
      provenance: "EXISTING" as const,
      executedOnBase: false,
      executedOnHead: false,
      evidenceIds: uniqueSorted(selection.evidenceIds),
    })),
    ...generated.map((test, index) => ({
      id: `generated_${sha256Hex(test.objectiveId).slice(0, 24)}`,
      command: `pnpm vitest run ${test.path}`,
      provenance: "GENERATED" as const,
      executedOnBase: test.executedOnBase,
      executedOnHead: test.executedOnHead,
      evidenceIds: [differentialItems[index]!.id],
    })),
  ];
}

function resolveImportedSourcePath(
  importingPath: string,
  specifier: string,
  files: ReadonlyMap<string, unknown>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = posix.normalize(
    posix.join(posix.dirname(importingPath), specifier),
  );
  const candidates = [
    resolved,
    resolved.replace(/\.[cm]?js$/u, ".ts"),
    resolved.replace(/\.[cm]?jsx$/u, ".tsx"),
    `${resolved}.ts`,
    `${resolved}.tsx`,
  ];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function validateRequest(request: AnalyzeComparisonRequest): void {
  if (
    typeof request !== "object" ||
    request === null ||
    typeof request.baseRoot !== "string" ||
    typeof request.headRoot !== "string" ||
    typeof request.engineVersion !== "string" ||
    request.engineVersion.length === 0 ||
    !/^sha256:[0-9a-f]{64}$/u.test(request.configurationDigest) ||
    typeof request.executionProvider?.run !== "function" ||
    typeof request.artifactStore?.putJson !== "function" ||
    typeof request.artifactStore?.readJson !== "function" ||
    typeof request.testGenerator?.generate !== "function" ||
    typeof request.clock?.now !== "function"
  ) {
    throw new TypeError("AnalyzeComparisonRequest is invalid");
  }
}

function validateSnapshotAnalysis(value: unknown, snapshotSha: string): void {
  if (!isRecord(value) || value.snapshotSha !== snapshotSha) {
    throw new Error("Snapshot analysis artifact schema mismatch");
  }
  if (!Array.isArray(value.evidence)) {
    throw new Error("Snapshot analysis evidence is missing");
  }
  for (const item of value.evidence) EvidenceItemSchema.parse(item);
}

function validateGeneratedTests(
  value: unknown,
  expected: readonly { test: GeneratedTest }[],
): void {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error("Generated-test artifact schema mismatch");
  }
  for (const [index, item] of value.entries()) {
    if (
      !isRecord(item) ||
      item.generated !== true ||
      item.executed !== false ||
      item.objectiveId !== expected[index]?.test.objectiveId
    ) {
      throw new Error("Generated-test artifact schema mismatch");
    }
  }
}

function validateRuns(
  value: unknown,
  expected: readonly ExecutionResult[],
): void {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error("Execution artifact schema mismatch");
  }
  for (const run of value) {
    if (!hasValidExecutionResultBinding(run)) {
      throw new Error("Execution artifact digest mismatch");
    }
  }
}

function validateSemanticProjection(value: unknown): void {
  if (
    !isRecord(value) ||
    value.repeatCount !== REPEAT_COUNT ||
    !Array.isArray(value.comparisons) ||
    value.comparisons.length !== REPEAT_COUNT
  ) {
    throw new Error("Differential artifact schema mismatch");
  }
}

function validateReproductionBundle(
  value: unknown,
): asserts value is ReproductionBundle {
  if (
    !isRecord(value) ||
    value.schemaVersion !== "1.0" ||
    !/^analysis_[0-9a-f]{64}$/u.test(String(value.analysisId)) ||
    !/^[0-9a-f]{40}$/u.test(String(value.baseSha)) ||
    !/^[0-9a-f]{40}$/u.test(String(value.headSha)) ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(value.manifestDigest)) ||
    !Array.isArray(value.artifacts) ||
    !isRecord(value.commands)
  ) {
    throw new Error("Reproduction bundle schema mismatch");
  }
  const serialized = canonicalizeJson(value);
  if (
    serialized.includes("PRIVATE KEY") ||
    value.artifacts.some(
      (artifact) =>
        !isRecord(artifact) ||
        typeof artifact.path !== "string" ||
        artifact.path.startsWith("/") ||
        artifact.path.includes("..") ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(artifact.digest)),
    )
  ) {
    throw new Error("Reproduction bundle contains a secret or mutable path");
  }
}

function uniqueEvidence(items: readonly EvidenceItem[]): EvidenceItem[] {
  const byId = new Map<string, EvidenceItem>();
  for (const item of items) {
    const validated = EvidenceItemSchema.parse(item);
    const existing = byId.get(validated.id);
    if (
      existing !== undefined &&
      canonicalizeJson(existing) !== canonicalizeJson(validated)
    ) {
      throw new Error("Conflicting evidence records share an id");
    }
    byId.set(validated.id, validated);
  }
  return [...byId.values()].sort((left, right) =>
    compareText(left.id, right.id),
  );
}

function compareSelectionEdges(
  left: PipelineSelectionEdge,
  right: PipelineSelectionEdge,
): number {
  return (
    compareText(left.from, right.from) ||
    compareText(left.to, right.to) ||
    compareText(left.relation, right.relation) ||
    compareText(
      (left.evidenceIds ?? []).join("\0"),
      (right.evidenceIds ?? []).join("\0"),
    )
  );
}

function canonicalizeJson(value: unknown): string {
  const canonical = canonicalize(value);
  if (typeof canonical !== "string") {
    throw new TypeError("Value is not canonical JSON data");
  }
  return canonical;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Digest(value: string): string {
  return `sha256:${sha256Hex(value)}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
