import type {
  AnalyzedEdge,
  ChangedSymbol,
  SnapshotAnalysis,
} from "@codeatlas/analyzer";

const MAX_PATH_EDGES = 8;
const REACHABLE_RELATIONS = new Set(["CALLS", "IMPORTS", "TESTS"]);

type ReachableRelation = "CALLS" | "IMPORTS" | "TESTS";

export interface TestCandidate {
  id: string;
  path: string;
  importedFileIds?: readonly string[];
}

export interface SelectionEdge {
  from: string;
  to: string;
  relation: string;
  evidenceType?: AnalyzedEdge["evidenceType"];
  evidenceIds?: readonly string[];
  fromName?: string;
  toName?: string;
}

export interface TestSelectionInput {
  changedSymbolIds: readonly string[];
  changedSymbols?: readonly Pick<ChangedSymbol, "id" | "name">[];
  analysis?: Pick<SnapshotAnalysis, "symbols">;
  tests: readonly TestCandidate[];
  edges: readonly SelectionEdge[];
}

export interface TestSelection {
  testId: string;
  path: string;
  reasons: string[];
  evidenceIds: string[];
}

export interface TestExclusion {
  testId: string;
  excluded: true;
  reason: "AI_INFERENCE_PATH_ONLY" | "NO_REACHABLE_CHANGED_SYMBOL";
}

interface ValidEdge {
  from: string;
  to: string;
  relation: ReachableRelation;
  evidenceType?: AnalyzedEdge["evidenceType"];
  evidenceIds: string[];
  fromName?: string;
  toName?: string;
}

interface Reach {
  changedId: string;
  edges: ValidEdge[];
}

export function selectTests(input: TestSelectionInput): TestSelection[] {
  const tests = validTests(input.tests);
  const reaches = findReaches(input, tests);
  const names = nodeNames(input, reaches);

  return tests
    .flatMap((test) => {
      const reach = reaches.get(test.id);
      if (!reach) return [];
      return [toSelection(test, reach, names)];
    })
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.testId.localeCompare(right.testId),
    );
}

export function explainExclusion(
  testId: string,
  input: TestSelectionInput,
): TestExclusion | undefined {
  if (!validTests(input.tests).some((test) => test.id === testId)) {
    return undefined;
  }
  return selectTests(input).some((selection) => selection.testId === testId)
    ? undefined
    : {
        testId,
        excluded: true,
        reason: findReaches(input, validTests(input.tests), true).has(testId)
          ? "AI_INFERENCE_PATH_ONLY"
          : "NO_REACHABLE_CHANGED_SYMBOL",
      };
}

function findReaches(
  input: TestSelectionInput,
  tests: readonly TestCandidate[],
  includeAiInference = false,
): Map<string, Reach> {
  const testIds = new Set(tests.map((test) => test.id));
  const reverseEdges = reverseAdjacency(input.edges, includeAiInference);
  const changedIds = uniqueStrings(input.changedSymbolIds).sort();
  const reaches = new Map<string, Reach>();
  const visited = new Map<string, number>();
  const queue: Reach[] = changedIds.map((changedId) => ({
    changedId,
    edges: [],
  }));

  for (const changedId of changedIds) visited.set(changedId, 0);

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex];
    if (!current || current.edges.length === MAX_PATH_EDGES) continue;
    const currentNode = current.edges[0]?.from ?? current.changedId;

    for (const edge of reverseEdges.get(currentNode) ?? []) {
      const nextDistance = current.edges.length + 1;
      const priorDistance = visited.get(edge.from);
      if (priorDistance !== undefined && priorDistance <= nextDistance)
        continue;

      const next: Reach = {
        changedId: current.changedId,
        edges: [edge, ...current.edges],
      };
      visited.set(edge.from, nextDistance);
      if (testIds.has(edge.from)) reaches.set(edge.from, next);
      queue.push(next);
    }
  }
  return reaches;
}

