import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { computeSnapshotDigest } from "../../analyzer/src/index.js";
import {
  LocalExecutionProvider,
  type LocalExecutionProviderOptions,
} from "../src/local-execution-provider.js";
import type { ExecutionRequest } from "../src/execution-provider.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const snapshotShas = {
  base: "abc58c76e50aaf580628c06e9b6e29e770f18a79",
  head: "7cbef5433a2498f2c57fa5cd35ee0382b39ccbd2",
} as const;

function request(revision: "base" | "head"): ExecutionRequest {
  return {
    analysisId: `analysis-${revision}`,
    revision,
    snapshotRoot: resolve(
      workspaceRoot,
      `fixtures/auth-regression/${revision}`,
    ),
    snapshotSha: snapshotShas[revision],
    testPaths: ["test/auth.test.ts"],
    generatedFiles: [],
    policy: { timeoutMs: 10_000, maxOutputBytes: 64 * 1024, maxFiles: 20 },
  };
}

describe("LocalExecutionProvider", () => {
  it("runs the selected auth test against both snapshot revisions", async () => {
    const provider = new LocalExecutionProvider({ workspaceRoot });
    const dependenciesBefore = await workspaceDependencyState();

    const [base, head] = await Promise.all([
      provider.run(request("base")),
      provider.run(request("head")),
    ]);

    for (const result of [base, head]) {
      expect(result.terminalState, JSON.stringify(result)).toBe("COMPLETED");
      expect(result.testCases).toHaveLength(1);
      expect(result.testCases[0]?.status).toBe("PASSED");
      expect(result.coverage).toHaveLength(1);
      expect(result.coverage[0]?.path).toBe("src/auth.ts");
      expect(result.coverage[0]?.coveredLines.length).toBeGreaterThan(0);
      expect(
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
      ).toBeLessThan(64 * 1024);
    }
    expect(base.snapshotSha).toBe(snapshotShas.base);
    expect(head.snapshotSha).toBe(snapshotShas.head);
    expect(base.snapshotSha).not.toBe(head.snapshotSha);
    expect(base.environmentDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(head.environmentDigest).toBe(base.environmentDigest);
    expect(await workspaceDependencyState()).toEqual(dependenciesBefore);
  }, 20_000);

  it("terminates a real Vitest run at the timeout without retrying and cleans up", async () => {
    const temporaryParent = await mkdtemp(
      join(tmpdir(), "codeatlas-timeout-test-"),
    );
    try {
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        temporaryParent,
      });
      const result = await provider.run({
        ...request("base"),
        testPaths: [],
        generatedFiles: [
          {
            path: "test/timeout.generated.test.ts",
            content:
              'import { it } from "vitest";\nit("waits", async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });\n',
            objectiveId: "timeout-objective",
            evidenceIds: ["evidence-timeout"],
            expectedBehavior: { httpStatus: 200, code: "OK" },
          },
        ],
        policy: { timeoutMs: 50, maxOutputBytes: 64 * 1024, maxFiles: 10 },
      });

      expect(result.terminalState).toBe("TIMED_OUT");
      expect(result.exitCode).toBeNull();
      expect(result.testCases).toMatchObject([
        {
          path: "test/timeout.generated.test.ts",
          status: "SKIPPED",
          generatedObjectiveId: "timeout-objective",
        },
      ]);
      expect(await readdir(temporaryParent)).toEqual([]);
    } finally {
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("stops a real Vitest run at the aggregate output cap and cleans up", async () => {
    const temporaryParent = await mkdtemp(
      join(tmpdir(), "codeatlas-output-test-"),
    );
    try {
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        temporaryParent,
      });
      const result = await provider.run({
        ...request("base"),
        testPaths: [],
        generatedFiles: [
          {
            path: "test/output.generated.test.ts",
            content:
              'import { it } from "vitest";\nit("prints bounded output", async () => { console.log("API_TOKEN=local-secret"); await new Promise((resolve) => setTimeout(resolve, 10)); console.log("x".repeat(4096)); });\n',
            objectiveId: "output-objective",
            evidenceIds: ["evidence-output"],
            expectedBehavior: { httpStatus: 200, code: "OK" },
          },
        ],
        policy: { timeoutMs: 10_000, maxOutputBytes: 1024, maxFiles: 10 },
      });

      expect(result.terminalState, JSON.stringify(result)).toBe("OUTPUT_LIMIT");
      expect(
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
      ).toBeLessThanOrEqual(1024);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(
        "local-secret",
      );
      expect(await readdir(temporaryParent)).toEqual([]);
    } finally {
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 20_000);

  it("returns FAILED without observations for malformed Vitest JSON and runs once", async () => {
    const fixtureRoot = await mkdtemp(
      join(workspaceRoot, ".runner-malformed-"),
    );
    const temporaryParent = await mkdtemp(
      join(tmpdir(), "codeatlas-malformed-test-"),
    );
    try {
      const fake = await createFakePnpm(fixtureRoot, {
        body: `writeResult("{ malformed");\nconsole.log("API_TOKEN=local-secret");\nconsole.error(${JSON.stringify(`workspace=${workspaceRoot}`)});`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        temporaryParent,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(request("base"));

      expect(result.terminalState).toBe("FAILED");
      expect(result.exitCode).toBe(0);
      expect(result.testCases).toEqual([]);
      expect(result.observations).toEqual([]);
      expect(result.stdout).not.toContain("local-secret");
      expect(result.stderr).not.toContain(workspaceRoot);
      expect(await readFile(fake.counterPath, "utf8")).toBe("1");
      expect(await readdir(temporaryParent)).toEqual([]);
    } finally {
      await rm(temporaryParent, { recursive: true, force: true });
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("emits honest pass and fail observations for validated object assertions", async () => {
    const provider = new LocalExecutionProvider({ workspaceRoot });
    const [passing, failing] = await Promise.all([
      provider.run({
        ...request("base"),
        testPaths: [],
        generatedFiles: [
          {
            ...generatedFile("test/passing-observation.generated.test.ts"),
            content:
              'import { expect, it } from "vitest";\nit("records a passing response", () => {\n  const response = { status: 401, body: { code: "EXPECTED" } };\n  expect({ httpStatus: response.status, code: response.body.code }).toEqual({ httpStatus: 401, code: "EXPECTED" });\n});\n',
            objectiveId: "passing-observation",
            expectedBehavior: { httpStatus: 401, code: "EXPECTED" },
          },
        ],
      }),
      provider.run({
        ...request("base"),
        testPaths: [],
        generatedFiles: [
          {
            ...generatedFile("test/failed-observation.generated.test.ts"),
            content:
              'import { expect, it } from "vitest";\nit("records an actual response", () => {\n  const response = { status: 500, body: { code: "ACTUAL" } };\n  expect({ httpStatus: response.status, code: response.body.code }).toEqual({ httpStatus: 401, code: "EXPECTED" });\n});\n',
            objectiveId: "failed-observation",
            expectedBehavior: { httpStatus: 401, code: "EXPECTED" },
          },
        ],
      }),
    ]);

    expect(passing.terminalState, JSON.stringify(passing)).toBe("COMPLETED");
    expect(passing.exitCode).toBe(0);
    expect(passing.testCases).toMatchObject([
      { status: "PASSED", generatedObjectiveId: "passing-observation" },
    ]);
    expect(passing.observations).toEqual([
      {
        testName: "records a passing response",
        source: "TEST_ASSERTION",
        expected: { httpStatus: 401, code: "EXPECTED" },
        actual: { httpStatus: 401, code: "EXPECTED" },
      },
    ]);
    expect(failing.terminalState, JSON.stringify(failing)).toBe("COMPLETED");
    expect(failing.exitCode).toBe(1);
    expect(failing.testCases).toMatchObject([
      { status: "FAILED", generatedObjectiveId: "failed-observation" },
    ]);
    expect(
      failing.observations,
      failing.testCases[0]?.failureMessage ?? "",
    ).toEqual([
      {
        testName: "records an actual response",
        source: "TEST_ASSERTION",
        expected: { httpStatus: 401, code: "EXPECTED" },
        actual: { httpStatus: 500, code: "ACTUAL" },
      },
    ]);
  }, 20_000);

  it("retains every field in a failed structured observation", async () => {
    const provider = new LocalExecutionProvider({ workspaceRoot });
    const result = await provider.run({
      ...request("base"),
      testPaths: [],
      generatedFiles: [
        {
          ...generatedFile("test/full-observation.generated.test.ts"),
          content:
            'import { expect, it } from "vitest";\nit("records the complete actual response", () => {\n  const response = { status: 500, body: { code: "INTERNAL_ERROR" } };\n  expect({ httpStatus: response.status, code: response.body.code }).toEqual({ httpStatus: 401, code: "SESSION_EXPIRED" });\n});\n',
          objectiveId: "full-observation",
          expectedBehavior: {
            httpStatus: 401,
            code: "SESSION_EXPIRED",
          },
        },
      ],
    });

    expect(result.terminalState, JSON.stringify(result)).toBe("COMPLETED");
    expect(result.testCases).toMatchObject([
      { status: "FAILED", generatedObjectiveId: "full-observation" },
    ]);
    expect(result.observations).toEqual([
      {
        testName: "records the complete actual response",
        source: "TEST_ASSERTION",
        expected: { httpStatus: 401, code: "SESSION_EXPIRED" },
        actual: { httpStatus: 500, code: "INTERNAL_ERROR" },
      },
    ]);
  }, 20_000);

  it("accepts one direct generated test inside one direct describe wrapper", async () => {
    const provider = new LocalExecutionProvider({ workspaceRoot });
    const result = await provider.run({
      ...request("head"),
      testPaths: [],
      generatedFiles: [
        {
          ...generatedFile("test/codeatlas.expired-session.test.ts"),
          content: `import { describe, expect, it } from "vitest";
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
`,
          objectiveId: "expired-session-objective",
          expectedBehavior: {
            httpStatus: 401,
            code: "SESSION_EXPIRED",
          },
        },
      ],
    });

    expect(result.terminalState, JSON.stringify(result)).toBe("COMPLETED");
    expect(result.testCases).toMatchObject([
      {
        name:
          "generated: expired session regression returns SESSION_EXPIRED for a non-refreshable expired token",
        status: "FAILED",
        generatedObjectiveId: "expired-session-objective",
      },
    ]);
    expect(result.observations).toEqual([
      {
        testName:
          "generated: expired session regression returns SESSION_EXPIRED for a non-refreshable expired token",
        source: "TEST_ASSERTION",
        expected: { httpStatus: 401, code: "SESSION_EXPIRED" },
        actual: { httpStatus: 500, code: "INTERNAL_ERROR" },
      },
    ]);
  }, 20_000);

  it.each([
    {
      name: "an extra test",
      body: `it("first", () => {
    const response = { status: 500, body: { code: "INTERNAL_ERROR" } };
    expect({ httpStatus: response.status, code: response.body.code }).toEqual({ httpStatus: 401, code: "SESSION_EXPIRED" });
  });
  it("second", () => {});`,
    },
    {
      name: "a nested describe",
      body: `describe("nested", () => {
    it("nested test", () => {
      const response = { status: 500, body: { code: "INTERNAL_ERROR" } };
      expect({ httpStatus: response.status, code: response.body.code }).toEqual({ httpStatus: 401, code: "SESSION_EXPIRED" });
    });
  });`,
    },
  ])("does not trust a describe wrapper containing $name", async ({ body }) => {
    const provider = new LocalExecutionProvider({ workspaceRoot });
    const result = await provider.run({
      ...request("base"),
      testPaths: [],
      generatedFiles: [
        {
          ...generatedFile("test/unsupported-describe.generated.test.ts"),
          content: `import { describe, expect, it } from "vitest";
describe("generated wrapper", () => {
  ${body}
});
`,
          objectiveId: "unsupported-describe",
          expectedBehavior: {
            httpStatus: 401,
            code: "SESSION_EXPIRED",
          },
        },
      ],
    });

    expect(result.terminalState, JSON.stringify(result)).toBe("COMPLETED");
    expect(result.observations).toEqual([]);
  }, 20_000);

  it("preserves snapshot Vitest configuration while collecting observations", async () => {
    const fixtureRoot = await createSnapshot({
      "package.json": '{"private":true,"type":"module"}\n',
      "vitest.config.ts":
        'export default { test: { setupFiles: ["./test/setup.ts"] } };\n',
      "src/source.ts": "export const value = 1;\n",
      "test/setup.ts": "globalThis.fixtureSetupRan = true;\n",
      "test/config.test.ts":
        'import { expect, it } from "vitest";\nit("uses snapshot setup", () => { expect(globalThis.fixtureSetupRan).toBe(true); });\n',
    });
    try {
      const provider = new LocalExecutionProvider({ workspaceRoot });
      const result = await provider.run(
        await snapshotRequest(fixtureRoot, ["test/config.test.ts"]),
      );

      expect(result.terminalState, JSON.stringify(result)).toBe("COMPLETED");
      expect(result.testCases).toMatchObject([{ status: "PASSED" }]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails closed when a generated assertion imports a non-Vitest expect", async () => {
    const fixtureRoot = await createSnapshot({
      "package.json": '{"private":true,"type":"module"}\n',
      "src/no-op-expect.ts":
        "export function expect(_actual: unknown) { return { toEqual(_expected: unknown) {} }; }\n",
    });
    try {
      const provider = new LocalExecutionProvider({ workspaceRoot });
      const result = await provider.run({
        ...(await snapshotRequest(fixtureRoot, [])),
        generatedFiles: [
          {
            ...generatedFile("test/custom-expect.generated.test.ts"),
            content:
              'import { expect } from "../src/no-op-expect.ts";\nimport { it } from "vitest";\nit("cannot forge a passing assertion", () => {\n  const response = { status: 599, body: { code: "FORGED" } };\n  expect({ httpStatus: response.status, code: response.body.code }).toEqual({ httpStatus: 401, code: "EXPECTED" });\n});\n',
            objectiveId: "custom-expect",
            expectedBehavior: { httpStatus: 401, code: "EXPECTED" },
          },
        ],
      });

      expect(result.terminalState, JSON.stringify(result)).toBe("FAILED");
      expect(result.testCases).toMatchObject([{ status: "PASSED" }]);
      expect(result.observations).toEqual([]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails closed when a generated callback shadows the Vitest expect", async () => {
    const provider = new LocalExecutionProvider({ workspaceRoot });
    const result = await provider.run({
      ...request("base"),
      testPaths: [],
      generatedFiles: [
        {
          ...generatedFile("test/shadowed-expect.generated.test.ts"),
          content:
            'import { expect, it } from "vitest";\nit("cannot shadow the assertion API", (expect) => {\n  const response = { status: 599, body: { code: "FORGED" } };\n  expect({ httpStatus: response.status, code: response.body.code }).toEqual({ httpStatus: 401, code: "EXPECTED" });\n});\n',
          objectiveId: "shadowed-expect",
          expectedBehavior: { httpStatus: 401, code: "EXPECTED" },
        },
      ],
    });

    expect(result.terminalState, JSON.stringify(result)).toBe("FAILED");
    expect(result.testCases).toMatchObject([{ status: "FAILED" }]);
    expect(result.observations).toEqual([]);
  }, 20_000);

  it("fails closed when type-only imports claim assertion provenance", async () => {
    const fixtureRoot = await createSnapshot({
      "package.json": '{"private":true,"type":"module"}\n',
      "src/install-no-op-globals.ts":
        'import { it as vitestIt } from "vitest";\nObject.assign(globalThis, { it: vitestIt, expect: () => ({ toEqual() {} }) });\n',
    });
    try {
      const provider = new LocalExecutionProvider({ workspaceRoot });
      const results = await Promise.all(
        [
          {
            name: "type-only clause",
            path: "test/type-only-clause.generated.test.ts",
            declaration: 'import type { expect, it } from "vitest";',
          },
          {
            name: "type-only specifier",
            path: "test/type-only-specifier.generated.test.ts",
            declaration: 'import { type expect, it } from "vitest";',
          },
        ].map(async ({ name, path, declaration }) =>
          provider.run({
            ...(await snapshotRequest(fixtureRoot, [])),
            generatedFiles: [
              {
                ...generatedFile(path),
                content: `import "../src/install-no-op-globals.ts";\n${declaration}\nit(${JSON.stringify(name)}, () => {\n  const response = { status: 599, body: { code: "FORGED" } };\n  expect({ httpStatus: response.status, code: response.body.code }).toEqual({ httpStatus: 401, code: "EXPECTED" });\n});\n`,
                objectiveId: name,
                expectedBehavior: { httpStatus: 401, code: "EXPECTED" },
              },
            ],
          }),
        ),
      );

      expect(
        results.map((result) => ({
          terminalState: result.terminalState,
          testStatus: result.testCases[0]?.status,
          observations: result.observations,
        })),
      ).toEqual([
        { terminalState: "FAILED", testStatus: "PASSED", observations: [] },
        { terminalState: "FAILED", testStatus: "PASSED", observations: [] },
      ]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("does not emit an observation for a hand-thrown forged AssertionError", async () => {
    const provider = new LocalExecutionProvider({ workspaceRoot });
    const result = await provider.run({
      ...request("base"),
      testPaths: [],
      generatedFiles: [
        {
          ...generatedFile("test/forged-assertion.generated.test.ts"),
          content:
            'import { it } from "vitest";\nit("throws an identical forged assertion", () => {\n  throw Object.assign(new Error(\'expected { httpStatus: 599, code: "FORGED" } to deeply equal { httpStatus: 401, code: "EXPECTED" }\'), { name: "AssertionError" });\n});\n',
          objectiveId: "forged-assertion",
          expectedBehavior: { httpStatus: 401, code: "EXPECTED" },
        },
      ],
    });

    expect(result.terminalState, JSON.stringify(result)).toBe("COMPLETED");
    expect(result.testCases).toMatchObject([{ status: "FAILED" }]);
    expect(result.observations).toEqual([]);
  }, 20_000);

  it("does not emit a passing observation for a no-op generated test", async () => {
    const provider = new LocalExecutionProvider({ workspaceRoot });
    const result = await provider.run({
      ...request("base"),
      testPaths: [],
      generatedFiles: [generatedFile("test/no-op.generated.test.ts")],
    });

    expect(result.terminalState, JSON.stringify(result)).toBe("COMPLETED");
    expect(result.testCases).toMatchObject([{ status: "PASSED" }]);
    expect(result.observations).toEqual([]);
  }, 20_000);

  it.each([
    "../escape.test.ts",
    "/tmp/escape.test.ts",
    "C:\\escape.test.ts",
    "\\\\server\\share\\test.ts",
    "bad\0name.ts",
  ])("rejects unsafe generated path %s", async (path) => {
    const provider = new LocalExecutionProvider({ workspaceRoot });
    await expect(
      provider.run({
        ...request("base"),
        generatedFiles: [generatedFile(path)],
      }),
    ).rejects.toThrow(/generated path/iu);
  });

  it("rejects a snapshot symlink escape", async () => {
    const fixtureRoot = await mkdtemp(join(workspaceRoot, ".runner-symlink-"));
    try {
      await writeFile(
        join(fixtureRoot, "package.json"),
        '{"private":true,"type":"module"}',
      );
      await symlink(tmpdir(), join(fixtureRoot, "external"), "dir");
      const provider = new LocalExecutionProvider({ workspaceRoot });
      await expect(
        provider.run({
          ...request("base"),
          snapshotRoot: fixtureRoot,
          testPaths: ["package.json"],
        }),
      ).rejects.toThrow(/symlink|symbolic/iu);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects generated overwrites and applies maxFiles after generated files", async () => {
    const provider = new LocalExecutionProvider({ workspaceRoot });
    await expect(
      provider.run({
        ...request("base"),
        testPaths: [],
        generatedFiles: [generatedFile("test/auth.test.ts")],
      }),
    ).rejects.toThrow(/overwrite/iu);

    await expect(
      provider.run({
        ...request("base"),
        generatedFiles: [generatedFile("test/generated.test.ts")],
        policy: { timeoutMs: 10_000, maxOutputBytes: 64 * 1024, maxFiles: 3 },
      }),
    ).rejects.toThrow(/file limit/iu);
  });

  it("rejects a stale in-snapshot reporter file after a startup failure", async () => {
    const fixtureRoot = await createSnapshot({
      "package.json": '{"private":true,"type":"module"}\n',
      "test/requested.test.ts": 'throw new Error("must not execute");\n',
      ".codeatlas-vitest-result.json": '{"testResults":[],"coverageMap":{}}',
    });
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: "process.exitCode = 2;",
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(
        await snapshotRequest(fixtureRoot, ["test/requested.test.ts"]),
      );

      expect(result.terminalState).toBe("FAILED");
      expect(result.exitCode, JSON.stringify(result)).toBe(2);
      expect(result.testCases).toEqual([]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on substituted suites and retains a missing generated test as SKIPPED", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: `const cwd = process.cwd();\nwriteResult({ testResults: [suite(resolve(cwd, "test/auth.test.ts")), suite(resolve(cwd, "test/substituted.test.ts"))], coverageMap: {} });`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const generated = {
        ...generatedFile("test/missing.generated.test.ts"),
        objectiveId: "missing-objective",
      };
      const result = await provider.run({
        ...request("base"),
        generatedFiles: [generated],
      });

      expect(result.terminalState).toBe("FAILED");
      expect(result.testCases).toContainEqual({
        name: "Unexecuted generated test: test/missing.generated.test.ts",
        path: "test/missing.generated.test.ts",
        status: "SKIPPED",
        failureMessage: null,
        generatedObjectiveId: "missing-objective",
      });
      expect(
        result.testCases.some(
          (testCase) => testCase.path === "test/substituted.test.ts",
        ),
      ).toBe(false);
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when an exact requested suite reports zero test cases", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: `const cwd = process.cwd();\nwriteResult({ testResults: [{ name: resolve(cwd, "test/auth.test.ts"), assertionResults: [] }], coverageMap: {} });`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(request("base"));
      expect(result.terminalState).toBe("FAILED");
      expect(result.testCases).toEqual([]);
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  }, 10_000);

  it.each([
    {
      name: "exit 0 with a reported failure",
      exitCode: 0,
      reportedStatus: "failed",
      expectedState: "FAILED",
    },
    {
      name: "exit 1 with only passing cases",
      exitCode: 1,
      reportedStatus: "passed",
      expectedState: "FAILED",
    },
    {
      name: "exit 1 with a failed exact suite",
      exitCode: 1,
      reportedStatus: "failed",
      expectedState: "COMPLETED",
    },
  ] as const)(
    "binds $name to the exact reported statuses",
    async ({ exitCode, reportedStatus, expectedState }) => {
      const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
      try {
        const fake = await createFakePnpm(fakeRoot, {
          body: `const cwd = process.cwd();\nwriteResult({ testResults: [suite(resolve(cwd, "test/auth.test.ts"), ${JSON.stringify(reportedStatus)})], coverageMap: {} });\nprocess.exitCode = ${exitCode};`,
        });
        const provider = new LocalExecutionProvider({
          workspaceRoot,
          pnpmPath: fake.cliPath,
        });
        const result = await provider.run(request("base"));

        expect(result.terminalState, JSON.stringify(result)).toBe(
          expectedState,
        );
        expect(result.testCases).toMatchObject([
          {
            path: "test/auth.test.ts",
            status: reportedStatus === "failed" ? "FAILED" : "PASSED",
          },
        ]);
      } finally {
        await rm(fakeRoot, { recursive: true, force: true });
      }
    },
  );

  it("rejects reporter-only forged coverage that disagrees with the independent artifact", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: `const cwd = process.cwd();\nconst source = resolve(cwd, "src/auth.ts");\nwriteResult({ testResults: [suite(resolve(cwd, "test/auth.test.ts"))], coverageMap: { [source]: coverage(source, 1) } });`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(request("base"));

      expect(result.terminalState).toBe("FAILED");
      expect(result.coverage).toEqual([]);
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("does not accept stale snapshot coverage when the fresh control artifact is missing", async () => {
    const fixtureRoot = await createSnapshot({
      "package.json": '{"private":true,"type":"module"}\n',
      "src/source.ts": "export const value = 1;\n",
      "test/requested.test.ts":
        'throw new Error("fake runner owns reporting");\n',
      "coverage/coverage-final.json": '{"stale":true}\n',
    });
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        writeDefaultCoverage: false,
        body: `const cwd = process.cwd();\nconst source = resolve(cwd, "src/source.ts");\nwriteResult({ testResults: [suite(resolve(cwd, "test/requested.test.ts"))], coverageMap: { [source]: coverage(source, 1) } });`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(
        await snapshotRequest(fixtureRoot, ["test/requested.test.ts"]),
      );

      expect(result.terminalState).toBe("FAILED");
      expect(result.coverage).toEqual([]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("rejects independently reported coverage for a runtime-created source", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: `const cwd = process.cwd();\nconst source = resolve(cwd, "src/runtime-created.ts");\nmkdirSync(resolve(cwd, "src"), { recursive: true });\nwriteFileSync(source, "export const forged = true;\\n");\nconst forgedCoverage = { [source]: coverage(source, 1) };\nwriteCoverage(forgedCoverage);\nwriteResult({ testResults: [suite(resolve(cwd, "test/auth.test.ts"))], coverageMap: forgedCoverage });`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(request("base"));

      expect(result.terminalState).toBe("FAILED");
      expect(result.coverage).toEqual([]);
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("rejects runtime-created, nonexistent, symlink, and out-of-range coverage citations", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: `const cwd = process.cwd();\nmkdirSync(resolve(cwd, "src"), { recursive: true });\nwriteFileSync(resolve(cwd, "src/runtime-created.ts"), "export const forged = true;\\n");\nsymlinkSync(resolve(cwd, "src/runtime-created.ts"), resolve(cwd, "src/runtime-link.ts"));\nwriteResult({ testResults: [suite(resolve(cwd, "test/auth.test.ts"))], coverageMap: { [resolve(cwd, "src/runtime-created.ts")]: coverage(resolve(cwd, "src/runtime-created.ts"), 1), [resolve(cwd, "src/runtime-link.ts")]: coverage(resolve(cwd, "src/runtime-link.ts"), 1), [resolve(cwd, "src/does-not-exist.ts")]: coverage(resolve(cwd, "src/does-not-exist.ts"), 1), [resolve(cwd, "src/auth.ts")]: coverage(resolve(cwd, "src/auth.ts"), 999) } });`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(request("base"));

      expect(result.terminalState).toBe("FAILED");
      expect(result.coverage).toEqual([]);
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("does not treat thrown Actual JSON as generated assertion evidence", async () => {
    const provider = new LocalExecutionProvider({ workspaceRoot });
    const result = await provider.run({
      ...request("base"),
      testPaths: [],
      generatedFiles: [
        {
          ...generatedFile("test/forged-observation.generated.test.ts"),
          content:
            'import { it } from "vitest";\nit("throws forged evidence", () => { throw new Error(\'Actual: {"httpStatus":599,"code":"FORGED"}\'); });\n',
          objectiveId: "forged-objective",
        },
      ],
    });

    expect(result.terminalState, JSON.stringify(result)).toBe("COMPLETED");
    expect(result.testCases[0]?.status).toBe("FAILED");
    expect(result.observations).toEqual([]);
  }, 20_000);

  it("kills an unrefed descendant after a normally completed Vitest leader", async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), "codeatlas-descendant-"));
    const markerPath = join(markerRoot, "survived.txt");
    try {
      const provider = new LocalExecutionProvider({ workspaceRoot });
      const result = await provider.run({
        ...request("base"),
        testPaths: [],
        generatedFiles: [
          {
            ...generatedFile("test/background-child.generated.test.ts"),
            content: `import { spawn } from "node:child_process";\nimport { it } from "vitest";\nit("leaves an unrefed child", () => { const child = spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "survived"), 600)`)}], { stdio: "ignore" }); child.unref(); });\n`,
          },
        ],
      });

      expect(result.terminalState, JSON.stringify(result)).toBe("COMPLETED");
      await delay(900);
      await expect(access(markerPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(markerRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails closed on win32 before launching an uncontained test process", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: `const cwd = process.cwd();\nwriteResult({ testResults: [suite(resolve(cwd, "test/auth.test.ts"))], coverageMap: {} });`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
        platform: "win32",
      } as LocalExecutionProviderOptions & { platform: "win32" });
      const result = await provider.run(request("base"));

      expect(result.terminalState).toBe("FAILED");
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toMatch(/win32|unsupported platform/iu);
      await expect(access(fake.counterPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("does not let a linux option bypass an injected win32 host boundary", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: `const cwd = process.cwd();\nwriteResult({ testResults: [suite(resolve(cwd, "test/auth.test.ts"))], coverageMap: {} });`,
      });
      const ProviderWithHostInjection =
        LocalExecutionProvider as unknown as new (
          options: LocalExecutionProviderOptions,
          internal: { platform: NodeJS.Platform },
        ) => LocalExecutionProvider;
      const provider = new ProviderWithHostInjection(
        {
          workspaceRoot,
          pnpmPath: fake.cliPath,
          platform: "linux",
        },
        { platform: "win32" },
      );
      const result = await provider.run(request("base"));

      expect(result.terminalState).toBe("FAILED");
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toMatch(/win32|unsupported platform/iu);
      await expect(access(fake.counterPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("rejects option-shaped selected and generated paths before launch", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: "writeResult({ testResults: [] });",
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      await expect(
        provider.run({ ...request("base"), testPaths: ["--config=evil.ts"] }),
      ).rejects.toThrow(/option/iu);
      await expect(
        provider.run({
          ...request("base"),
          generatedFiles: [generatedFile("test/--config=evil.ts")],
        }),
      ).rejects.toThrow(/option/iu);
      await expect(access(fake.counterPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("imports an ordinary workspace dependency from a private clone", async () => {
    const provider = new LocalExecutionProvider({ workspaceRoot });
    const dependenciesBefore = await workspaceDependencyState();
    const result = await provider.run({
      ...request("base"),
      testPaths: [],
      generatedFiles: [
        {
          ...generatedFile("test/zod.generated.test.ts"),
          content: `import { realpathSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\nimport { expect, it } from "vitest";\nimport { z } from "zod";\nit("imports zod", () => { const dependency = realpathSync(fileURLToPath(new URL("../node_modules/zod", import.meta.url))); expect(dependency).not.toContain(${JSON.stringify(workspaceRoot)}); expect(z.string().parse("ok")).toBe("ok"); });\n`,
          objectiveId: "dependency-objective",
        },
      ],
    });

    expect(result.terminalState, JSON.stringify(result)).toBe("COMPLETED");
    expect(result.testCases).toMatchObject([{ status: "PASSED" }]);
    expect(await workspaceDependencyState()).toEqual(dependenciesBefore);
  }, 20_000);

  it("rejects a snapshot digest mismatch before launching a subprocess", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: "writeResult({ testResults: [] });",
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      await expect(
        provider.run({ ...request("base"), snapshotSha: "0".repeat(40) }),
      ).rejects.toThrow(/snapshot digest/iu);
      await expect(access(fake.counterPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("accepts a supplied snapshot root outside the provider workspace", async () => {
    const fixtureRoot = await createSnapshot(
      {
        "package.json": '{"private":true,"type":"module"}\n',
        "test/requested.test.ts":
          'throw new Error("fake runner owns reporting");\n',
      },
      tmpdir(),
    );
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: `const cwd = process.cwd();\nwriteResult({ testResults: [suite(resolve(cwd, "test/requested.test.ts"))], coverageMap: {} });`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(
        await snapshotRequest(fixtureRoot, ["test/requested.test.ts"]),
      );
      expect(result.terminalState).toBe("COMPLETED");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("hashes actual child Node and pnpm versions in the environment digest", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        version: "99.1.2",
        body: `const cwd = process.cwd();\nwriteResult({ testResults: [suite(resolve(cwd, "test/auth.test.ts"))], coverageMap: {} });`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(request("base"));
      const lockfileDigest = createHash("sha256")
        .update(await readFile(join(workspaceRoot, "pnpm-lock.yaml")))
        .digest("hex");
      const expected = createHash("sha256")
        .update(
          JSON.stringify({
            nodeVersion: process.version,
            pnpmVersion: "99.1.2",
            lockfileDigest,
            runnerVersion: "0.1.0",
          }),
        )
        .digest("hex");

      expect(result.environmentDigest).toBe(expected);
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("redacts secret-labeled multiword values through end-of-line", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: `console.log("Authorization: Bearer hunter2");\nwriteResult("{ malformed");`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(request("base"));
      expect(result.stdout).toContain("Authorization: [REDACTED]");
      expect(result.stdout).not.toContain("Bearer hunter2");
      expect(result.stdout).not.toContain("hunter2");
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("redacts a known absolute path containing spaces as one value", async () => {
    const parent = await mkdtemp(join(tmpdir(), "codeatlas-path-redaction-"));
    const fakeRoot = join(parent, "folder with spaces");
    await mkdir(fakeRoot);
    try {
      const cliPath = join(fakeRoot, "fake-pnpm.mjs");
      const fake = await createFakePnpm(fakeRoot, {
        body: `console.log(${JSON.stringify(`cli=${cliPath}`)});\nwriteResult("{ malformed");`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(request("base"));
      expect(result.stdout).toContain("cli=<absolute-path>");
      expect(result.stdout).not.toContain("folder with spaces");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("redacts unknown absolute paths with spaces through end-of-line", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: `console.log("posix before /tmp/folder with spaces/file.ts after-marker");\nconsole.log("windows before C:\\\\Temp\\\\folder with spaces\\\\file.ts after-marker");\nwriteResult("{ malformed");`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(request("base"));

      expect(result.stdout).toContain("posix before <absolute-path>");
      expect(result.stdout).toContain("windows before <absolute-path>");
      expect(result.stdout).not.toContain("folder with spaces");
      expect(result.stdout).not.toContain("file.ts");
      expect(result.stdout).not.toContain("after-marker");
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("redacts delimiter-adjacent absolute paths while preserving labels", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: `console.log("posix:/tmp/folder with spaces/file.ts after-marker");\nconsole.log("windows:C:\\\\Temp\\\\folder with spaces\\\\file.ts after-marker");\nwriteResult("{ malformed");`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(request("base"));

      expect(result.stdout).toContain("posix:<absolute-path>");
      expect(result.stdout).toContain("windows:<absolute-path>");
      expect(result.stdout).not.toContain("folder with spaces");
      expect(result.stdout).not.toContain("file.ts");
      expect(result.stdout).not.toContain("after-marker");
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  }, 10_000);

  it("redacts closing-delimiter-adjacent absolute paths", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-fake-pnpm-"));
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: `console.log("bracket-posix]/tmp/folder with spaces/file.ts after-marker");\nconsole.log("bracket-windows]C:\\\\Temp\\\\folder with spaces\\\\file.ts after-marker");\nconsole.log("brace-posix}/tmp/folder with spaces/file.ts after-marker");\nconsole.log("brace-windows}C:\\\\Temp\\\\folder with spaces\\\\file.ts after-marker");\nconsole.log("paren-posix)/tmp/folder with spaces/file.ts after-marker");\nconsole.log("paren-windows)C:\\\\Temp\\\\folder with spaces\\\\file.ts after-marker");\nwriteResult("{ malformed");`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(request("base"));

      for (const prefix of [
        "bracket-posix]",
        "bracket-windows]",
        "brace-posix}",
        "brace-windows}",
        "paren-posix)",
        "paren-windows)",
      ]) {
        expect(result.stdout).toContain(`${prefix}<absolute-path>`);
      }
      expect(result.stdout).not.toContain("folder with spaces");
      expect(result.stdout).not.toContain("file.ts");
      expect(result.stdout).not.toContain("after-marker");
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  }, 10_000);

  it("refuses a symlink substituted for the fresh control result file", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-result-symlink-"));
    const targetPath = join(fakeRoot, "forged-result.json");
    try {
      const fake = await createFakePnpm(fakeRoot, {
        body: `writeFileSync(${JSON.stringify(targetPath)}, JSON.stringify({ testResults: [suite(resolve(process.cwd(), "test/auth.test.ts"))], coverageMap: {} }));\nsymlinkSync(${JSON.stringify(targetPath)}, outputPath);`,
      });
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        pnpmPath: fake.cliPath,
      });
      const result = await provider.run(request("base"));
      expect(result.terminalState).toBe("FAILED");
      expect(result.testCases).toEqual([]);
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("rejects a configured pnpm batch shim instead of invoking a shell", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "codeatlas-pnpm-shim-"));
    const shimPath = join(fakeRoot, "pnpm.cmd");
    try {
      await writeFile(shimPath, "@echo off\r\n", { mode: 0o700 });
      expect(
        () => new LocalExecutionProvider({ workspaceRoot, pnpmPath: shimPath }),
      ).toThrow(/JavaScript CLI|batch|shell/iu);
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });
});

function generatedFile(path: string) {
  return {
    path,
    content: 'import { it } from "vitest";\nit("generated", () => {});\n',
    objectiveId: "generated-objective",
    evidenceIds: ["generated-evidence"],
    expectedBehavior: { httpStatus: 200, code: "OK" },
  };
}

async function workspaceDependencyState(): Promise<unknown> {
  const paths = [
    "node_modules/.bin/vitest",
    "node_modules/vitest",
    "node_modules/@vitest/coverage-v8",
    "packages/runner/node_modules/execa",
  ];
  return Promise.all(
    paths.map(async (path) => {
      const absolutePath = resolve(workspaceRoot, path);
      try {
        const info = await lstat(absolutePath);
        return {
          path,
          mode: info.mode,
          size: info.size,
          link: info.isSymbolicLink() ? await readlink(absolutePath) : null,
          content: info.isFile() ? await readFile(absolutePath, "utf8") : null,
          targetDigest:
            info.isSymbolicLink() &&
            (path === "node_modules/vitest" || path.includes("coverage-v8"))
              ? await computeSnapshotDigest(await realpath(absolutePath))
              : null,
        };
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return { path, missing: true };
        }
        throw error;
      }
    }),
  );
}

async function createSnapshot(
  files: Record<string, string>,
  parent = workspaceRoot,
): Promise<string> {
  const root = await mkdtemp(join(parent, ".runner-review-snapshot-"));
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, content);
  }
  return root;
}

async function snapshotRequest(
  snapshotRoot: string,
  testPaths: string[],
): Promise<ExecutionRequest> {
  return {
    analysisId: "review-analysis",
    revision: "base",
    snapshotRoot,
    snapshotSha: await computeSnapshotDigest(snapshotRoot),
    testPaths,
    generatedFiles: [],
    policy: { timeoutMs: 10_000, maxOutputBytes: 64 * 1024, maxFiles: 20 },
  };
}

interface FakePnpmOptions {
  body: string;
  version?: string;
  writeDefaultCoverage?: boolean;
}

async function createFakePnpm(
  root: string,
  options: FakePnpmOptions,
): Promise<{ cliPath: string; counterPath: string }> {
  const cliPath = join(root, "fake-pnpm.mjs");
  const counterPath = join(root, "runs.txt");
  await writeFile(
    cliPath,
    `#!/usr/bin/env node
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
if (process.argv.includes("--version")) {
  console.log(${JSON.stringify(options.version ?? "11.9.0")});
  process.exit(0);
}
appendFileSync(${JSON.stringify(counterPath)}, "1");
const output = process.argv.find((value) => value.startsWith("--outputFile="));
const outputPath = output?.slice("--outputFile=".length);
const coverageOption = process.argv.find((value) => value.startsWith("--coverage.reportsDirectory="));
const coverageDirectory = coverageOption?.slice("--coverage.reportsDirectory=".length);
const root = process.argv.find((value) => value.startsWith("--root="));
if (root) process.chdir(root.slice("--root=".length));
const writeResult = (value) => {
  if (!outputPath) return;
  writeFileSync(outputPath, typeof value === "string" ? value : JSON.stringify(value));
};
let coverageWritten = false;
const writeCoverage = (value) => {
  if (!coverageDirectory) return;
  mkdirSync(coverageDirectory, { recursive: true });
  writeFileSync(resolve(coverageDirectory, "coverage-final.json"), JSON.stringify(value));
  coverageWritten = true;
};
const suite = (name, status = "passed") => ({
  name,
  assertionResults: [{ fullName: "requested case", title: "requested case", status, failureMessages: [] }]
});
const coverage = (path, line) => ({
  path,
  statementMap: { "0": { start: { line, column: 0 }, end: { line, column: 1 } } },
  s: { "0": 1 }
});
${options.body}
if (!coverageWritten && ${JSON.stringify(options.writeDefaultCoverage !== false)}) writeCoverage({});
`,
    { mode: 0o700 },
  );
  await chmod(cliPath, 0o700);
  return { cliPath, counterPath };
}
