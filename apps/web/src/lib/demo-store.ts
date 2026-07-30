import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { computeSnapshotDigest } from "@codeatlas/analyzer";
import { deriveAnalysisId, verifyManifest } from "@codeatlas/evidence";
import { TemplateTestGenerator } from "@codeatlas/generator";
import { LocalArtifactStore, analyzeComparison } from "@codeatlas/pipeline";
import type { AnalysisOutput } from "@codeatlas/pipeline";
import { LocalExecutionProvider } from "@codeatlas/runner";

export const ENGINE_VERSION = "0.1.0";

/** Distance band from the changed symbol. Band 0 is the change itself. */
export type ContourBand = 0 | 1 | 2;

export type NodeState =
  "CHANGED" | "OBSERVED" | "FAILED" | "INFERRED" | "UNCHANGED";

export interface WorkspaceNode {
  id: string;
  label: string;
  detail: string;
  kind: "SYMBOL" | "TEST";
  state: NodeState;
  path: string;
  band: ContourBand;
  generated: boolean;
}

export interface WorkspaceEdge {
  id: string;
  from: string;
  to: string;
  relation: string;
  evidenceType: string;
  /** Runtime-confirmed edges are drawn solid; inferred edges stay dotted. */
  observed: boolean;
  reason: string;
}

export interface WorkspaceProofCard {
  findingId: string;
  state: string;
  title: string;
  summary: string;
  baseBehavior: string;
  headBehavior: string;
  affectedJourney: string;
  graphPath: string | null;
  reproductionCommand: string;
  recommendedAction: string;
  limitations: string[];
  confidenceLevel: string | null;
  confidenceFactors: string[];
  evidenceIds: string[];
}

export interface WorkspaceSelection {
  path: string;
  reasons: string[];
}

export interface WorkspaceGeneratedTest {
  path: string;
  objectiveId: string;
  executedOnBase: boolean;
  executedOnHead: boolean;
}

export interface WorkspaceModel {
  analysisId: string;
  baseSha: string;
  headSha: string;
  engineVersion: string;
  manifestDigest: string;
  retentionPolicy: string;
  overallState: "ACTION_REQUIRED" | "INCOMPLETE" | "VERIFIED";
  impactTitle: string;
  summary: AnalysisOutput["passport"]["summary"];
  changedFiles: string[];
  changedSymbols: Array<{ name: string; path: string }>;
  selections: WorkspaceSelection[];
  generatedTests: WorkspaceGeneratedTest[];
  unverifiedAreas: string[];
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
  proofCards: WorkspaceProofCard[];
}

interface DemoCache {
  model?: WorkspaceModel;
  running?: Promise<WorkspaceModel>;
}

const CACHE_KEY = Symbol.for("codeatlas.demo.cache");

function cache(): DemoCache {
  const holder = globalThis as unknown as Record<symbol, DemoCache | undefined>;
  holder[CACHE_KEY] ??= {};
  return holder[CACHE_KEY];
}

