import { createHash, generateKeyPairSync } from "node:crypto";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  analyzeSnapshot,
  computeSnapshotDigest,
} from "../../analyzer/src/index.js";
import { verifyManifest } from "../../evidence/src/index.js";
import {
  TemplateTestGenerator,
  type TestGenerationResult,
  type TestGenerator,
  type TestObjective,
} from "../../generator/src/index.js";
import {
  LocalExecutionProvider,
  computeExecutionResultDigest,
  type ExecutionProvider,
  type ExecutionRequest,
  type ExecutionResult,
} from "../../runner/src/index.js";
import { selectTests } from "../../selector/src/index.js";
import { describe, expect, it } from "vitest";

import {
  LocalArtifactStore,
  analyzeComparison,
  deriveSelectionEdges,
  type AnalyzeComparisonRequest,
  type ArtifactStore,
} from "../src/index.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const baseRoot = resolve(workspaceRoot, "fixtures/auth-regression/base");
const headRoot = resolve(workspaceRoot, "fixtures/auth-regression/head");
const configurationDigest = `sha256:${"c".repeat(64)}`;
const fixedTime = new Date("2026-07-29T00:00:00.000Z");

it("derives a deterministic, snapshot-bound test edge only from analyzed imports and test sites", async () => {
  const snapshotSha = await computeSnapshotDigest(headRoot);
  const analysis = await analyzeSnapshot({ root: headRoot, snapshotSha });

  const edges = deriveSelectionEdges(analysis);
  const authTest = analysis.tests.find(
    ({ path }) => path === "test/auth.test.ts",
  );
  const restoreSession = analysis.symbols.find(
    ({ name }) => name === "restoreSession",
  );
  const testEdge = edges.find(
    ({ from, to, relation }) =>
      from === authTest?.id &&
      to === restoreSession?.id &&
      relation === "TESTS",
  );

  expect(testEdge).toEqual(
    expect.objectContaining({
      fromName: "restores a valid session",
      toName: "restoreSession",
      evidenceType: "STATIC_AST",
      snapshotSha,
    }),
  );
  expect(testEdge?.evidenceIds.length).toBeGreaterThan(0);
  for (const evidenceId of testEdge?.evidenceIds ?? []) {
    expect(
      analysis.evidence.find(({ id }) => id === evidenceId)?.source
        ?.snapshotSha,
    ).toBe(snapshotSha);
  }
  expect(
    selectTests({
      changedSymbolIds: [
        analysis.symbols.find(({ name }) => name === "validateToken")!.id,
      ],
      changedSymbols: [
        analysis.symbols.find(({ name }) => name === "validateToken")!,
      ],
      analysis,
      tests: analysis.tests,
      edges,
    }).map(({ path }) => path),
  ).toEqual(["test/auth.test.ts"]);
});

it("runs the complete authentication proof workflow from canonical upstream records", async () => {
  const output = await analyzeComparison(fixtureRequest());

  expect(output.changedSymbols.map((symbol) => symbol.name)).toEqual([
    "validateToken",
  ]);
  expect(output.selections[0]?.path).toBe("test/auth.test.ts");
  expect(output.generatedTests[0]).toEqual(
    expect.objectContaining({ executedOnBase: true, executedOnHead: true }),
  );
  expect(output.passport.overallState).toBe("ACTION_REQUIRED");
  expect(output.findings[0]?.state).toBe("CONFIRMED_REGRESSION");
  expect(verifyManifest(output.signedManifest, output.publicKey)).toBe(true);
  expect(output.runs).toHaveLength(7);
  expect(
    output.runs.filter((run) =>
      run.testCases.some(
        ({ generatedObjectiveId }) => generatedObjectiveId !== null,
      ),
    ),
  ).toHaveLength(6);
  expect(output.reproductionBundle.commands).toEqual({
    base: [
      "pnpm",
      "vitest",
      "run",
      "test/auth.test.ts",
      "test/codeatlas.expired-session.test.ts",
    ],
    head: [
      "pnpm",
      "vitest",
      "run",
      "test/auth.test.ts",
      "test/codeatlas.expired-session.test.ts",
    ],
    replay: "codeatlas replay finding_expired_session",
  });
});

it("keeps canonical signed output stable while attempt ids remain unique outside it", async () => {
  const keys = generateKeyPairSync("ed25519");
  const first = await analyzeComparison(
    fixtureRequest({ signingKey: keys.privateKey }),
  );
  const second = await analyzeComparison(
    fixtureRequest({ signingKey: keys.privateKey }),
  );

  expect(second.analysisId).toBe(first.analysisId);
  expect(second.signedManifest.digest).toBe(first.signedManifest.digest);
  expect(second.signedManifest.signature).toBe(first.signedManifest.signature);
  expect(second.attemptId).not.toBe(first.attemptId);
  expect(JSON.stringify(first.signedManifest)).not.toContain(first.attemptId);
  expect(JSON.stringify(second.signedManifest)).not.toContain(second.attemptId);
});

