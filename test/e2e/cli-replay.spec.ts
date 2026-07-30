import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

const run = promisify(execFile);
const workspaceRoot = resolve(import.meta.dirname, "../..");
const cli = resolve(workspaceRoot, "apps/cli/bin/codeatlas.mjs");

/** No shell: arguments are always passed as an array. */
async function codeatlas(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      cwd: workspaceRoot,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

test.describe.configure({ mode: "serial" });

test("analyses, signs and replays the seeded regression", async () => {
  test.setTimeout(600_000);
  const output = await mkdtemp(join(tmpdir(), "codeatlas-acceptance-"));

  try {
    const analyze = await codeatlas([
      "analyze",
      "--base",
      resolve(workspaceRoot, "fixtures/auth-regression/base"),
      "--head",
      resolve(workspaceRoot, "fixtures/auth-regression/head"),
      "--out",
      output,
      "--json",
    ]);

    expect(analyze.code).toBe(2);
    const report = JSON.parse(analyze.stdout);
    expect(report.overallState).toBe("ACTION_REQUIRED");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].state).toBe("CONFIRMED_REGRESSION");
    expect(report.findings[0].baseBehavior).toBe(
      "HTTP 401 with SESSION_EXPIRED",
    );
    expect(report.findings[0].headBehavior).toBe(
      "HTTP 500 with INTERNAL_ERROR",
    );
    expect(report.findings[0].limitations).toEqual([]);

    // The generated test says why it exists, compiled, and ran on both sides.
    expect(report.generatedTests).toHaveLength(1);
    expect(report.generatedTests[0].executedOnBase).toBe(true);
    expect(report.generatedTests[0].executedOnHead).toBe(true);
    expect(report.selections[0].reasons[0]).toContain("validateToken");

    // The manifest verifies through the published API before anything is shown.
    const { verifyManifest } = await import("@codeatlas/evidence");
    const { createPublicKey } = await import("node:crypto");
    const manifest = JSON.parse(
      await readFile(join(output, "evidence-manifest.json"), "utf8"),
    );
    const signature = JSON.parse(
      await readFile(join(output, "evidence-manifest.sig"), "utf8"),
    );
    expect(
      verifyManifest(
        {
          manifest,
          digest: signature.digest,
          signature: signature.signature,
        },
        createPublicKey(signature.publicKey),
      ),
    ).toBe(true);

    const replay = await codeatlas([
      "replay",
      join(output, "reproduction-bundle.json"),
    ]);
    expect(replay.code).toBe(0);
    expect(replay.stdout.trimEnd().split("\n").at(-1)).toBe(
      "REPRODUCED finding_expired_session",
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("refuses a tampered bundle before any test process starts", async () => {
  test.setTimeout(600_000);
  const output = await mkdtemp(join(tmpdir(), "codeatlas-tamper-"));

  try {
    const analyze = await codeatlas([
      "analyze",
      "--base",
      resolve(workspaceRoot, "fixtures/auth-regression/base"),
      "--head",
      resolve(workspaceRoot, "fixtures/auth-regression/head"),
      "--out",
      output,
    ]);
    expect(analyze.code).toBe(2);

    const bundlePath = join(output, "reproduction-bundle.json");
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    bundle.artifacts[0].digest = `sha256:${"0".repeat(64)}`;
    const tampered = join(output, "tampered.json");
    await writeFile(tampered, JSON.stringify(bundle), "utf8");

    const replay = await codeatlas(["replay", tampered]);
    expect(replay.code).toBe(5);
    expect(replay.stderr).toContain("Bundle integrity verification failed");
    expect(replay.stdout).not.toContain("REPRODUCED");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
