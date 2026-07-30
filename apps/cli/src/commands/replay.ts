import { readFile, readdir } from "node:fs/promises";
import { createPublicKey, type KeyObject } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { computeSnapshotDigest } from "@codeatlas/analyzer";
import { verifyManifest } from "@codeatlas/evidence";
import { LocalArtifactStore } from "@codeatlas/pipeline";
import {
  LocalExecutionProvider,
  type ExecutionResult,
} from "@codeatlas/runner";

import {
  EXECUTION_POLICY,
  ExitCode,
  SecurityPolicyError,
  describeBehavior,
  isNotFound,
  resolveExistingDirectory,
} from "../shared.js";

export interface ReplayOptions {
  base?: string;
  head?: string;
  workspace?: string;
  json?: boolean;
}

const INTEGRITY_FAILURE = "Bundle integrity verification failed";
const ANALYSIS_ID = /^analysis_[0-9a-f]{64}$/u;
const ARTIFACT_NAME = /^([a-z][a-z0-9-]{0,63})-sha256-([0-9a-f]{64})\.json$/u;
const SHA256_DIGEST = /^sha256:([0-9a-f]{64})$/u;
const SNAPSHOT_SHA = /^[0-9a-f]{40}$/u;
const FINDING_ID = /^finding_[A-Za-z0-9_-]{1,128}$/u;

type ReplayOutcome = "REPRODUCED" | "NOT_REPRODUCED" | "ENVIRONMENT_MISMATCH";

interface ReproductionArtifact {
  kind: string;
  digest: string;
  path: string;
}

interface ReproductionBundle {
  schemaVersion: string;
  analysisId: string;
  baseSha: string;
  headSha: string;
  engineVersion: string;
  manifestDigest: string;
  findingIds: string[];
  artifacts: ReproductionArtifact[];
  commands: { base: string[]; head: string[]; replay: string[] };
}

interface GeneratedTestRecord {
  path: string;
  content: string;
  objectiveId: string;
  evidenceIds: string[];
  expectedBehavior: { httpStatus: number; code: string };
}

interface ReplaySources {
  workspaceRoot?: string;
  baseRoot?: string;
  headRoot?: string;
}

