#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import { runAnalyze, type AnalyzeOptions } from "./commands/analyze.js";
import { runReplay, type ReplayOptions } from "./commands/replay.js";
import {
  AnalysisFailedError,
  ENGINE_VERSION,
  ExitCode,
  SecurityPolicyError,
} from "./shared.js";

export async function main(
  argv: readonly string[],
  streams: {
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
  } = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const program = new Command();
  let action: (() => Promise<number>) | undefined;

  program
    .name("codeatlas")
    .description(
      "Produce and replay reproducible evidence for a base/head comparison.",
    )
    .version(ENGINE_VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => void streams.stdout.write(text),
      writeErr: (text) => void streams.stderr.write(text),
    });

  program
    .command("analyze")
    .description("Analyze two local snapshots and write a Change Passport.")
    .requiredOption("--base <path>", "base snapshot directory")
    .requiredOption("--head <path>", "head snapshot directory")
    .requiredOption("--out <path>", "directory to write exports into")
    .option("--workspace <path>", "workspace root that stores run artifacts")
    .option("--engine-version <version>", "engine version to record")
    .option("--configuration-digest <digest>", "sha256:<64 hex> configuration")
    .option("--json", "emit machine-readable output")
    .action((options: AnalyzeOptions) => {
      action = () => runAnalyze(options, streams.stdout);
    });

  program
    .command("replay")
    .description(
      "Verify a reproduction bundle and re-execute its recorded evidence.",
    )
    .argument("<target>", "reproduction bundle path or finding id")
    .option("--base <path>", "base snapshot directory")
    .option("--head <path>", "head snapshot directory")
    .option("--workspace <path>", "workspace root that stores run artifacts")
    .option("--json", "emit machine-readable output")
    .action((target: string, options: ReplayOptions) => {
      action = () => runReplay(target, options, streams.stdout);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0
        ? ExitCode.VERIFIED
        : ExitCode.SECURITY_POLICY;
    }
    throw error;
  }

  if (action === undefined) {
    program.outputHelp();
    return ExitCode.SECURITY_POLICY;
  }

  try {
    return await action();
  } catch (error) {
    if (error instanceof SecurityPolicyError) {
      streams.stderr.write(`${error.message}\n`);
      return ExitCode.SECURITY_POLICY;
    }
    if (error instanceof AnalysisFailedError) {
      streams.stderr.write(`${error.message}\n`);
      return ExitCode.ANALYSIS_FAILED;
    }
    streams.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return ExitCode.ANALYSIS_FAILED;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
