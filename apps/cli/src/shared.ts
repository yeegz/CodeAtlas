import { createHash } from "node:crypto";
import { mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

import { canonicalize } from "json-canonicalize";

/** Engine version recorded in every Passport, manifest and reproduction bundle. */
export const ENGINE_VERSION = "0.1.0";

/**
 * Resource envelope applied to every local execution. It is mirrored from the
 * pipeline so the configuration digest changes whenever the envelope changes.
 */
export const EXECUTION_POLICY = Object.freeze({
  timeoutMs: 10_000,
  maxOutputBytes: 64 * 1024,
  maxFiles: 1_000,
});

/**
 * Process exit codes. These are a public contract: CI systems branch on them.
 *
 * - `0` the comparison produced no action items.
 * - `2` the Passport requires human action.
 * - `3` the Passport is incomplete, or a replay could not run in an equivalent
 *   environment.
 * - `4` the analysis itself failed.
 * - `5` the invocation or an artifact was rejected before any work was trusted.
 */
export const ExitCode = Object.freeze({
  VERIFIED: 0,
  ACTION_REQUIRED: 2,
  PARTIAL: 3,
  ANALYSIS_FAILED: 4,
  SECURITY_POLICY: 5,
});

/** Rejected input or failed integrity verification. Always exits `5`. */
export class SecurityPolicyError extends Error {
  override readonly name = "SecurityPolicyError";
}

/** The analysis or replay ran but could not complete. Always exits `4`. */
export class AnalysisFailedError extends Error {
  override readonly name = "AnalysisFailedError";
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Resolve a directory that must already exist, following symlinks exactly once
 * through `realpath` so later containment checks cannot be defeated by a link.
 */
export async function resolveExistingDirectory(
  candidate: string,
  label: string,
): Promise<string> {
  if (candidate.includes("\0")) {
    throw new SecurityPolicyError(`${label} path is not a valid path`);
  }
  const absolute = resolve(candidate);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch (error) {
    if (isNotFound(error)) {
      throw new SecurityPolicyError(`${label} does not exist: ${absolute}`);
    }
    throw error;
  }
  const info = await stat(real);
  if (!info.isDirectory()) {
    throw new SecurityPolicyError(`${label} is not a directory: ${absolute}`);
  }
  return real;
}

/**
 * Resolve a directory that may not exist yet by resolving the deepest existing
 * ancestor. Without this a symlinked parent could place output inside a
 * snapshot after the containment check passed.
 */
export async function resolveOutputDirectory(
  candidate: string,
): Promise<string> {
  if (candidate.includes("\0")) {
    throw new SecurityPolicyError("output directory path is not a valid path");
  }
  const absolute = resolve(candidate);
  const suffix: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      const real = await realpath(cursor);
      return suffix.length === 0 ? real : resolve(real, ...suffix);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new SecurityPolicyError(
          `output directory path is not resolvable: ${absolute}`,
        );
      }
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/** True when `child` is `parent` itself or lies beneath it. */
export function isContained(parent: string, child: string): boolean {
  if (!isAbsolute(parent) || !isAbsolute(child)) return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** Write via a temporary file plus rename so readers never see a partial file. */
export async function writeFileAtomic(
  path: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${sha256Hex(`${path}:${contents.length}`).slice(0, 16)}`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Deterministic digest of everything that changes analysis meaning. Two runs
 * with the same inputs and the same envelope share an analysis id.
 */
export function defaultConfigurationDigest(): string {
  return `sha256:${sha256Hex(
    canonicalize({
      provider: "local",
      policy: {
        timeoutMs: EXECUTION_POLICY.timeoutMs,
        maxOutputBytes: EXECUTION_POLICY.maxOutputBytes,
        maxFiles: EXECUTION_POLICY.maxFiles,
      },
      repeatCount: 3,
    }),
  )}`;
}

/** The exact phrasing used by the differential engine for a Proof Card. */
export function describeBehavior(behavior: {
  httpStatus: number;
  code: string;
}): string {
  return `HTTP ${behavior.httpStatus} with ${behavior.code}`;
}