export async function runReplay(
  target: string,
  options: ReplayOptions,
  stdout: NodeJS.WritableStream,
): Promise<number> {
  const workspaceRoot = await resolveExistingDirectory(
    options.workspace ?? process.cwd(),
    "workspace",
  );

  const located = await locateBundle(target, workspaceRoot);
  const bundle = parseBundle(located.contents);
  const findingId = located.findingId ?? bundle.findingIds[0];
  if (findingId === undefined || !bundle.findingIds.includes(findingId)) {
    throw new SecurityPolicyError(
      `${INTEGRITY_FAILURE}: the bundle does not record ${findingId ?? "any finding"}`,
    );
  }

  // Integrity gate. Everything below runs before a single test process is
  // created, so a tampered bundle can never execute anything.
  assertArtifactDigestsAreSelfConsistent(bundle);

  const store = new LocalArtifactStore({
    repositoryRoot: workspaceRoot,
    analysisId: bundle.analysisId,
  });
  const artifacts = await readArtifacts(store, bundle);

  const signed = artifacts.get("signed-manifest") as
    { manifest?: { analysisId?: unknown }; digest?: unknown } | undefined;
  if (signed === undefined || typeof signed.manifest !== "object") {
    throw new SecurityPolicyError(
      `${INTEGRITY_FAILURE}: the bundle records no signed manifest`,
    );
  }
  if (signed.digest !== bundle.manifestDigest) {
    throw new SecurityPolicyError(
      `${INTEGRITY_FAILURE}: manifest digest does not match the bundle`,
    );
  }
  if (signed.manifest?.analysisId !== bundle.analysisId) {
    throw new SecurityPolicyError(
      `${INTEGRITY_FAILURE}: manifest analysis id does not match the bundle`,
    );
  }

  const publicKey = await readPublicKey(located.directory);
  if (publicKey !== undefined && !verifyManifest(signed, publicKey)) {
    throw new SecurityPolicyError(
      `${INTEGRITY_FAILURE}: manifest signature verification failed`,
    );
  }

  const generatedTests = readGeneratedTests(artifacts.get("generated-tests"));
  if (generatedTests.length === 0) {
    throw new SecurityPolicyError(
      `${INTEGRITY_FAILURE}: the bundle records no generated test to replay`,
    );
  }
  const recordedRuns = readRecordedRuns(artifacts.get("execution-runs"));

  const sources = await readReplaySources(located.directory);
  const baseCandidate = options.base ?? sources.baseRoot;
  const headCandidate = options.head ?? sources.headRoot;
  if (baseCandidate === undefined || headCandidate === undefined) {
    throw new SecurityPolicyError(
      "replay needs --base and --head when the bundle directory has no replay-sources.json",
    );
  }
  const baseRoot = await resolveExistingDirectory(
    baseCandidate,
    "base snapshot",
  );
  const headRoot = await resolveExistingDirectory(
    headCandidate,
    "head snapshot",
  );

  const [baseSha, headSha] = await Promise.all([
    computeSnapshotDigest(baseRoot),
    computeSnapshotDigest(headRoot),
  ]);
  if (baseSha !== bundle.baseSha || headSha !== bundle.headSha) {
    return report(
      stdout,
      options,
      "ENVIRONMENT_MISMATCH",
      findingId,
      "The supplied snapshots do not match the recorded base and head digests.",
    );
  }

  const provider = new LocalExecutionProvider({ workspaceRoot });
  const generatedFiles = generatedTests.map(toGeneratedFile);
  const [baseRun, headRun] = await Promise.all([
    provider.run({
      analysisId: bundle.analysisId,
      revision: "base",
      snapshotRoot: baseRoot,
      snapshotSha: baseSha,
      testPaths: [],
      generatedFiles,
      policy: { ...EXECUTION_POLICY },
    }),
    provider.run({
      analysisId: bundle.analysisId,
      revision: "head",
      snapshotRoot: headRoot,
      snapshotSha: headSha,
      testPaths: [],
      generatedFiles,
      policy: { ...EXECUTION_POLICY },
    }),
  ]);

  const recordedEnvironments = new Set(
    recordedRuns.map(({ environmentDigest }) => environmentDigest),
  );
  if (
    recordedEnvironments.size > 0 &&
    (!recordedEnvironments.has(baseRun.environmentDigest) ||
      !recordedEnvironments.has(headRun.environmentDigest))
  ) {
    return report(
      stdout,
      options,
      "ENVIRONMENT_MISMATCH",
      findingId,
      "The local runtime environment digest differs from the recorded analysis.",
    );
  }

  if (
    baseRun.terminalState !== "COMPLETED" ||
    headRun.terminalState !== "COMPLETED"
  ) {
    return report(
      stdout,
      options,
      "ENVIRONMENT_MISMATCH",
      findingId,
      `Replay did not complete on both revisions (base ${baseRun.terminalState}, head ${headRun.terminalState}).`,
    );
  }

  const objectiveId = generatedTests[0]!.objectiveId;
  const baseBehavior = observedBehavior(baseRun, objectiveId);
  const headBehavior = observedBehavior(headRun, objectiveId);
  const basePassed = caseStatus(baseRun, objectiveId) === "PASSED";
  const headFailed = caseStatus(headRun, objectiveId) === "FAILED";

  if (
    !basePassed ||
    !headFailed ||
    baseBehavior === undefined ||
    headBehavior === undefined ||
    baseBehavior === headBehavior
  ) {
    return report(
      stdout,
      options,
      "NOT_REPRODUCED",
      findingId,
      `Observed base ${baseBehavior ?? "no parsed behavior"} and head ${headBehavior ?? "no parsed behavior"}.`,
    );
  }

  return report(
    stdout,
    options,
    "REPRODUCED",
    findingId,
    `Base produced ${baseBehavior}; head produced ${headBehavior}.`,
  );
}

function report(
  stdout: NodeJS.WritableStream,
  options: ReplayOptions,
  outcome: ReplayOutcome,
  findingId: string,
  detail: string,
): number {
  if (options.json === true) {
    stdout.write(
      `${JSON.stringify({ outcome, findingId, detail }, null, 2)}\n`,
    );
  } else {
    stdout.write(`${detail}\n${outcome} ${findingId}\n`);
  }
  switch (outcome) {
    case "REPRODUCED":
      return ExitCode.VERIFIED;
    case "NOT_REPRODUCED":
      return ExitCode.ACTION_REQUIRED;
    default:
      return ExitCode.PARTIAL;
  }
}

