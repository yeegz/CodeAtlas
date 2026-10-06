import type {
  AnalyzedBranch,
  AnalyzedContract,
  ChangedSymbol,
} from "@codeatlas/analyzer";
import type { SourceLocation } from "@codeatlas/evidence";
import type { ExecutionResult } from "@codeatlas/runner";
import type { TestSelection } from "@codeatlas/selector";

export interface TestObjective {
  readonly id: string;
  readonly category: "REGRESSION_TEST";
  readonly targetSymbol: string;
  readonly entryPoint: string;
  readonly reason: string;
  readonly source: SourceLocation;
  readonly evidenceIds: readonly string[];
}

export interface DeriveTestObjectivesInput {
  readonly changedSymbols: readonly ChangedSymbol[];
  readonly branches: readonly AnalyzedBranch[];
  readonly coverage: ExecutionResult["coverage"];
  readonly publicEntryPoints: readonly AnalyzedContract[];
  readonly selectedTests: readonly TestSelection[];
}

interface ChangedTarget {
  id: string;
  name: string;
  path: string;
  snapshotSha: string | null;
  changedLines: Set<number>;
}

interface BranchTarget {
  id: string;
  kind: AnalyzedBranch["kind"];
  source: SourceLocation;
  evidenceIds: string[];
}

interface EntryPointTarget {
  id: string;
  name: string;
  source: SourceLocation;
  evidenceIds: string[];
}

export function deriveTestObjectives(
  input: DeriveTestObjectivesInput,
): TestObjective[] {
  const coverage = coverageByPath(input.coverage);
  const selectedEvidenceIds = uniqueSorted(
    input.selectedTests.flatMap(({ evidenceIds }) => evidenceIds),
  );
  const entryPoints = normalizeEntryPoints(input.publicEntryPoints);
  const branches = normalizeBranches(input.branches);
  const objectives: TestObjective[] = [];

  for (const symbol of normalizeChangedSymbols(input.changedSymbols)) {
    const eligibleBranches = branches.filter(
      (branch) =>
        branch.source.path === symbol.path &&
        symbol.changedLines.has(branch.source.startLine) &&
        (symbol.snapshotSha === null ||
          branch.source.snapshotSha === symbol.snapshotSha) &&
        !coverage.get(branch.source.path)?.has(branch.source.startLine),
    );

    for (const branch of eligibleBranches) {
      const entryPoint = entryPoints.find(
        (candidate) =>
          candidate.source.path === branch.source.path &&
          candidate.source.snapshotSha === branch.source.snapshotSha,
      );
      if (entryPoint === undefined) continue;

      const source = Object.freeze({ ...branch.source });
      const evidenceIds = Object.freeze(
        uniqueSorted([
          ...branch.evidenceIds,
          ...entryPoint.evidenceIds,
          ...selectedEvidenceIds,
        ]),
      );
      const expiration =
        symbol.name === "validateToken" && entryPoint.name === "restoreSession";
      const branchDescription = expiration ? "expiration branch" : "branch";

      objectives.push(
        Object.freeze({
          id: [
            "objective:regression-test",
            encodeURIComponent(symbol.id),
            encodeURIComponent(branch.id),
            encodeURIComponent(branch.kind),
            String(branch.source.startLine),
            encodeURIComponent(entryPoint.name),
          ].join(":"),
          category: "REGRESSION_TEST" as const,
          targetSymbol: symbol.name,
          entryPoint: entryPoint.name,
          reason: `Changed ${branchDescription} at ${branch.source.path}:${branch.source.startLine} has no mapped runtime coverage.`,
          source,
          evidenceIds,
        }),
      );
    }
  }

  return Object.freeze(objectives.sort(compareObjectives)) as TestObjective[];
}

function normalizeChangedSymbols(
  values: readonly ChangedSymbol[],
): ChangedTarget[] {
  const groups = new Map<string, ChangedTarget>();
  for (const value of values) {
    const key = `${value.id}\u0000${value.path}`;
    const snapshotSha = value.headLocation?.snapshotSha ?? null;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        id: value.id,
        name: value.name,
        path: value.path,
        snapshotSha,
        changedLines: new Set(value.changedLines),
      });
      continue;
    }
    for (const line of value.changedLines) existing.changedLines.add(line);
    if (value.name.localeCompare(existing.name) < 0) existing.name = value.name;
    if (
      snapshotSha !== null &&
      (existing.snapshotSha === null || snapshotSha < existing.snapshotSha)
    ) {
      existing.snapshotSha = snapshotSha;
    }
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.id.localeCompare(right.id),
  );
}

function normalizeBranches(values: readonly AnalyzedBranch[]): BranchTarget[] {
  const groups = new Map<string, BranchTarget>();
  for (const value of values) {
    const key = [
      value.id,
      value.kind,
      value.source.snapshotSha,
      value.source.path,
      value.source.startLine,
      value.source.endLine,
    ].join("\u0000");
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        id: value.id,
        kind: value.kind,
        source: { ...value.source },
        evidenceIds: [...value.evidenceIds],
      });
    } else {
      existing.evidenceIds.push(...value.evidenceIds);
    }
  }
  return [...groups.values()]
    .map((branch) => ({
      ...branch,
      evidenceIds: uniqueSorted(branch.evidenceIds),
    }))
    .sort(compareBranches);
}

function normalizeEntryPoints(
  values: readonly AnalyzedContract[],
): EntryPointTarget[] {
  const groups = new Map<string, EntryPointTarget>();
  for (const value of values) {
    const key = [
      value.id,
      value.name,
      value.source.snapshotSha,
      value.source.path,
      value.source.startLine,
      value.source.endLine,
    ].join("\u0000");
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        id: value.id,
        name: value.name,
        source: { ...value.source },
        evidenceIds: [...value.evidenceIds],
      });
    } else {
      existing.evidenceIds.push(...value.evidenceIds);
    }
  }
  return [...groups.values()]
    .map((entryPoint) => ({
      ...entryPoint,
      evidenceIds: uniqueSorted(entryPoint.evidenceIds),
    }))
    .sort(
      (left, right) =>
        left.source.path.localeCompare(right.source.path) ||
        left.source.snapshotSha.localeCompare(right.source.snapshotSha) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
}

function coverageByPath(
  values: ExecutionResult["coverage"],
): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const value of values) {
    const lines = result.get(value.path) ?? new Set<number>();
    for (const line of value.coveredLines) lines.add(line);
    result.set(value.path, lines);
  }
  return result;
}

function compareBranches(left: BranchTarget, right: BranchTarget): number {
  return (
    left.source.path.localeCompare(right.source.path) ||
    left.source.startLine - right.source.startLine ||
    left.id.localeCompare(right.id) ||
    left.kind.localeCompare(right.kind) ||
    left.source.endLine - right.source.endLine
  );
}

function compareObjectives(left: TestObjective, right: TestObjective): number {
  return left.id.localeCompare(right.id);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