it("fails closed on a corrupt artifact round trip", async () => {
  const artifactStore = new MemoryArtifactStore(true);
  await expect(
    analyzeComparison(fixtureRequest({ artifactStore })),
  ).rejects.toThrow(/artifact.*(?:digest|mismatch|schema)/i);
});

it("fails closed on incomplete generated execution", async () => {
  await expect(
    analyzeComparison(
      fixtureRequest({
        executionProvider: new FixtureExecutionProvider("timeout"),
      }),
    ),
  ).rejects.toThrow(/incomplete|terminal/i);
});

it("fails closed when deterministic generation does not support an objective", async () => {
  const unsupported: TestGenerator = {
    async generate(objective: TestObjective): Promise<TestGenerationResult> {
      return {
        state: "UNSUPPORTED_OBJECTIVE",
        objectiveId: objective.id,
        reason: "disabled by fixture policy",
      };
    },
  };

  await expect(
    analyzeComparison(fixtureRequest({ testGenerator: unsupported })),
  ).rejects.toThrow(/unsupported.*disabled by fixture policy/i);
});

it("fails closed on signing failure and never sends private key material to storage", async () => {
  const keys = generateKeyPairSync("ed25519");
  const artifactStore = new MemoryArtifactStore();

  await expect(
    analyzeComparison(
      fixtureRequest({ artifactStore, signingKey: keys.publicKey }),
    ),
  ).rejects.toThrow(/sign/i);
  const persisted = canonicalizeForTest([...artifactStore.values.values()]);
  expect(persisted).not.toContain("PRIVATE KEY");
  expect(persisted).not.toContain(
    keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  );
});

describe("LocalArtifactStore", () => {
  it("writes canonical content-addressed JSON atomically with restrictive permissions", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "codeatlas-store-"));
    try {
      const analysisId = `analysis_${"a".repeat(64)}`;
      const store = new LocalArtifactStore({ repositoryRoot, analysisId });
      const first = await store.putJson("manifest", { z: 1, a: 2 });
      const second = await store.putJson("manifest", { a: 2, z: 1 });

      expect(second).toEqual(first);
      expect(first.path).toMatch(
        new RegExp(
          `^\\.codeatlas/runs/${analysisId}/manifest-[0-9a-f]{64}\\.json$`,
        ),
      );
      expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(await store.readJson(first.path)).toEqual({ a: 2, z: 1 });
      const info = await lstat(resolve(repositoryRoot, first.path));
      expect(info.isFile()).toBe(true);
      expect(info.mode & 0o077).toBe(0);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it.each(["../manifest", "manifest/escape", "manifest\\escape", "", "."])(
    "rejects the unsafe artifact kind %j",
    async (kind) => {
      const repositoryRoot = await mkdtemp(join(tmpdir(), "codeatlas-store-"));
      try {
        const store = new LocalArtifactStore({
          repositoryRoot,
          analysisId: `analysis_${"b".repeat(64)}`,
        });
        await expect(store.putJson(kind, {})).rejects.toThrow(/kind/i);
      } finally {
        await rm(repositoryRoot, { recursive: true, force: true });
      }
    },
  );

  it("rejects traversal, symlink following, digest tampering, and oversized reads", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "codeatlas-store-"));
    try {
      const analysisId = `analysis_${"c".repeat(64)}`;
      const store = new LocalArtifactStore({
        repositoryRoot,
        analysisId,
        maxReadBytes: 128,
      });
      const artifact = await store.putJson("record", { safe: true });
      await expect(store.readJson("../secret.json")).rejects.toThrow(/path/i);

      await writeFile(
        resolve(repositoryRoot, artifact.path),
        '{"safe":false}',
        {
          mode: 0o600,
        },
      );
      await expect(store.readJson(artifact.path)).rejects.toThrow(/digest/i);

      const large = await store.putJson("large", { value: "x".repeat(256) });
      await expect(store.readJson(large.path)).rejects.toThrow(/size|large/i);

      const outside = join(repositoryRoot, "outside.json");
      await writeFile(outside, "{}", { mode: 0o600 });
      const linkedPath = resolve(
        repositoryRoot,
        `.codeatlas/runs/${analysisId}/linked-${"0".repeat(64)}.json`,
      );
      await symlink(outside, linkedPath);
      await expect(
        store.readJson(
          `.codeatlas/runs/${analysisId}/linked-${"0".repeat(64)}.json`,
        ),
      ).rejects.toThrow(/symlink|regular/i);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });
});

