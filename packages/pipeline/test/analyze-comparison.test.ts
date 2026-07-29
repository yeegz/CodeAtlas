import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  analyzeSnapshot,
  computeSnapshotDigest,
} from "../../analyzer/src/index.js";
import { deriveAnalysisId, verifyManifest } from "../../evidence/src/index.js";
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
import * as PipelineModule from "../src/index.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const baseRoot = resolve(workspaceRoot, "fixtures/auth-regression/base");
const headRoot = resolve(workspaceRoot, "fixtures/auth-regression/head");
const configurationDigest = `sha256:${"c".repeat(64)}`;
const fixedTime = new Date("2026-07-29T00:00:00.000Z");
const fixtureAnalysisId = deriveAnalysisId({
  provider: "local",
  baseSha: "abc58c76e50aaf580628c06e9b6e29e770f18a79",
  headSha: "7cbef5433a2498f2c57fa5cd35ee0382b39ccbd2",
  configurationDigest,
  engineVersion: "0.1.0",
});

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
    replay: ["codeatlas", "replay", "finding_expired_session"],
  });
  expect(output.findings[0]?.proofCard.reproductionCommand).toBe(
    "codeatlas replay finding_expired_session",
  );
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

it("seeds selected-test coverage on base before any generated execution", async () => {
  const executionProvider = new FixtureExecutionProvider();

  const output = await analyzeComparison(fixtureRequest({ executionProvider }));

  expect(executionProvider.requests[0]).toEqual(
    expect.objectContaining({
      revision: "base",
      snapshotRoot: baseRoot,
      generatedFiles: [],
    }),
  );
  expect(output.runs[0]?.revision).toBe("base");
  expect(output.generatedTests).toHaveLength(1);
});

it("keeps a changed one-line condition uncovered when line coverage only visits its line", () => {
  expect("deriveObjectiveCoverage" in PipelineModule).toBe(true);
  const deriveObjectiveCoverage = (
    PipelineModule as unknown as {
      deriveObjectiveCoverage(
        coverage: ExecutionResult["coverage"],
        analysis: {
          snapshotSha: string;
          branches: Array<{
            id: string;
            kind: "if";
            source: {
              snapshotSha: string;
              path: string;
              startLine: number;
              endLine: number;
            };
            evidenceIds: string[];
          }>;
        },
        changedSymbols: Array<{
          id: string;
          name: string;
          path: string;
          baseLocation: null;
          headLocation: {
            snapshotSha: string;
            path: string;
            startLine: number;
            endLine: number;
          };
          changedLines: number[];
          signatureChanged: boolean;
        }>,
      ): ExecutionResult["coverage"];
    }
  ).deriveObjectiveCoverage;
  const snapshotSha = "a".repeat(40);

  expect(
    deriveObjectiveCoverage(
      [{ path: "src/auth.ts", coveredLines: [15, 22] }],
      {
        snapshotSha,
        branches: [
          {
            id: "branch:condition",
            kind: "if",
            source: {
              snapshotSha,
              path: "src/auth.ts",
              startLine: 15,
              endLine: 15,
            },
            evidenceIds: ["ev:condition"],
          },
        ],
      },
      [
        {
          id: "symbol:validateToken",
          name: "validateToken",
          path: "src/auth.ts",
          baseLocation: null,
          headLocation: {
            snapshotSha,
            path: "src/auth.ts",
            startLine: 15,
            endLine: 15,
          },
          changedLines: [15],
          signatureChanged: false,
        },
      ],
    ),
  ).toEqual([{ path: "src/auth.ts", coveredLines: [22] }]);
});