interface LocatedBundle {
  contents: string;
  directory: string;
  findingId: string | undefined;
}

/**
 * `target` is either a path to a reproduction bundle or the finding id printed
 * on a Proof Card. A finding id is resolved by scanning the local run store.
 */
async function locateBundle(
  target: string,
  workspaceRoot: string,
): Promise<LocatedBundle> {
  if (target.length === 0 || target.includes("\0")) {
    throw new SecurityPolicyError("replay target is not a valid argument");
  }

  const asPath = resolve(target);
  try {
    return {
      contents: await readFile(asPath, "utf8"),
      directory: dirname(asPath),
      findingId: undefined,
    };
  } catch (error) {
    if (!isNotFound(error) && !isDirectory(error)) throw error;
  }

  if (!FINDING_ID.test(target)) {
    throw new SecurityPolicyError(
      `replay target is neither a readable bundle nor a finding id: ${target}`,
    );
  }

  const runsRoot = join(workspaceRoot, ".codeatlas", "runs");
  let analyses: string[];
  try {
    analyses = await readdir(runsRoot);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    throw new SecurityPolicyError(
      `no local analyses are stored under ${runsRoot}`,
    );
  }

  const ordered = analyses.filter((name) => ANALYSIS_ID.test(name)).sort();
  for (const analysis of ordered) {
    const directory = join(runsRoot, analysis);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      continue;
    }
    for (const name of names.sort()) {
      if (!name.startsWith("reproduction-bundle-")) continue;
      const contents = await readFile(join(directory, name), "utf8");
      let candidate: ReproductionBundle;
      try {
        candidate = parseBundle(contents);
      } catch {
        continue;
      }
      if (candidate.findingIds.includes(target)) {
        return { contents, directory, findingId: target };
      }
    }
  }

  throw new SecurityPolicyError(
    `no stored reproduction bundle records ${target}`,
  );
}

function isDirectory(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EISDIR";
}