it("completes once with the genuine local provider and authentication fixture", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "codeatlas-pipeline-e2e-"));
  try {
    const baseSha = await computeSnapshotDigest(baseRoot);
    const headSha = await computeSnapshotDigest(headRoot);
    const { deriveAnalysisId } = await import("../../evidence/src/index.js");
    const analysisId = deriveAnalysisId({
      provider: "local",
      baseSha,
      headSha,
      configurationDigest,
      engineVersion: "0.1.0",
    });
    const { privateKey } = generateKeyPairSync("ed25519");
    const output = await analyzeComparison({
      baseRoot,
      headRoot,
      engineVersion: "0.1.0",
      configurationDigest,
      executionProvider: new LocalExecutionProvider({ workspaceRoot }),
      artifactStore: new LocalArtifactStore({
        repositoryRoot: artifactRoot,
        analysisId,
      }),
      testGenerator: new TemplateTestGenerator(),
      clock: { now: () => fixedTime },
      signingKey: privateKey,
    });

    expect(output.findings[0]?.state).toBe("CONFIRMED_REGRESSION");
    expect(output.runs).toHaveLength(7);
    expect(
      output.runs.every(({ terminalState }) => terminalState === "COMPLETED"),
    ).toBe(true);
    expect(
      output.reproductionBundle.artifacts.every(
        ({ path }) => !path.startsWith("/"),
      ),
    ).toBe(true);
    expect(JSON.stringify(output.reproductionBundle)).not.toContain(
      workspaceRoot,
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
}, 180_000);

function fixtureRequest(
  overrides: Partial<AnalyzeComparisonRequest> = {},
): AnalyzeComparisonRequest {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    baseRoot,
    headRoot,
    engineVersion: "0.1.0",
    configurationDigest,
    executionProvider: new FixtureExecutionProvider(),
    artifactStore: new MemoryArtifactStore(),
    testGenerator: new TemplateTestGenerator(),
    clock: { now: () => fixedTime },
    signingKey: privateKey,
    ...overrides,
  };
}

class FixtureExecutionProvider implements ExecutionProvider {
  #sequence = 0;

  constructor(private readonly mode: "complete" | "timeout" = "complete") {}

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    this.#sequence += 1;
    const generated = request.generatedFiles[0];
    const timedOut =
      this.mode === "timeout" &&
      generated !== undefined &&
      request.revision === "head";
    const generatedStatus = request.revision === "base" ? "PASSED" : "FAILED";
    const result = {
      executionId: `00000000-0000-4000-${request.revision === "base" ? "8" : "9"}000-${String(this.#sequence).padStart(12, "0")}`,
      revision: request.revision,
      snapshotSha: request.snapshotSha,
      terminalState: timedOut ? ("TIMED_OUT" as const) : ("COMPLETED" as const),
      exitCode: timedOut
        ? null
        : generatedStatus === "FAILED" && generated
          ? 1
          : 0,
      durationMs: 10,
      testCases: [
        ...request.testPaths.map((path) => ({
          name: "restoreSession restores a valid session",
          path,
          status: "PASSED" as const,
          failureMessage: null,
          generatedObjectiveId: null,
        })),
        ...(generated
          ? [
              {
                name: "generated: expired session regression returns SESSION_EXPIRED for a non-refreshable expired token",
                path: generated.path,
                status: timedOut ? ("SKIPPED" as const) : generatedStatus,
                failureMessage:
                  generatedStatus === "FAILED" && !timedOut
                    ? "assertion failed"
                    : null,
                generatedObjectiveId: generated.objectiveId,
              },
            ]
          : []),
      ],
      coverage: [{ path: "src/auth.ts", coveredLines: [22, 23, 24, 25, 26] }],
      observations:
        generated && request.revision === "head" && !timedOut
          ? [
              {
                testName:
                  "generated: expired session regression returns SESSION_EXPIRED for a non-refreshable expired token",
                path: generated.path,
                generatedObjectiveId: generated.objectiveId,
                source: "TEST_ASSERTION" as const,
                expected: { httpStatus: 401, code: "SESSION_EXPIRED" },
                actual: { httpStatus: 500, code: "INTERNAL_ERROR" },
              },
            ]
          : [],
      stdout: "",
      stderr: "",
      environmentDigest: "fixture-environment",
    };
    return { ...result, resultDigest: computeExecutionResultDigest(result) };
  }
}

class MemoryArtifactStore implements ArtifactStore {
  readonly values = new Map<string, unknown>();

  constructor(private readonly corruptReads = false) {}

  async putJson(kind: string, value: unknown) {
    const canonical = canonicalizeForTest(value);
    const digest = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
    const path = `.codeatlas/runs/memory/${kind}-${digest.slice(7)}.json`;
    this.values.set(path, JSON.parse(canonical));
    return { digest, path };
  }

  async readJson<T>(path: string): Promise<T> {
    const value = this.values.get(path);
    if (value === undefined) throw new Error("missing artifact");
    const copy = structuredClone(value) as T;
    return this.corruptReads ? ({ corrupt: copy } as T) : copy;
  }
}

function canonicalizeForTest(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeForTest(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeForTest(item)}`)
    .join(",")}}`;
}
