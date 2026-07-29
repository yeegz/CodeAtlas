export interface ObjectiveSourceLocation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface TestObjective {
  readonly id: string;
  readonly category: "REGRESSION_TEST";
  readonly targetSymbol: string;
  readonly entryPoint: string;
  readonly reason: string;
  readonly source: ObjectiveSourceLocation;
  readonly evidenceIds: readonly string[];
}

export interface ChangedSymbolObjectiveInput {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly changedLines: readonly number[];
  readonly evidenceIds?: readonly string[];
}

export interface BranchObjectiveInput {
  readonly id?: string;
  readonly symbolId: string;
  readonly line: number;
  readonly kind: string;
  readonly evidenceIds?: readonly string[];
}

export interface PublicEntryPointObjectiveInput {
  readonly name: string;
  readonly path: string;
  readonly evidenceIds?: readonly string[];
}

export interface SelectedTestEvidenceInput {
  readonly testId: string;
  readonly evidenceIds: readonly string[];
}

export interface DeriveTestObjectivesInput {
  readonly changedSymbols: readonly ChangedSymbolObjectiveInput[];
  readonly branches: readonly BranchObjectiveInput[];
  readonly coveredLines: readonly number[];
  readonly publicEntryPoints: readonly PublicEntryPointObjectiveInput[];
  readonly selectedTestEvidence?: readonly SelectedTestEvidenceInput[];
}

export function deriveTestObjectives(
  input: DeriveTestObjectivesInput,
): TestObjective[] {
  const coveredLines = new Set(input.coveredLines);
  const selectedEvidenceIds =
    input.selectedTestEvidence?.flatMap(({ evidenceIds }) => evidenceIds) ?? [];
  const symbols = [...input.changedSymbols].sort(compareChangedSymbols);
  const objectives: TestObjective[] = [];
  const emittedBranches = new Set<string>();

  for (const symbol of symbols) {
    const changedLines = new Set(symbol.changedLines);
    const entryPoint = chooseEntryPoint(symbol.path, input.publicEntryPoints);
    if (entryPoint === undefined) continue;

    const branches = input.branches
      .filter(
        (branch) =>
          branch.symbolId === symbol.id &&
          changedLines.has(branch.line) &&
          !coveredLines.has(branch.line),
      )
      .sort(compareBranches);

    for (const branch of branches) {
      const branchKey = `${symbol.id}\u0000${symbol.path}\u0000${branch.line}`;
      if (emittedBranches.has(branchKey)) continue;
      emittedBranches.add(branchKey);

      const source = Object.freeze({
        path: symbol.path,
        startLine: branch.line,
        endLine: branch.line,
      });
      const evidenceIds = Object.freeze(
        uniqueSorted([
          ...(symbol.evidenceIds ?? []),
          ...(branch.evidenceIds ?? []),
          ...(entryPoint.evidenceIds ?? []),
          ...selectedEvidenceIds,
        ]),
      );
      const expiration =
        symbol.name === "validateToken" && entryPoint.name === "restoreSession";
      const branchDescription = expiration ? "expiration branch" : "branch";

      objectives.push(
        Object.freeze({
          id: `objective:regression-test:${encodeURIComponent(symbol.id)}:${branch.line}:${encodeURIComponent(entryPoint.name)}`,
          category: "REGRESSION_TEST" as const,
          targetSymbol: symbol.name,
          entryPoint: entryPoint.name,
          reason: `Changed ${branchDescription} at ${symbol.path}:${branch.line} has no mapped runtime coverage.`,
          source,
          evidenceIds,
        }),
      );
    }
  }

  return Object.freeze(objectives) as TestObjective[];
}

function chooseEntryPoint(
  symbolPath: string,
  candidates: readonly PublicEntryPointObjectiveInput[],
): PublicEntryPointObjectiveInput | undefined {
  return [...candidates].sort((left, right) => {
    const leftSamePath = left.path === symbolPath ? 0 : 1;
    const rightSamePath = right.path === symbolPath ? 0 : 1;
    return (
      leftSamePath - rightSamePath ||
      left.path.localeCompare(right.path) ||
      left.name.localeCompare(right.name)
    );
  })[0];
}

function compareChangedSymbols(
  left: ChangedSymbolObjectiveInput,
  right: ChangedSymbolObjectiveInput,
): number {
  return (
    left.path.localeCompare(right.path) ||
    minimum(left.changedLines) - minimum(right.changedLines) ||
    left.id.localeCompare(right.id)
  );
}

function compareBranches(
  left: BranchObjectiveInput,
  right: BranchObjectiveInput,
): number {
  return (
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    (left.id ?? "").localeCompare(right.id ?? "")
  );
}

function minimum(values: readonly number[]): number {
  return values.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...values);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