function parseBundle(contents: string): ReproductionBundle {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new SecurityPolicyError(`${INTEGRITY_FAILURE}: bundle is not JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SecurityPolicyError(
      `${INTEGRITY_FAILURE}: bundle is not an object`,
    );
  }
  const record = value as Record<string, unknown>;
  const commands = record.commands as Record<string, unknown> | undefined;
  if (
    record.schemaVersion !== "1.0" ||
    typeof record.analysisId !== "string" ||
    !ANALYSIS_ID.test(record.analysisId) ||
    typeof record.baseSha !== "string" ||
    !SNAPSHOT_SHA.test(record.baseSha) ||
    typeof record.headSha !== "string" ||
    !SNAPSHOT_SHA.test(record.headSha) ||
    typeof record.engineVersion !== "string" ||
    record.engineVersion.length === 0 ||
    typeof record.manifestDigest !== "string" ||
    !SHA256_DIGEST.test(record.manifestDigest) ||
    !Array.isArray(record.findingIds) ||
    record.findingIds.length === 0 ||
    record.findingIds.some((id) => typeof id !== "string" || id.length === 0) ||
    !Array.isArray(record.artifacts) ||
    record.artifacts.length === 0 ||
    typeof commands !== "object" ||
    commands === null ||
    !Array.isArray(commands.base) ||
    !Array.isArray(commands.head) ||
    !Array.isArray(commands.replay)
  ) {
    throw new SecurityPolicyError(
      `${INTEGRITY_FAILURE}: bundle does not match the reproduction schema`,
    );
  }
  const artifacts = record.artifacts.map((artifact) => {
    if (
      typeof artifact !== "object" ||
      artifact === null ||
      typeof (artifact as ReproductionArtifact).kind !== "string" ||
      typeof (artifact as ReproductionArtifact).digest !== "string" ||
      typeof (artifact as ReproductionArtifact).path !== "string"
    ) {
      throw new SecurityPolicyError(
        `${INTEGRITY_FAILURE}: bundle records an invalid artifact`,
      );
    }
    return artifact as ReproductionArtifact;
  });
  return {
    schemaVersion: record.schemaVersion,
    analysisId: record.analysisId,
    baseSha: record.baseSha,
    headSha: record.headSha,
    engineVersion: record.engineVersion,
    manifestDigest: record.manifestDigest,
    findingIds: record.findingIds as string[],
    artifacts,
    commands: {
      base: commands.base as string[],
      head: commands.head as string[],
      replay: commands.replay as string[],
    },
  };
}

/**
 * Artifact paths are content addressed, so a recorded digest that disagrees
 * with the digest embedded in its own path is proof of tampering. This runs
 * before any file is opened and before any process is started.
 */
function assertArtifactDigestsAreSelfConsistent(
  bundle: ReproductionBundle,
): void {
  for (const artifact of bundle.artifacts) {
    const digestMatch = artifact.digest.match(SHA256_DIGEST);
    if (digestMatch === null) {
      throw new SecurityPolicyError(
        `${INTEGRITY_FAILURE}: ${artifact.kind} has a malformed digest`,
      );
    }
    const name = artifact.path.split("/").at(-1) ?? "";
    const nameMatch = name.match(ARTIFACT_NAME);
    if (nameMatch === null) {
      throw new SecurityPolicyError(
        `${INTEGRITY_FAILURE}: ${artifact.kind} has a malformed artifact path`,
      );
    }
    if (nameMatch[1] !== artifact.kind || nameMatch[2] !== digestMatch[1]) {
      throw new SecurityPolicyError(
        `${INTEGRITY_FAILURE}: ${artifact.kind} digest does not match its content address`,
      );
    }
    if (artifact.path !== `.codeatlas/runs/${bundle.analysisId}/${name}`) {
      throw new SecurityPolicyError(
        `${INTEGRITY_FAILURE}: ${artifact.kind} is stored outside the analysis directory`,
      );
    }
  }
}

async function readArtifacts(
  store: LocalArtifactStore,
  bundle: ReproductionBundle,
): Promise<Map<string, unknown>> {
  const artifacts = new Map<string, unknown>();
  for (const artifact of bundle.artifacts) {
    try {
      artifacts.set(artifact.kind, await store.readJson(artifact.path));
    } catch (error) {
      throw new SecurityPolicyError(
        `${INTEGRITY_FAILURE}: ${artifact.kind} could not be verified (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }
  return artifacts;
}

async function readPublicKey(
  directory: string,
): Promise<KeyObject | undefined> {
  let contents: string;
  try {
    contents = await readFile(join(directory, "evidence-manifest.sig"), "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new SecurityPolicyError(
      `${INTEGRITY_FAILURE}: evidence-manifest.sig is not JSON`,
    );
  }
  const key = (parsed as { publicKey?: unknown } | null)?.publicKey;
  if (typeof key !== "string" || key.length === 0) return undefined;
  try {
    return createPublicKey(key);
  } catch {
    throw new SecurityPolicyError(
      `${INTEGRITY_FAILURE}: evidence-manifest.sig has no usable public key`,
    );
  }
}

async function readReplaySources(directory: string): Promise<ReplaySources> {
  let contents: string;
  try {
    contents = await readFile(join(directory, "replay-sources.json"), "utf8");
  } catch (error) {
    if (isNotFound(error)) return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as ReplaySources;
  } catch {
    return {};
  }
}

function readGeneratedTests(value: unknown): GeneratedTestRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is GeneratedTestRecord =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as GeneratedTestRecord).path === "string" &&
      typeof (entry as GeneratedTestRecord).content === "string" &&
      typeof (entry as GeneratedTestRecord).objectiveId === "string" &&
      Array.isArray((entry as GeneratedTestRecord).evidenceIds) &&
      typeof (entry as GeneratedTestRecord).expectedBehavior === "object",
  );
}

function readRecordedRuns(value: unknown): ExecutionResult[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ExecutionResult =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ExecutionResult).environmentDigest === "string",
  );
}

function toGeneratedFile(test: GeneratedTestRecord) {
  return {
    path: test.path,
    content: test.content,
    objectiveId: test.objectiveId,
    evidenceIds: [...test.evidenceIds],
    expectedBehavior: { ...test.expectedBehavior },
  };
}

function caseStatus(
  run: ExecutionResult,
  objectiveId: string,
): "PASSED" | "FAILED" | "SKIPPED" | undefined {
  return run.testCases.find(
    (testCase) => testCase.generatedObjectiveId === objectiveId,
  )?.status;
}

function observedBehavior(
  run: ExecutionResult,
  objectiveId: string,
): string | undefined {
  const observation = run.observations.find(
    (item) => item.generatedObjectiveId === objectiveId,
  );
  return observation === undefined
    ? undefined
    : describeBehavior(observation.actual);
}