it.each([
  {
    name: "changed canonical content",
    mutate(test: Record<string, unknown>) {
      test.content = `${String(test.content)}\n// untrusted`;
    },
  },
  {
    name: "alternate path",
    mutate(test: Record<string, unknown>) {
      test.path = "test/alternate.test.ts";
    },
  },
  {
    name: "reordered evidence ids",
    mutate(test: Record<string, unknown>) {
      test.evidenceIds = [...(test.evidenceIds as string[])].reverse();
    },
  },
  {
    name: "changed expected behavior",
    mutate(test: Record<string, unknown>) {
      test.expectedBehavior = { httpStatus: 200, code: "OK" };
    },
  },
  {
    name: "extra field",
    mutate(test: Record<string, unknown>) {
      test.selfCertified = true;
    },
  },
] as const)(
  "rejects generated output with $name before execution",
  async ({ mutate }) => {
    const executionProvider = new FixtureExecutionProvider();
    const template = new TemplateTestGenerator();
    const testGenerator: TestGenerator = {
      async generate(objective) {
        const result = await template.generate(objective);
        if (result.state !== "GENERATED") return result;
        const test = structuredClone(result.test) as unknown as Record<
          string,
          unknown
        >;
        mutate(test);
        return { state: "GENERATED", test: test as never };
      },
    };

    await expect(
      analyzeComparison(fixtureRequest({ executionProvider, testGenerator })),
    ).rejects.toThrow(/generated test|generated output|candidate/i);
    expect(executionProvider.requests).toHaveLength(1);
  },
);

it.each([
  {
    name: "another analysis scope",
    createStore: () =>
      new MemoryArtifactStore(`analysis_${"f".repeat(64)}`, false),
  },
  {
    name: "another artifact kind",
    createStore: () =>
      new MemoryArtifactStore(fixtureAnalysisId, false, "wrong-kind"),
  },
])("rejects an artifact path in $name", async ({ createStore }) => {
  await expect(
    analyzeComparison(fixtureRequest({ artifactStore: createStore() })),
  ).rejects.toThrow(/artifact.*path|scope|kind/i);
});

it("canonicalizes equivalent reordered provider arrays before manifest signing", async () => {
  const keys = generateKeyPairSync("ed25519");
  const normal = await analyzeComparison(
    fixtureRequest({ signingKey: keys.privateKey }),
  );
  const reordered = await analyzeComparison(
    fixtureRequest({
      signingKey: keys.privateKey,
      executionProvider: new ReorderedExecutionProvider(),
    }),
  );
  const differentialDigest = (output: typeof normal) =>
    output.reproductionBundle.artifacts.find(
      ({ kind }) => kind === "differential-evidence",
    )?.digest;

  expect(differentialDigest(reordered)).toBe(differentialDigest(normal));
  expect(reordered.signedManifest.digest).toBe(normal.signedManifest.digest);
});