function reverseAdjacency(
  edges: readonly SelectionEdge[],
  includeAiInference: boolean,
): Map<string, ValidEdge[]> {
  const adjacency = new Map<string, ValidEdge[]>();
  for (const edge of edges) {
    const normalized = normalizeEdge(edge);
    if (
      !normalized ||
      (!includeAiInference && normalized.evidenceType === "AI_INFERENCE")
    )
      continue;
    const bucket = adjacency.get(normalized.to) ?? [];
    bucket.push(normalized);
    adjacency.set(normalized.to, bucket);
  }
  for (const bucket of adjacency.values()) bucket.sort(compareEdges);
  return adjacency;
}

function normalizeEdge(edge: SelectionEdge): ValidEdge | undefined {
  if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") {
    return undefined;
  }
  if (!edge.from || !edge.to || !REACHABLE_RELATIONS.has(edge.relation)) {
    return undefined;
  }
  return {
    from: edge.from,
    to: edge.to,
    relation: edge.relation as ReachableRelation,
    ...(typeof edge.evidenceType === "string"
      ? { evidenceType: edge.evidenceType }
      : {}),
    evidenceIds: uniqueStrings(edge.evidenceIds ?? []),
    ...(typeof edge.fromName === "string" && edge.fromName
      ? { fromName: edge.fromName }
      : {}),
    ...(typeof edge.toName === "string" && edge.toName
      ? { toName: edge.toName }
      : {}),
  };
}

function validTests(tests: readonly TestCandidate[]): TestCandidate[] {
  return tests.filter(
    (test): test is TestCandidate =>
      Boolean(test) &&
      typeof test.id === "string" &&
      Boolean(test.id) &&
      typeof test.path === "string" &&
      Boolean(test.path),
  );
}

function nodeNames(input: TestSelectionInput, reaches: Map<string, Reach>) {
  const names = new Map<string, string>();
  for (const symbol of input.changedSymbols ?? []) {
    if (
      symbol &&
      typeof symbol.id === "string" &&
      typeof symbol.name === "string"
    ) {
      names.set(symbol.id, symbol.name);
    }
  }
  for (const symbol of input.analysis?.symbols ?? [])
    names.set(symbol.id, symbol.name);
  for (const reach of reaches.values()) {
    for (const edge of reach.edges) {
      if (edge.fromName) names.set(edge.from, edge.fromName);
      if (edge.toName) names.set(edge.to, edge.toName);
    }
  }
  return names;
}

function toSelection(
  test: TestCandidate,
  reach: Reach,
  names: Map<string, string>,
): TestSelection {
  return {
    testId: test.id,
    path: test.path,
    reasons: [reasonFor(reach, names)],
    evidenceIds: uniqueStrings(reach.edges.flatMap((edge) => edge.evidenceIds)),
  };
}

function reasonFor(reach: Reach, names: Map<string, string>): string {
  const changedName = nameFor(reach.changedId, names);
  const call = reach.edges.find((edge) => edge.relation === "CALLS");
  if (call) {
    return `Calls ${nameFor(call.from, names)}(), which reaches changed ${changedName}().`;
  }
  const imported = reach.edges.find((edge) => edge.relation === "IMPORTS");
  if (imported) {
    return `Imports ${nameFor(imported.to, names)}, which reaches changed ${changedName}().`;
  }
  return `Tests changed ${changedName}().`;
}

function nameFor(id: string, names: Map<string, string>): string {
  return names.get(id) ?? id.slice(id.indexOf(":") + 1);
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string => typeof value === "string" && Boolean(value),
      ),
    ),
  ];
}

function compareEdges(left: ValidEdge, right: ValidEdge): number {
  return (
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.relation.localeCompare(right.relation) ||
    left.evidenceIds
      .join("\u0000")
      .localeCompare(right.evidenceIds.join("\u0000"))
  );
}