/** Walk up from the process directory until the workspace manifest appears. */
export function findWorkspaceRoot(start: string = process.cwd()): string {
  let cursor = resolve(start);
  for (;;) {
    if (existsSync(join(cursor, "pnpm-workspace.yaml"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error("Unable to locate the CodeAtlas workspace root");
    }
    cursor = parent;
  }
}

export function getDemoModel(): WorkspaceModel | undefined {
  return cache().model;
}

/**
 * Run the real evidence pipeline against the seeded fixture. Concurrent
 * callers share one run, and the terminal result is cached for this process.
 */
export async function runDemoAnalysis(): Promise<WorkspaceModel> {
  const current = cache();
  if (current.model !== undefined) return current.model;
  current.running ??= execute()
    .then((model) => {
      cache().model = model;
      return model;
    })
    .finally(() => {
      delete cache().running;
    });
  return current.running;
}

async function execute(): Promise<WorkspaceModel> {
  const workspaceRoot = findWorkspaceRoot();
  const baseRoot = join(workspaceRoot, "fixtures/auth-regression/base");
  const headRoot = join(workspaceRoot, "fixtures/auth-regression/head");
  const configurationDigest = `sha256:${"c".repeat(64)}`;

  const [baseSha, headSha] = await Promise.all([
    computeSnapshotDigest(baseRoot),
    computeSnapshotDigest(headRoot),
  ]);
  const analysisId = deriveAnalysisId({
    provider: "local",
    baseSha,
    headSha,
    configurationDigest,
    engineVersion: ENGINE_VERSION,
  });
  const { privateKey } = generateKeyPairSync("ed25519");

  const output = await analyzeComparison({
    baseRoot,
    headRoot,
    engineVersion: ENGINE_VERSION,
    configurationDigest,
    executionProvider: new LocalExecutionProvider({ workspaceRoot }),
    artifactStore: new LocalArtifactStore({
      repositoryRoot: workspaceRoot,
      analysisId,
    }),
    testGenerator: new TemplateTestGenerator(),
    clock: { now: () => new Date() },
    signingKey: privateKey,
  });

  assertVerifiedManifest(output.signedManifest, output.publicKey);
  return toWorkspaceModel(output);
}

export const UNVERIFIED_MANIFEST_MESSAGE =
  "The Evidence Manifest signature could not be verified. CodeAtlas will not present this analysis as evidence.";

/**
 * The workspace may only render evidence whose signed manifest still verifies.
 * A modified manifest is refused here rather than displayed with a warning,
 * because a displayed finding is a claim that the evidence is real.
 */
export function assertVerifiedManifest(
  signed: unknown,
  publicKey: KeyObject,
): void {
  if (!verifyManifest(signed, publicKey)) {
    throw new Error(UNVERIFIED_MANIFEST_MESSAGE);
  }
}

/**
 * Project a terminal analysis into the serializable shape the workspace
 * renders. Every node and edge traces back to analyzer, selector, runner or
 * differential output; nothing here invents a relationship.
 */
export function toWorkspaceModel(output: AnalysisOutput): WorkspaceModel {
  const passport = output.passport;
  const nodes = new Map<string, WorkspaceNode>();
  const edges: WorkspaceEdge[] = [];

  for (const symbol of output.changedSymbols) {
    nodes.set(`symbol:${symbol.name}`, {
      id: `symbol:${symbol.name}`,
      label: `${symbol.name}()`,
      detail: "changed in this comparison",
      kind: "SYMBOL",
      state: "CHANGED",
      path: symbol.path,
      band: 0,
      generated: false,
    });
  }

  for (const finding of output.findings) {
    const path = finding.graphPath ?? finding.proofCard.affectedJourney;
    const names = path
      .split("→")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const failing = finding.state === "CONFIRMED_REGRESSION";

    for (const [index, name] of names.entries()) {
      const id = `symbol:${name}`;
      const isChanged = nodes.get(id)?.state === "CHANGED";
      const band: ContourBand = isChanged ? 0 : 1;
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          label: `${name}()`,
          detail: "reaches the changed symbol",
          kind: "SYMBOL",
          state: failing ? "FAILED" : "INFERRED",
          path: output.changedSymbols[0]?.path ?? "",
          band,
          generated: false,
        });
      } else if (failing && isChanged) {
        nodes.get(id)!.detail = "changed, and observed failing at runtime";
      }

      const previous = names[index - 1];
      if (previous === undefined) continue;
      edges.push({
        id: `edge:${previous}->${name}`,
        from: `symbol:${previous}`,
        to: id,
        relation: "CALLS",
        evidenceType: "RUNTIME_TRACE",
        observed: true,
        reason: `${previous}() reached ${name}() during the executed comparison.`,
      });
    }
  }

  for (const selection of output.selections) {
    const id = `test:${selection.path}`;
    nodes.set(id, {
      id,
      label: selection.path,
      detail: "existing test, selected and executed",
      kind: "TEST",
      state: "OBSERVED",
      path: selection.path,
      band: 2,
      generated: false,
    });
    const target = [...nodes.values()].find(
      (node) => node.kind === "SYMBOL" && node.band === 1,
    );
    if (target !== undefined) {
      edges.push({
        id: `edge:${selection.path}->${target.id}`,
        from: id,
        to: target.id,
        relation: "TESTS",
        evidenceType: "STATIC_AST",
        observed: false,
        reason:
          selection.reasons[0] ??
          "Selected because it reaches a changed symbol.",
      });
    }
  }

  for (const test of output.generatedTests) {
    const id = `test:${test.path}`;
    const failing = output.findings.some(
      (finding) => finding.state === "CONFIRMED_REGRESSION",
    );
    nodes.set(id, {
      id,
      label: test.path,
      detail: failing
        ? "generated test, passed on base and failed on head"
        : "generated test, executed on both revisions",
      kind: "TEST",
      state: failing ? "FAILED" : "OBSERVED",
      path: test.path,
      band: 2,
      generated: true,
    });
    const changed = [...nodes.values()].find((node) => node.band === 0);
    if (changed !== undefined) {
      edges.push({
        id: `edge:${test.path}->${changed.id}`,
        from: id,
        to: changed.id,
        relation: "COVERS",
        evidenceType: "DIFFERENTIAL_EXECUTION",
        observed: true,
        reason:
          "Executed on base and head; the observed responses differ at this symbol.",
      });
    }
  }

  const proofCards: WorkspaceProofCard[] = output.findings.map((finding) => ({
    findingId: finding.id,
    state: finding.state,
    title: finding.title,
    summary: finding.summary,
    baseBehavior: finding.proofCard.baseBehavior,
    headBehavior: finding.proofCard.headBehavior,
    affectedJourney: finding.proofCard.affectedJourney,
    graphPath: finding.graphPath ?? null,
    reproductionCommand: finding.proofCard.reproductionCommand,
    recommendedAction: finding.proofCard.recommendedAction,
    limitations: [...finding.proofCard.limitations],
    confidenceLevel: finding.confidence?.level ?? null,
    confidenceFactors: [...(finding.confidence?.factors ?? [])],
    evidenceIds: [...finding.proofCard.evidenceIds],
  }));

  return {
    analysisId: output.analysisId,
    baseSha: passport.baseSha,
    headSha: passport.headSha,
    engineVersion: passport.engineVersion,
    manifestDigest: passport.manifestDigest,
    retentionPolicy: passport.retentionPolicy,
    overallState: passport.overallState,
    impactTitle: impactTitle(passport.changedFiles),
    summary: passport.summary,
    changedFiles: [...passport.changedFiles],
    changedSymbols: output.changedSymbols.map(({ name, path }) => ({
      name,
      path,
    })),
    selections: output.selections.map(({ path, reasons }) => ({
      path,
      reasons: [...reasons],
    })),
    generatedTests: output.generatedTests.map((test) => ({
      path: test.path,
      objectiveId: test.objectiveId,
      executedOnBase: test.executedOnBase,
      executedOnHead: test.executedOnHead,
    })),
    unverifiedAreas: [...passport.unverifiedAreas],
    nodes: [...nodes.values()].sort(
      (left, right) => left.band - right.band || compare(left.id, right.id),
    ),
    edges: edges.sort((left, right) => compare(left.id, right.id)),
    proofCards,
  };
}

const DOMAIN_NAMES: Readonly<Record<string, string>> = Object.freeze({
  auth: "Authentication",
  api: "API",
  billing: "Billing",
  db: "Database",
  session: "Session",
});

/**
 * A readable heading for the impacted area, derived from the changed files
 * rather than authored per demo. This is presentation only; no evidence
 * depends on it.
 */
function impactTitle(changedFiles: readonly string[]): string {
  const first = changedFiles[0];
  if (first === undefined) return "Repository impact";
  const stem = (first.split("/").at(-1) ?? first).replace(/\.[^.]+$/u, "");
  const name =
    DOMAIN_NAMES[stem] ?? `${stem.charAt(0).toUpperCase()}${stem.slice(1)}`;
  return `${name} impact`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