it("fails closed on a corrupt artifact round trip", async () => {
  const artifactStore = new MemoryArtifactStore(fixtureAnalysisId, true);
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
  const artifactStore = new MemoryArtifactStore(fixtureAnalysisId);

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
          `^\\.codeatlas/runs/${analysisId}/manifest-sha256-[0-9a-f]{64}\\.json$`,
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

  it("rejects traversal, symlink following, and digest tampering", async () => {
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

      const outside = join(repositoryRoot, "outside.json");
      await writeFile(outside, "{}", { mode: 0o600 });
      const linkedPath = resolve(
        repositoryRoot,
        `.codeatlas/runs/${analysisId}/linked-sha256-${"0".repeat(64)}.json`,
      );
      await symlink(outside, linkedPath);
      await expect(
        store.readJson(
          `.codeatlas/runs/${analysisId}/linked-sha256-${"0".repeat(64)}.json`,
        ),
      ).rejects.toThrow(/symlink|regular/i);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("rejects oversized artifacts before creating persistent storage", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "codeatlas-store-"));
    try {
      const store = new LocalArtifactStore({
        repositoryRoot,
        analysisId: `analysis_${"d".repeat(64)}`,
        maxReadBytes: 64,
      });

      await expect(
        store.putJson("large", { value: "x".repeat(256) }),
      ).rejects.toThrow(/size|large/i);
      expect(await readdir(repositoryRoot)).toEqual([]);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("rejects an existing artifact whose mode is not private", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "codeatlas-store-"));
    try {
      const store = new LocalArtifactStore({
        repositoryRoot,
        analysisId: `analysis_${"e".repeat(64)}`,
      });
      const artifact = await store.putJson("record", { safe: true });
      await chmod(resolve(repositoryRoot, artifact.path), 0o644);

      await expect(store.putJson("record", { safe: true })).rejects.toThrow(
        /mode|permission/i,
      );
      await expect(store.readJson(artifact.path)).rejects.toThrow(
        /mode|permission/i,
      );
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a mismatched pre-existing destination and cleans temporary files", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "codeatlas-store-"));
    try {
      const analysisId = `analysis_${"f".repeat(64)}`;
      const store = new LocalArtifactStore({ repositoryRoot, analysisId });
      await store.putJson("seed", {});
      const canonical = '{"safe":true}';
      const digest = createHash("sha256").update(canonical).digest("hex");
      const artifactDirectory = resolve(
        repositoryRoot,
        `.codeatlas/runs/${analysisId}`,
      );
      const destination = resolve(
        artifactDirectory,
        `record-sha256-${digest}.json`,
      );
      await writeFile(destination, '{"safe":false}', { mode: 0o600 });

      await expect(store.putJson("record", { safe: true })).rejects.toThrow(
        /digest|content|existing/i,
      );
      expect(await readdir(artifactDirectory)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/temporary/i)]),
      );
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("reuses a matching artifact without overwriting it", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "codeatlas-store-"));
    try {
      const store = new LocalArtifactStore({
        repositoryRoot,
        analysisId: `analysis_${"1".repeat(64)}`,
      });
      const first = await store.putJson("record", { safe: true });
      const before = await lstat(resolve(repositoryRoot, first.path), {
        bigint: true,
      });
      const second = await store.putJson("record", { safe: true });
      const after = await lstat(resolve(repositoryRoot, second.path), {
        bigint: true,
      });

      expect(second).toEqual(first);
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeNs).toBe(before.mtimeNs);
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
    artifactStore: new MemoryArtifactStore(fixtureAnalysisId),
    testGenerator: new TemplateTestGenerator(),
    clock: { now: () => fixedTime },
    signingKey: privateKey,
    ...overrides,
  };
}

class FixtureExecutionProvider implements ExecutionProvider {
  #sequence = 0;
  readonly requests: ExecutionRequest[] = [];

  constructor(private readonly mode: "complete" | "timeout" = "complete") {}

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    this.requests.push(structuredClone(request));
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
      coverage: [
        { path: "src/auth.ts", coveredLines: [22, 23, 24, 25, 26] },
        { path: "src/secondary.ts", coveredLines: [9, 3] },
      ],
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

  constructor(
    private readonly analysisId: string,
    private readonly corruptReads = false,
    private readonly returnedKind?: string,
  ) {}

  async putJson(kind: string, value: unknown) {
    const canonical = canonicalizeForTest(value);
    const digest = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
    const path = `.codeatlas/runs/${this.analysisId}/${this.returnedKind ?? kind}-sha256-${digest.slice(7)}.json`;
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

class ReorderedExecutionProvider implements ExecutionProvider {
  readonly #delegate = new FixtureExecutionProvider();

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    const original = await this.#delegate.run(request);
    const result = {
      ...original,
      testCases: [...original.testCases].reverse(),
      coverage: [...original.coverage].reverse().map((item) => ({
        ...item,
        coveredLines: [...item.coveredLines].reverse(),
      })),
      observations: [...original.observations].reverse(),
    };
    const { resultDigest: _digest, ...bound } = result;
    void _digest;
    return { ...bound, resultDigest: computeExecutionResultDigest(bound) };
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
