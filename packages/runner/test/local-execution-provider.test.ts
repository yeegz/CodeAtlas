import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalExecutionProvider } from "../src/local-execution-provider.js";
import type { ExecutionRequest } from "../src/execution-provider.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

function request(revision: "base" | "head"): ExecutionRequest {
  return {
    analysisId: `analysis-${revision}`,
    revision,
    snapshotRoot: resolve(
      workspaceRoot,
      `fixtures/auth-regression/${revision}`,
    ),
    snapshotSha: revision === "base" ? "base-sha" : "head-sha",
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
    expect(base.snapshotSha).toBe("base-sha");
    expect(head.snapshotSha).toBe("head-sha");
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
      expect(result.testCases).toEqual([]);
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

      expect(result.terminalState).toBe("OUTPUT_LIMIT");
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
    const counterPath = join(fixtureRoot, "counter.txt");
    const executablePath = join(fixtureRoot, "fake-pnpm.mjs");
    try {
      await writeFile(
        executablePath,
        `#!/usr/bin/env node\nimport { appendFileSync, writeFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(counterPath)}, "1");\nconst output = process.argv.find((value) => value.startsWith("--outputFile="));\nif (output) writeFileSync(output.slice("--outputFile=".length), "{ malformed");\nconsole.log("API_TOKEN=local-secret");\nconsole.error(${JSON.stringify(`workspace=${workspaceRoot}`)});\n`,
        { mode: 0o700 },
      );
      await chmod(executablePath, 0o700);
      const provider = new LocalExecutionProvider({
        workspaceRoot,
        temporaryParent,
        pnpmPath: executablePath,
      });
      const result = await provider.run(request("base"));

      expect(result.terminalState).toBe("FAILED");
      expect(result.exitCode).toBe(0);
      expect(result.testCases).toEqual([]);
      expect(result.observations).toEqual([]);
      expect(result.stdout).not.toContain("local-secret");
      expect(result.stderr).not.toContain(workspaceRoot);
      expect(await readFile(counterPath, "utf8")).toBe("1");
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

    expect(result.terminalState).toBe("COMPLETED");
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
          testPaths: [],
        }),
      ).rejects.toThrow(/symbolic link/iu);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects generated overwrites and applies maxFiles after generated files", async () => {
    const provider = new LocalExecutionProvider({ workspaceRoot });
    await expect(
      provider.run({
        ...request("base"),
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
