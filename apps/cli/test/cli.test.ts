import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(import.meta.dirname, "../bin/codeatlas.mjs");
const baseRoot = resolve(workspaceRoot, "fixtures/auth-regression/base");
const headRoot = resolve(workspaceRoot, "fixtures/auth-regression/head");

const ANALYZE_TIMEOUT_MS = 600_000;
const REPLAY_TIMEOUT_MS = 300_000;

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa(process.execPath, [cliEntry, ...args], {
    cwd: workspaceRoot,
    reject: false,
    all: false,
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("codeatlas analyze", () => {
  let outputDirectory: string;
  let analyze: { exitCode: number; stdout: string; stderr: string };

  beforeAll(async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), "codeatlas-cli-"));
    analyze = await runCli([
      "analyze",
      "--base",
      baseRoot,
      "--head",
      headRoot,
      "--out",
      outputDirectory,
    ]);
  }, ANALYZE_TIMEOUT_MS);

  afterAll(async () => {
    await rm(outputDirectory, { recursive: true, force: true });
  });

  it("exits with ACTION_REQUIRED and reports the confirmed regression", () => {
    expect(analyze.stderr).toBe("");
    expect(analyze.exitCode).toBe(2);
    expect(analyze.stdout).toContain(
      "Expired sessions return an internal error",
    );
    expect(analyze.stdout).toContain("ACTION_REQUIRED");
  });

  it("writes every export required by the Passport contract", async () => {
    for (const name of [
      "passport.json",
      "passport.md",
      "evidence-manifest.json",
      "evidence-manifest.sig",
      "reproduction-bundle.json",
    ]) {
      const contents = await readFile(join(outputDirectory, name), "utf8");
      expect(contents.length).toBeGreaterThan(0);
    }

    const passport = JSON.parse(
      await readFile(join(outputDirectory, "passport.json"), "utf8"),
    );
    expect(passport.overallState).toBe("ACTION_REQUIRED");
    expect(passport.summary.findings.confirmedRegressions).toBe(1);

    const markdown = await readFile(
      join(outputDirectory, "passport.md"),
      "utf8",
    );
    expect(markdown).toContain("# CodeAtlas Change Passport");
    expect(markdown).toContain("codeatlas replay finding_expired_session");
  });

  it(
    "replays the recorded finding from the signed bundle",
    async () => {
      const replay = await runCli([
        "replay",
        join(outputDirectory, "reproduction-bundle.json"),
      ]);
      expect(replay.exitCode).toBe(0);
      expect(replay.stdout.trimEnd().split("\n").at(-1)).toBe(
        "REPRODUCED finding_expired_session",
      );
    },
    REPLAY_TIMEOUT_MS,
  );

  it(
    "replays the exact command printed on the Proof Card",
    async () => {
      const replay = await runCli(["replay", "finding_expired_session"]);
      expect(replay.exitCode).toBe(0);
      expect(replay.stdout.trimEnd().split("\n").at(-1)).toBe(
        "REPRODUCED finding_expired_session",
      );
    },
    REPLAY_TIMEOUT_MS,
  );

  it(
    "refuses to replay a bundle whose artifact digest was modified",
    async () => {
      const bundlePath = join(outputDirectory, "reproduction-bundle.json");
      const tamperedPath = join(outputDirectory, "tampered-bundle.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
      bundle.artifacts[0].digest = `sha256:${"0".repeat(64)}`;
      await writeFile(tamperedPath, JSON.stringify(bundle), "utf8");

      const replay = await runCli(["replay", tamperedPath]);
      expect(replay.exitCode).toBe(5);
      expect(replay.stderr).toContain("Bundle integrity verification failed");
      expect(replay.stdout).not.toContain("REPRODUCED");
      expect(replay.stdout).not.toContain("NOT_REPRODUCED");
    },
    REPLAY_TIMEOUT_MS,
  );
});

describe("codeatlas argument validation", () => {
  it("rejects identical base and head roots", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "codeatlas-cli-"));
    try {
      const result = await runCli([
        "analyze",
        "--base",
        baseRoot,
        "--head",
        baseRoot,
        "--out",
        outputDirectory,
      ]);
      expect(result.exitCode).toBe(5);
      expect(result.stderr).toContain(
        "base and head must be different snapshots",
      );
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("rejects an output directory inside a snapshot", async () => {
    const result = await runCli([
      "analyze",
      "--base",
      baseRoot,
      "--head",
      headRoot,
      "--out",
      join(headRoot, "out"),
    ]);
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("output directory must not be inside");
  });

  it("rejects a base snapshot that does not exist", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "codeatlas-cli-"));
    try {
      const result = await runCli([
        "analyze",
        "--base",
        join(workspaceRoot, "fixtures/does-not-exist"),
        "--head",
        headRoot,
        "--out",
        outputDirectory,
      ]);
      expect(result.exitCode).toBe(5);
      expect(result.stderr).toContain("base snapshot");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
