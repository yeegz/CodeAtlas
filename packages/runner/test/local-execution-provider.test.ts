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
import { LocalExecutionProvider } from "../src/local-execution-provider.js";
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

  it("extracts actual behavior from a failed generated toEqual assertion", async () => {
    const provider = new LocalExecutionProvider({ workspaceRoot });
    const result = await provider.run({
      ...request("base"),
      testPaths: [],
      generatedFiles: [
        {
          ...generatedFile("test/failed-observation.generated.test.ts"),
          content:
            'import { expect, it } from "vitest";\nit("accepts the declared response", () => { expect({ httpStatus: 401, code: "EXPECTED" }).toEqual({ httpStatus: 401, code: "EXPECTED" }); });\nit("records an actual response", () => { expect({ httpStatus: 500, code: "ACTUAL" }).toEqual({ httpStatus: 401, code: "EXPECTED" }); });\n',
          objectiveId: "failed-observation",
          expectedBehavior: { httpStatus: 401, code: "EXPECTED" },
        },
      ],
    });

    expect(result.terminalState, JSON.stringify(result)).toBe("COMPLETED");
    expect(result.exitCode).toBe(1);
    expect(result.testCases).toMatchObject([
      { status: "PASSED", generatedObjectiveId: "failed-observation" },
      { status: "FAILED", generatedObjectiveId: "failed-observation" },
    ]);
    expect(
      result.observations,
      result.testCases[0]?.failureMessage ?? "",
    ).toEqual([
      {
        testName: "accepts the declared response",
        source: "TEST_ASSERTION",
        expected: { httpStatus: 401, code: "EXPECTED" },
        actual: { httpStatus: 401, code: "EXPECTED" },
      },
      {
        testName: "records an actual response",
        source: "TEST_ASSERTION",
        expected: { httpStatus: 401, code: "EXPECTED" },
        actual: { httpStatus: 500, code: "ACTUAL" },
      },
    ]);
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
const root = process.argv.find((value) => value.startsWith("--root="));
if (root) process.chdir(root.slice("--root=".length));
const writeResult = (value) => {
  if (!outputPath) return;
  writeFileSync(outputPath, typeof value === "string" ? value : JSON.stringify(value));
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
`,
    { mode: 0o700 },
  );
  await chmod(cliPath, 0o700);
  return { cliPath, counterPath };
}
