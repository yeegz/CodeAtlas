import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";

import { computeSnapshotDigest } from "@codeatlas/analyzer";
import { deriveAnalysisId } from "@codeatlas/evidence";
import { TemplateTestGenerator } from "@codeatlas/generator";
import {
  LocalArtifactStore,
  analyzeComparison,
  type AnalysisOutput,
} from "@codeatlas/pipeline";
import { passportToJson, passportToMarkdown } from "@codeatlas/passport";
import { LocalExecutionProvider } from "@codeatlas/runner";

import {
  AnalysisFailedError,
  ENGINE_VERSION,
  ExitCode,
  SecurityPolicyError,
  defaultConfigurationDigest,
  isContained,
  resolveExistingDirectory,
  resolveOutputDirectory,
  writeFileAtomic,
} from "../shared.js";

export interface AnalyzeOptions {
  base: string;
  head: string;
  out: string;
  workspace?: string;
  engineVersion?: string;
  configurationDigest?: string;
  json?: boolean;
}

const CONFIGURATION_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export async function runAnalyze(
  options: AnalyzeOptions,
  stdout: NodeJS.WritableStream,
): Promise<number> {
  const workspaceRoot = await resolveExistingDirectory(
    options.workspace ?? process.cwd(),
    "workspace",
  );
  const baseRoot = await resolveExistingDirectory(
    options.base,
    "base snapshot",
  );
  const headRoot = await resolveExistingDirectory(
    options.head,
    "head snapshot",
  );
  if (baseRoot === headRoot) {
    throw new SecurityPolicyError("base and head must be different snapshots");
  }

  const outputDirectory = await resolveOutputDirectory(options.out);
  if (
    isContained(baseRoot, outputDirectory) ||
    isContained(headRoot, outputDirectory)
  ) {
    throw new SecurityPolicyError(
      "output directory must not be inside a snapshot under analysis",
    );
  }

  const engineVersion = options.engineVersion ?? ENGINE_VERSION;
  const configurationDigest =
    options.configurationDigest ?? defaultConfigurationDigest();
  if (!CONFIGURATION_DIGEST.test(configurationDigest)) {
    throw new SecurityPolicyError(
      "configuration digest must be sha256:<64 hex characters>",
    );
  }

  const [baseSha, headSha] = await Promise.all([
    computeSnapshotDigest(baseRoot),
    computeSnapshotDigest(headRoot),
  ]);
  if (baseSha === headSha) {
    throw new SecurityPolicyError("base and head must be different snapshots");
  }

  const analysisId = deriveAnalysisId({
    provider: "local",
    baseSha,
    headSha,
    configurationDigest,
    engineVersion,
  });

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");

  let output: AnalysisOutput;
  try {
    output = await analyzeComparison({
      baseRoot,
      headRoot,
      engineVersion,
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
  } catch (error) {
    throw new AnalysisFailedError(
      `Analysis failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const context: ExportContext = {
    workspaceRoot,
    baseRoot,
    headRoot,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  await writeExports(outputDirectory, output, context);
  // The Proof Card prints `codeatlas replay <finding-id>`, which resolves the
  // bundle from the local run store. Writing the sidecar there too means that
  // command works from the repository root without the export directory.
  await writeReplaySidecar(
    join(workspaceRoot, ".codeatlas", "runs", output.analysisId),
    output,
    context,
  );

  if (options.json === true) {
    stdout.write(
      `${JSON.stringify(summarize(output, outputDirectory), null, 2)}\n`,
    );
  } else {
    stdout.write(renderHuman(output, outputDirectory));
  }

  switch (output.passport.overallState) {
    case "VERIFIED":
      return ExitCode.VERIFIED;
    case "ACTION_REQUIRED":
      return ExitCode.ACTION_REQUIRED;
    case "INCOMPLETE":
      return ExitCode.PARTIAL;
    default:
      return ExitCode.ANALYSIS_FAILED;
  }
}

interface ExportContext {
  workspaceRoot: string;
  baseRoot: string;
  headRoot: string;
  publicKeyPem: string;
}

async function writeExports(
  outputDirectory: string,
  output: AnalysisOutput,
  context: ExportContext,
): Promise<void> {
  await writeFileAtomic(
    join(outputDirectory, "passport.json"),
    `${passportToJson(output.passport)}\n`,
  );
  await writeFileAtomic(
    join(outputDirectory, "passport.md"),
    passportToMarkdown(output.passport),
  );
  await writeFileAtomic(
    join(outputDirectory, "evidence-manifest.json"),
    `${JSON.stringify(output.signedManifest.manifest, null, 2)}\n`,
  );
  await writeFileAtomic(
    join(outputDirectory, "reproduction-bundle.json"),
    `${JSON.stringify(output.reproductionBundle, null, 2)}\n`,
  );
  await writeReplaySidecar(outputDirectory, output, context);
}

/**
 * The signature envelope and the local snapshot locations. Neither belongs to
 * the signed manifest: the first carries the public key needed to verify it,
 * and the second records where the snapshots were read from so replay can find
 * them again. Replay still verifies every snapshot digest against the signed
 * bundle before trusting either file.
 */
async function writeReplaySidecar(
  directory: string,
  output: AnalysisOutput,
  context: ExportContext,
): Promise<void> {
  await writeFileAtomic(
    join(directory, "evidence-manifest.sig"),
    `${JSON.stringify(
      {
        algorithm: "ed25519",
        digest: output.signedManifest.digest,
        signature: output.signedManifest.signature,
        publicKey: context.publicKeyPem,
      },
      null,
      2,
    )}\n`,
  );
  await writeFileAtomic(
    join(directory, "replay-sources.json"),
    `${JSON.stringify(
      {
        schemaVersion: "1.0",
        analysisId: output.analysisId,
        workspaceRoot: context.workspaceRoot,
        baseRoot: context.baseRoot,
        headRoot: context.headRoot,
      },
      null,
      2,
    )}\n`,
  );
}

function summarize(output: AnalysisOutput, outputDirectory: string) {
  return {
    analysisId: output.analysisId,
    attemptId: output.attemptId,
    overallState: output.passport.overallState,
    baseSha: output.passport.baseSha,
    headSha: output.passport.headSha,
    engineVersion: output.passport.engineVersion,
    manifestDigest: output.signedManifest.digest,
    summary: output.passport.summary,
    changedSymbols: output.changedSymbols.map(({ name, path }) => ({
      name,
      path,
    })),
    selections: output.selections.map(({ path, reasons }) => ({
      path,
      reasons,
    })),
    generatedTests: output.generatedTests.map((test) => ({
      path: test.path,
      objectiveId: test.objectiveId,
      executedOnBase: test.executedOnBase,
      executedOnHead: test.executedOnHead,
    })),
    findings: output.findings.map((finding) => ({
      id: finding.id,
      state: finding.state,
      title: finding.title,
      baseBehavior: finding.proofCard.baseBehavior,
      headBehavior: finding.proofCard.headBehavior,
      reproductionCommand: finding.proofCard.reproductionCommand,
      limitations: finding.proofCard.limitations,
    })),
    unverifiedAreas: output.passport.unverifiedAreas,
    outputDirectory,
  };
}

function renderHuman(output: AnalysisOutput, outputDirectory: string): string {
  const passport = output.passport;
  const lines: string[] = [
    `CodeAtlas ${output.analysisId}`,
    `State: ${passport.overallState}`,
    `Base: ${passport.baseSha}`,
    `Head: ${passport.headSha}`,
    `Engine: ${passport.engineVersion}`,
    `Manifest: ${passport.manifestDigest}`,
    "",
    `Changed symbols: ${
      output.changedSymbols
        .map((symbol) => `${symbol.name} (${symbol.path})`)
        .join(", ") || "none"
    }`,
    `Selected tests: ${
      output.selections.map(({ path }) => path).join(", ") || "none"
    }`,
  ];

  for (const selection of output.selections) {
    for (const reason of selection.reasons) {
      lines.push(`  ${selection.path}: ${reason}`);
    }
  }

  lines.push("");
  if (output.generatedTests.length === 0) {
    lines.push("Generated tests: none");
  } else {
    lines.push("Generated tests:");
    for (const test of output.generatedTests) {
      lines.push(
        `  ${test.path} (generated; executed on base: ${
          test.executedOnBase ? "yes" : "no"
        }, head: ${test.executedOnHead ? "yes" : "no"})`,
      );
    }
  }

  lines.push("");
  if (output.findings.length === 0) {
    lines.push("Findings: none");
  } else {
    lines.push("Findings:");
    for (const finding of output.findings) {
      lines.push(`  [${finding.state}] ${finding.title}`);
      lines.push(`    base: ${finding.proofCard.baseBehavior}`);
      lines.push(`    head: ${finding.proofCard.headBehavior}`);
      lines.push(`    journey: ${finding.proofCard.affectedJourney}`);
      lines.push(`    replay: ${finding.proofCard.reproductionCommand}`);
      for (const limitation of finding.proofCard.limitations) {
        lines.push(`    limitation: ${limitation}`);
      }
    }
  }

  if (passport.unverifiedAreas.length > 0) {
    lines.push("");
    lines.push("Unverified areas:");
    for (const area of passport.unverifiedAreas) {
      lines.push(`  ${area}`);
    }
  }

  lines.push("");
  lines.push(`Exports written to ${outputDirectory}`);
  lines.push(
    "CodeAtlas reports observed evidence. It does not certify that this change is safe to merge.",
  );
  return `${lines.join("\n")}\n`;
}
