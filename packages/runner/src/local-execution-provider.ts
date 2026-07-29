import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { computeSnapshotDigest } from "@codeatlas/analyzer";
import { execa } from "execa";
import type {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "./execution-provider.js";
import { computeExecutionResultDigest } from "./execution-result-digest.js";
import {
  parseVitestResult,
  requiresStructuredReporter,
  unexecutedGeneratedTests,
} from "./vitest-result.js";
import {
  trustedVitestReporterSource,
  verifyTrustedVitestReport,
} from "./trusted-vitest-reporter.js";

const RUNNER_VERSION = "0.1.0";
const EXCLUDED_COPY_NAMES = new Set(["node_modules", "coverage", ".git"]);
const SECRET_NAME_SOURCE =
  "api[_-]?key|authorization|cookie|credential|passwd|password|private[_-]?key|secret|session|token";
const SECRET_LABEL_SOURCE = `(?:${SECRET_NAME_SOURCE}|[A-Za-z_][A-Za-z0-9_-]*(?:${SECRET_NAME_SOURCE})[A-Za-z0-9_-]*)`;

export interface LocalExecutionProviderOptions {
  workspaceRoot?: string;
  nodePath?: string;
  pnpmCliPath?: string;
  /** @deprecated Use pnpmCliPath. This path must still be a JavaScript CLI, never a shim. */
  pnpmPath?: string;
  temporaryParent?: string;
  platform?: NodeJS.Platform;
}

interface RuntimeIdentity {
  nodeVersion: string;
  pnpmVersion: string;
  environmentDigest: string;
}

interface LocalExecutionProviderInternals {
  platform?: NodeJS.Platform;
}

export class LocalExecutionProvider implements ExecutionProvider {
  readonly #workspaceRoot: string;
  readonly #nodePath: string;
  readonly #pnpmCliPath: string;
  readonly #temporaryParent: string;
  readonly #unsupportedPlatform: boolean;

  constructor(
    options: LocalExecutionProviderOptions = {},
    internals: LocalExecutionProviderInternals = {},
  ) {
    this.#workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    this.#nodePath = resolveNodePath(options.nodePath);
    this.#pnpmCliPath = resolvePnpmCliPath(
      options.pnpmCliPath ?? options.pnpmPath,
    );
    this.#temporaryParent = resolve(options.temporaryParent ?? tmpdir());
    this.#unsupportedPlatform =
      process.platform === "win32" ||
      options.platform === "win32" ||
      internals.platform === "win32";
  }

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    validatePolicy(request.policy);
    const startedAt = performance.now();
    if (this.#unsupportedPlatform) {
      return buildResult(request, unsupportedRuntimeIdentity(), startedAt, {
        terminalState: "FAILED",
        exitCode: null,
        stdout: "",
        stderr:
          "Unsupported platform win32: test execution requires a descendant containment boundary",
      });
    }
    const testPaths = request.testPaths.map((path) =>
      validateRelativePath(path, "test path"),
    );
    const generatedPaths = request.generatedFiles.map((file) =>
      validateRelativePath(file.path, "generated path"),
    );
    const requestedTestPaths = [...testPaths, ...generatedPaths];
    if (requestedTestPaths.length === 0) {
      throw new InputValidationError(
        "At least one selected or generated test is required",
      );
    }
    rejectDuplicates(requestedTestPaths, "requested test paths");

    const workspaceRoot = await realpath(this.#workspaceRoot);
    const snapshotRoot = await resolveSnapshotRoot(request.snapshotRoot);
    const suppliedDigest = await computeSnapshotDigest(snapshotRoot);
    if (suppliedDigest !== request.snapshotSha) {
      throw new InputValidationError(
        "Snapshot digest does not match snapshotSha",
      );
    }
    await validateSelectedTests(snapshotRoot, testPaths);
    await access(this.#nodePath, fsConstants.X_OK);
    await access(this.#pnpmCliPath, fsConstants.R_OK);

    const runtime = await resolveRuntimeIdentity(
      workspaceRoot,
      this.#nodePath,
      this.#pnpmCliPath,
    );
    let attemptRoot: string | null = null;
    let snapshotCopy: string | null = null;
    let controlRoot: string | null = null;
    let childPid: number | undefined;
    let resultArtifact: BoundArtifact | null = null;
    let coverageArtifact: BoundArtifact | null = null;
    let stdout = "";
    let stderr = "";

    try {
      await mkdir(this.#temporaryParent, { recursive: true });
      attemptRoot = await realpath(
        await mkdtemp(join(this.#temporaryParent, "codeatlas-run-")),
      );
      snapshotCopy = join(attemptRoot, "snapshot");
      controlRoot = await mkdtemp(join(attemptRoot, "control-"));
      await mkdir(snapshotCopy);

      const availableSnapshotFiles =
        request.policy.maxFiles - request.generatedFiles.length;
      if (availableSnapshotFiles < 0) {
        throw new InputValidationError(
          "Snapshot exceeds the configured file limit",
        );
      }
      await copySnapshot(snapshotRoot, snapshotCopy, availableSnapshotFiles);
      const copiedDigest = await computeSnapshotDigest(snapshotCopy);
      if (copiedDigest !== request.snapshotSha) {
        throw new InputValidationError(
          "Copied snapshot digest does not match snapshotSha",
        );
      }
      const allowedCoverage = await buildAllowedCoverageMap(snapshotCopy);
      await writeGeneratedFiles(
        snapshotCopy,
        request.generatedFiles,
        generatedPaths,
      );
      await cloneWorkspaceDependencies(workspaceRoot, snapshotCopy);

      const temporaryCache = join(controlRoot, "cache");
      await mkdir(temporaryCache);
      await writeFile(
        join(controlRoot, "package.json"),
        '{"name":"codeatlas-run-control","private":true}',
        { mode: 0o600 },
      );
      const resultPath = join(
        controlRoot,
        `vitest-result-${randomUUID()}.json`,
      );
      resultArtifact = await precreateBoundArtifact(resultPath);
      const useTrustedReporter = requiresStructuredReporter(
        request.generatedFiles,
      );
      const reportNonce = randomUUID();
      const reportKey = randomBytes(32).toString("hex");
      const reporterPath = useTrustedReporter
        ? join(controlRoot, `vitest-reporter-${randomUUID()}.mjs`)
        : null;
      const trustedConfigPath = useTrustedReporter
        ? join(controlRoot, `vitest-config-${randomUUID()}.mjs`)
        : null;
      const coverageDirectory = join(controlRoot, `coverage-${randomUUID()}`);
      await mkdir(coverageDirectory, { mode: 0o700 });
      const coveragePath = join(coverageDirectory, "coverage-final.json");
      const trustedCoveragePath = useTrustedReporter
        ? join(controlRoot, `trusted-coverage-${randomUUID()}.json`)
        : null;
      if (trustedCoveragePath !== null) {
        coverageArtifact = await precreateBoundArtifact(trustedCoveragePath);
      }
      if (reporterPath !== null && trustedCoveragePath !== null) {
        await writeFile(
          reporterPath,
          trustedVitestReporterSource(
            resultPath,
            trustedCoveragePath,
            reportNonce,
            reportKey,
          ),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      }
      if (trustedConfigPath !== null) {
        await writeFile(
          trustedConfigPath,
          "export default { test: { setupFiles: [] } };\n",
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      }
      const outputState = { bytes: 0, exceeded: false };
      const outputTransform = () => ({
        binary: true as const,
        transform: function* (
          chunk: unknown,
        ): Generator<Uint8Array, void, void> {
          if (!(chunk instanceof Uint8Array)) {
            throw new Error("Unexpected subprocess output type");
          }
          if (
            outputState.bytes + chunk.byteLength >
            request.policy.maxOutputBytes
          ) {
            outputState.exceeded = true;
            throw new OutputLimitError();
          }
          outputState.bytes += chunk.byteLength;
          yield chunk;
        },
      });
      const childEnvironment = {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "test",
        CI: "1",
        NPM_CONFIG_CACHE: temporaryCache,
        XDG_CACHE_HOME: temporaryCache,
      };
      const vitestCliPath = join(
        snapshotCopy,
        "node_modules",
        "vitest",
        "vitest.mjs",
      );
      const subprocess = execa(
        this.#nodePath,
        [
          this.#pnpmCliPath,
          "exec",
          this.#nodePath,
          vitestCliPath,
          "run",
          `--root=${snapshotCopy}`,
          `--reporter=${reporterPath ?? "json"}`,
          `--outputFile=${resultPath}`,
          ...(trustedConfigPath === null
            ? []
            : [`--config=${trustedConfigPath}`]),
          "--coverage.enabled",
          "--coverage.provider=v8",
          "--coverage.reporter=json",
          "--coverage.reportOnFailure",
          `--coverage.reportsDirectory=${coverageDirectory}`,
          ...requestedTestPaths,
        ],
        {
          cwd: controlRoot,
          timeout: request.policy.timeoutMs,
          maxBuffer: request.policy.maxOutputBytes,
          reject: false,
          extendEnv: false,
          detached: true,
          cleanup: true,
          forceKillAfterDelay: 100,
          encoding: "buffer",
          stdout: outputTransform(),
          stderr: outputTransform(),
          env: childEnvironment,
        },
      );
      childPid = subprocess.pid;
      const launched = childPid !== undefined;
      const execution = await subprocess;
      await terminateProcessTree(childPid);

      const knownPaths = [
        workspaceRoot,
        snapshotRoot,
        attemptRoot,
        snapshotCopy,
        controlRoot,
        this.#nodePath,
        this.#pnpmCliPath,
      ];
      ({ stdout, stderr } = capOutput(
        sanitizeOutput(toUtf8(execution.stdout), knownPaths),
        sanitizeOutput(toUtf8(execution.stderr), knownPaths),
        request.policy.maxOutputBytes,
      ));
      const terminalState = execution.timedOut
        ? "TIMED_OUT"
        : outputState.exceeded || execution.isMaxBuffer
          ? "OUTPUT_LIMIT"
          : undefined;
      if (terminalState !== undefined) {
        return buildResult(request, runtime, startedAt, {
          terminalState,
          exitCode: execution.exitCode ?? null,
          stdout,
          stderr,
        });
      }

      if (!launched || (execution.exitCode !== 0 && execution.exitCode !== 1)) {
        return buildResult(request, runtime, startedAt, {
          terminalState: "FAILED",
          exitCode: execution.exitCode ?? null,
          stdout,
          stderr,
        });
      }

      const remainingBytes = request.policy.maxOutputBytes - outputState.bytes;
      const resultFile = await readBoundArtifact(
        resultArtifact,
        remainingBytes,
      );
      if (resultFile.kind !== "ok") {
        return buildResult(request, runtime, startedAt, {
          terminalState:
            resultFile.kind === "output-limit" ? "OUTPUT_LIMIT" : "FAILED",
          exitCode: execution.exitCode,
          stdout,
          stderr,
        });
      }

      const coverageBytes =
        remainingBytes - Buffer.byteLength(resultFile.content);
      const coverageFile =
        coverageArtifact === null
          ? await readFreshRegularFile(coveragePath, coverageBytes)
          : await readBoundArtifact(coverageArtifact, coverageBytes);
      if (coverageFile.kind !== "ok") {
        return buildResult(request, runtime, startedAt, {
          terminalState:
            coverageFile.kind === "output-limit" ? "OUTPUT_LIMIT" : "FAILED",
          exitCode: execution.exitCode,
          stdout,
          stderr: [stderr, `Fresh coverage artifact was ${coverageFile.kind}`]
            .filter(Boolean)
            .join("\n"),
        });
      }

      const verifiedResult = useTrustedReporter
        ? verifyTrustedVitestReport(resultFile.content, reportNonce, reportKey)
        : resultFile.content;
      if (verifiedResult === null) {
        return buildResult(request, runtime, startedAt, {
          terminalState: "FAILED",
          exitCode: execution.exitCode,
          stdout,
          stderr: [stderr, "Trusted Vitest report authentication failed"]
            .filter(Boolean)
            .join("\n"),
        });
      }
      const parsed = parseVitestResult(verifiedResult, {
        snapshotRoot: snapshotCopy,
        requestedTestPaths,
        generatedFiles: request.generatedFiles,
        allowedCoverage,
        coverageArtifact: coverageFile.content,
        exitCode: execution.exitCode,
      });
      const sanitizedParsed = sanitizeParsedResult(parsed, knownPaths);
      return buildResult(request, runtime, startedAt, {
        terminalState: parsed.valid ? "COMPLETED" : "FAILED",
        exitCode: execution.exitCode,
        stdout,
        stderr,
        parsed: sanitizedParsed,
      });
    } catch (error) {
      if (error instanceof InputValidationError) throw error;
      const knownPaths = [
        workspaceRoot,
        snapshotRoot,
        attemptRoot,
        snapshotCopy,
        controlRoot,
        this.#nodePath,
        this.#pnpmCliPath,
      ];
      return buildResult(request, runtime, startedAt, {
        terminalState: "FAILED",
        exitCode: null,
        stdout,
        stderr: sanitizeOutput(
          error instanceof Error ? error.message : "Execution failed",
          knownPaths,
        ),
      });
    } finally {
      await terminateProcessTree(childPid);
      await resultArtifact?.handle.close();
      await coverageArtifact?.handle.close();
      if (attemptRoot !== null) {
        await rm(attemptRoot, { recursive: true, force: true });
      }
    }
  }
}

function unsupportedRuntimeIdentity(): RuntimeIdentity {
  const environmentDigest = createHash("sha256")
    .update(
      JSON.stringify({
        platform: "win32",
        runnerVersion: RUNNER_VERSION,
      }),
    )
    .digest("hex");
  return {
    nodeVersion: "unsupported",
    pnpmVersion: "unsupported",
    environmentDigest,
  };
}

interface BuildResultValues {
  terminalState: ExecutionResult["terminalState"];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parsed?: ReturnType<typeof parseVitestResult>;
}

function buildResult(
  request: ExecutionRequest,
  runtime: RuntimeIdentity,
  startedAt: number,
  values: BuildResultValues,
): ExecutionResult {
  const result = {
    executionId: randomUUID(),
    revision: request.revision,
    snapshotSha: request.snapshotSha,
    terminalState: values.terminalState,
    exitCode: values.exitCode,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    testCases:
      values.parsed?.testCases ??
      unexecutedGeneratedTests(request.generatedFiles),
    coverage: values.parsed?.coverage ?? [],
    observations: values.parsed?.observations ?? [],
    stdout: values.stdout,
    stderr: values.stderr,
    environmentDigest: runtime.environmentDigest,
  };
  return { ...result, resultDigest: computeExecutionResultDigest(result) };
}

async function resolveSnapshotRoot(candidate: string): Promise<string> {
  if (candidate.includes("\0")) {
    throw new InputValidationError("Snapshot root contains NUL");
  }
  if (!isAbsolute(candidate)) {
    throw new InputValidationError("Snapshot root must be absolute");
  }
  const resolved = await realpath(candidate);
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new InputValidationError("Snapshot root must be a directory");
  }
  return resolved;
}

function validateRelativePath(candidate: string, label: string): string {
  if (
    candidate.length === 0 ||
    candidate.includes("\0") ||
    candidate.startsWith("/") ||
    candidate.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(candidate)
  ) {
    throw new InputValidationError(`${label} must be repository-relative`);
  }
  const portable = candidate.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    throw new InputValidationError(`${label} contains traversal`);
  }
  if (
    portable.startsWith("-") ||
    segments.some((segment) => segment.startsWith("-"))
  ) {
    throw new InputValidationError(
      `${label} contains an option-shaped segment`,
    );
  }
  const normalized = segments.filter((segment) => segment !== ".").join("/");
  if (normalized.length === 0) {
    throw new InputValidationError(`${label} is empty`);
  }
  return normalized;
}

async function copySnapshot(
  sourceRoot: string,
  destinationRoot: string,
  maxFiles: number,
): Promise<void> {
  let files = 0;
  async function visit(
    source: string,
    destination: string,
    isRoot: boolean,
  ): Promise<void> {
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (isRoot && EXCLUDED_COPY_NAMES.has(entry.name)) continue;
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      ensureContained(sourceRoot, sourcePath, "snapshot entry");
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) {
        throw new InputValidationError("Snapshot contains a symbolic link");
      }
      if (info.isDirectory()) {
        await mkdir(destinationPath);
        await visit(sourcePath, destinationPath, false);
      } else if (info.isFile()) {
        if (files >= maxFiles) {
          throw new InputValidationError(
            "Snapshot exceeds the configured file limit",
          );
        }
        await copyFile(
          sourcePath,
          destinationPath,
          fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE,
        );
        await chmod(destinationPath, info.mode & 0o777);
        files += 1;
      } else {
        throw new InputValidationError(
          "Snapshot contains an unsupported file type",
        );
      }
    }
  }
  await visit(sourceRoot, destinationRoot, true);
}

async function buildAllowedCoverageMap(
  snapshotRoot: string,
): Promise<Map<string, number>> {
  const allowed = new Map<string, number>();
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new InputValidationError(
          "Copied snapshot contains a symbolic link",
        );
      }
      if (info.isDirectory()) {
        await visit(path);
      } else if (info.isFile()) {
        const repositoryPath = toRepositoryPath(snapshotRoot, path);
        const content = await readFile(path, "utf8");
        allowed.set(repositoryPath, content.split(/\r\n|\r|\n/u).length);
      }
    }
  }
  await visit(snapshotRoot);
  return allowed;
}

async function validateSelectedTests(
  snapshotRoot: string,
  testPaths: string[],
): Promise<void> {
  for (const path of testPaths) {
    const candidate = resolve(snapshotRoot, path);
    ensureContained(snapshotRoot, candidate, "test path");
    const resolved = await realpath(candidate);
    ensureContained(snapshotRoot, resolved, "test path");
    const info = await stat(resolved);
    if (!info.isFile()) {
      throw new InputValidationError("Selected test is not a file");
    }
  }
}

async function writeGeneratedFiles(
  temporaryRoot: string,
  files: ExecutionRequest["generatedFiles"],
  normalizedPaths: string[],
): Promise<void> {
  for (const [index, file] of files.entries()) {
    const normalizedPath = normalizedPaths[index];
    if (normalizedPath === undefined) {
      throw new InputValidationError("Generated path is missing");
    }
    const destination = resolve(temporaryRoot, normalizedPath);
    ensureContained(temporaryRoot, destination, "generated path");
    try {
      await lstat(destination);
      throw new InputValidationError(
        "Generated file would overwrite a snapshot file",
      );
    } catch (error) {
      if (error instanceof InputValidationError) throw error;
      if (!isNotFound(error)) throw error;
    }
    await mkdir(dirname(destination), { recursive: true });
    const parent = await realpath(dirname(destination));
    ensureContained(temporaryRoot, parent, "generated parent");
    await writeFile(destination, file.content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
}

async function cloneWorkspaceDependencies(
  workspaceRoot: string,
  snapshotRoot: string,
): Promise<void> {
  const source = await realpath(join(workspaceRoot, "node_modules"));
  const destination = join(snapshotRoot, "node_modules");
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    mode: fsConstants.COPYFILE_FICLONE,
    filter: (path) => {
      const info = lstatSync(path);
      return !info.isSymbolicLink() || isContained(source, realpathSync(path));
    },
  });
  await overlayWorkspacePackageDependencies(workspaceRoot, source, destination);
  await assertPrivateDependencyLinks(destination);
}

async function overlayWorkspacePackageDependencies(
  workspaceRoot: string,
  workspaceNodeModules: string,
  privateNodeModules: string,
): Promise<void> {
  const packagesRoot = join(workspaceRoot, "packages");
  for (const packageEntry of await readdir(packagesRoot, {
    withFileTypes: true,
  })) {
    if (!packageEntry.isDirectory()) continue;
    const packageModules = join(
      packagesRoot,
      packageEntry.name,
      "node_modules",
    );
    try {
      await overlayDependencyDirectory(
        packageModules,
        privateNodeModules,
        workspaceNodeModules,
        privateNodeModules,
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

async function overlayDependencyDirectory(
  sourceDirectory: string,
  destinationDirectory: string,
  workspaceNodeModules: string,
  privateNodeModules: string,
): Promise<void> {
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = join(sourceDirectory, entry.name);
    const destinationPath = join(destinationDirectory, entry.name);
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      await mkdir(destinationPath, { recursive: true });
      await overlayDependencyDirectory(
        sourcePath,
        destinationPath,
        workspaceNodeModules,
        privateNodeModules,
      );
      continue;
    }
    const info = await lstat(sourcePath);
    if (!info.isSymbolicLink()) continue;
    const target = await realpath(sourcePath);
    if (!isContained(workspaceNodeModules, target)) continue;
    const privateTarget = join(
      privateNodeModules,
      relative(workspaceNodeModules, target),
    );
    try {
      await lstat(destinationPath);
      continue;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await symlink(
      relative(dirname(destinationPath), privateTarget),
      destinationPath,
      "dir",
    );
  }
}

async function assertPrivateDependencyLinks(
  privateNodeModules: string,
): Promise<void> {
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await realpath(path);
        if (!isContained(privateNodeModules, target)) {
          throw new Error("Private dependency link escapes its clone");
        }
      } else if (info.isDirectory()) {
        await visit(path);
      }
    }
  }
  await visit(privateNodeModules);
}

interface BoundArtifact {
  path: string;
  handle: FileHandle;
  device: number | bigint;
  inode: number | bigint;
}

async function precreateBoundArtifact(path: string): Promise<BoundArtifact> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollow,
    0o600,
  );
  const info = await handle.stat();
  if (!info.isFile()) {
    await handle.close();
    throw new Error("Control artifact is not a regular file");
  }
  return { path, handle, device: info.dev, inode: info.ino };
}

async function readBoundArtifact(
  artifact: BoundArtifact,
  maxBytes: number,
): Promise<
  | { kind: "ok"; content: string }
  | { kind: "missing" }
  | { kind: "output-limit" }
> {
  try {
    const [descriptorInfo, pathInfo] = await Promise.all([
      artifact.handle.stat(),
      lstat(artifact.path),
    ]);
    if (
      !descriptorInfo.isFile() ||
      !pathInfo.isFile() ||
      pathInfo.isSymbolicLink() ||
      descriptorInfo.dev !== artifact.device ||
      descriptorInfo.ino !== artifact.inode ||
      pathInfo.dev !== artifact.device ||
      pathInfo.ino !== artifact.inode
    ) {
      return { kind: "missing" };
    }
    if (descriptorInfo.size === 0) return { kind: "missing" };
    if (descriptorInfo.size > maxBytes) return { kind: "output-limit" };
    const content = Buffer.alloc(descriptorInfo.size);
    const { bytesRead } = await artifact.handle.read(
      content,
      0,
      descriptorInfo.size,
      0,
    );
    if (bytesRead !== descriptorInfo.size) return { kind: "missing" };
    return content.byteLength <= maxBytes
      ? { kind: "ok", content: content.toString("utf8") }
      : { kind: "output-limit" };
  } catch (error) {
    if (isNotFound(error) || isSymlinkOpenError(error)) {
      return { kind: "missing" };
    }
    throw error;
  }
}

async function readFreshRegularFile(
  path: string,
  maxBytes: number,
): Promise<
  | { kind: "ok"; content: string }
  | { kind: "missing" }
  | { kind: "output-limit" }
> {
  let handle: FileHandle | undefined;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const info = await handle.stat();
    if (!info.isFile()) return { kind: "missing" };
    if (info.size > maxBytes) return { kind: "output-limit" };
    const content = await handle.readFile();
    return content.byteLength <= maxBytes
      ? { kind: "ok", content: content.toString("utf8") }
      : { kind: "output-limit" };
  } catch (error) {
    if (isNotFound(error) || isSymlinkOpenError(error)) {
      return { kind: "missing" };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function resolveRuntimeIdentity(
  workspaceRoot: string,
  nodePath: string,
  pnpmCliPath: string,
): Promise<RuntimeIdentity> {
  const minimalEnvironment = { PATH: process.env.PATH ?? "" };
  const [nodeResult, pnpmResult, lockfile] = await Promise.all([
    execa(nodePath, ["--version"], {
      reject: false,
      extendEnv: false,
      env: minimalEnvironment,
      timeout: 5_000,
      maxBuffer: 1_024,
    }),
    execa(nodePath, [pnpmCliPath, "--version"], {
      reject: false,
      extendEnv: false,
      env: minimalEnvironment,
      timeout: 5_000,
      maxBuffer: 1_024,
    }),
    readFile(join(workspaceRoot, "pnpm-lock.yaml")),
  ]);
  if (
    nodeResult.exitCode !== 0 ||
    pnpmResult.exitCode !== 0 ||
    typeof nodeResult.stdout !== "string" ||
    typeof pnpmResult.stdout !== "string" ||
    nodeResult.stdout.trim().length === 0 ||
    pnpmResult.stdout.trim().length === 0
  ) {
    throw new InputValidationError(
      "Unable to resolve actual Node/pnpm versions",
    );
  }
  const nodeVersion = nodeResult.stdout.trim();
  const pnpmVersion = pnpmResult.stdout.trim();
  const lockfileDigest = createHash("sha256").update(lockfile).digest("hex");
  const environmentDigest = createHash("sha256")
    .update(
      JSON.stringify({
        nodeVersion,
        pnpmVersion,
        lockfileDigest,
        runnerVersion: RUNNER_VERSION,
      }),
    )
    .digest("hex");
  return { nodeVersion, pnpmVersion, environmentDigest };
}

function resolveNodePath(configured: string | undefined): string {
  return resolveRegularFile(configured ?? process.execPath, "Node executable", {
    executable: true,
  });
}

function resolvePnpmCliPath(configured: string | undefined): string {
  if (configured !== undefined) {
    return resolveJavaScriptCli(configured);
  }
  const candidates = new Set<string>();
  if (process.env.npm_execpath !== undefined) {
    candidates.add(process.env.npm_execpath);
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    for (const name of ["pnpm.mjs", "pnpm.cjs", "pnpm.js"]) {
      candidates.add(join(directory, name));
      candidates.add(resolve(directory, "../lib/node_modules/pnpm/bin", name));
      candidates.add(
        resolve(directory, "../../node/node_modules/pnpm/bin", name),
      );
    }
  }
  for (const name of ["pnpm.mjs", "pnpm.cjs", "pnpm.js"]) {
    candidates.add(
      resolve(dirname(process.execPath), "../lib/node_modules/pnpm/bin", name),
    );
  }
  for (const candidate of candidates) {
    try {
      return resolveJavaScriptCli(candidate);
    } catch {
      // Fail closed only after all non-shell JavaScript CLI candidates are exhausted.
    }
  }
  throw new InputValidationError(
    "No supported pnpm JavaScript CLI could be resolved without a shell",
  );
}

function resolveJavaScriptCli(candidate: string): string {
  if (!/\.(?:cjs|mjs|js)$/u.test(candidate)) {
    throw new InputValidationError(
      "pnpm must be a JavaScript CLI; batch and shell shims are unsupported",
    );
  }
  return resolveRegularFile(candidate, "pnpm JavaScript CLI", {
    executable: false,
  });
}

function resolveRegularFile(
  candidate: string,
  label: string,
  options: { executable: boolean },
): string {
  if (!isAbsolute(candidate) || candidate.includes("\0")) {
    throw new InputValidationError(`${label} path must be absolute`);
  }
  try {
    const resolved = realpathSync(candidate);
    const info = lstatSync(resolved);
    if (!info.isFile()) throw new Error("not a file");
    accessSync(
      resolved,
      options.executable ? fsConstants.X_OK : fsConstants.R_OK,
    );
    return resolved;
  } catch {
    throw new InputValidationError(
      `${label} is not an accessible regular file`,
    );
  }
}

function sanitizeParsedResult(
  parsed: ReturnType<typeof parseVitestResult>,
  knownPaths: Array<string | null>,
): ReturnType<typeof parseVitestResult> {
  return {
    ...parsed,
    testCases: parsed.testCases.map((testCase) => ({
      ...testCase,
      name: sanitizeOutput(testCase.name, knownPaths),
      failureMessage:
        testCase.failureMessage === null
          ? null
          : sanitizeOutput(testCase.failureMessage, knownPaths),
    })),
    observations: parsed.observations.map((observation) => ({
      ...observation,
      testName: sanitizeOutput(observation.testName, knownPaths),
    })),
  };
}

function sanitizeOutput(
  value: string,
  knownPaths: Array<string | null>,
): string {
  let sanitized = value;
  const paths = knownPaths
    .filter((path): path is string => path !== null && isAbsolute(path))
    .sort((left, right) => right.length - left.length);
  for (const path of paths)
    sanitized = sanitized.replaceAll(path, "<absolute-path>");
  const secretLine = new RegExp(
    `(^|[\\t ,{])(["']?(?:${SECRET_LABEL_SOURCE})["']?\\s*[:=]\\s*)[^\\r\\n]*`,
    "gimu",
  );
  sanitized = sanitized.replace(
    secretLine,
    (_whole, prefix: string, label: string) => `${prefix}${label}[REDACTED]`,
  );
  sanitized = sanitized.replace(
    /(^|[\t (){}\[\]"'=,:;])(?:[A-Za-z]:[\\/]|\/)[^\r\n]*/gmu,
    (_whole, prefix: string) => `${prefix}<absolute-path>`,
  );
  return sanitized;
}

function capOutput(
  stdout: string,
  stderr: string,
  maxBytes: number,
): { stdout: string; stderr: string } {
  const boundedStdout = truncateUtf8(stdout, maxBytes);
  const remaining = maxBytes - Buffer.byteLength(boundedStdout);
  return { stdout: boundedStdout, stderr: truncateUtf8(stderr, remaining) };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let bounded = Buffer.from(value).subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(bounded) > maxBytes) bounded = bounded.slice(0, -1);
  return bounded;
}

function validatePolicy(policy: ExecutionRequest["policy"]): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new InputValidationError(`${name} must be a positive safe integer`);
    }
  }
}

function rejectDuplicates(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new InputValidationError(`${label} contain duplicates`);
  }
}

function toRepositoryPath(root: string, candidate: string): string {
  ensureContained(root, candidate, "repository path");
  return relative(root, candidate).split(sep).join("/");
}

function ensureContained(root: string, candidate: string, label: string): void {
  if (!isContained(root, candidate)) {
    throw new InputValidationError(`${label} escapes its root`);
  }
}

function isContained(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return !(
    result === ".." ||
    result.startsWith(`..${sep}`) ||
    isAbsolute(result)
  );
}

function toUtf8(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return "";
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
    const taskkillPath = resolve(windowsRoot, "System32", "taskkill.exe");
    await execa(taskkillPath, ["/PID", String(pid), "/T", "/F"], {
      reject: false,
      extendEnv: false,
      env: {},
      timeout: 2_000,
      maxBuffer: 1_024,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!isNoSuchProcess(error) && !isPermissionDenied(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isSymlinkOpenError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ELOOP";
}

function isNoSuchProcess(error: unknown): boolean {
  return isNodeError(error) && error.code === "ESRCH";
}

function isPermissionDenied(error: unknown): boolean {
  return isNodeError(error) && error.code === "EPERM";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

class InputValidationError extends Error {
  override readonly name = "InputValidationError";
}

class OutputLimitError extends Error {
  override readonly name = "OutputLimitError";

  constructor() {
    super("Subprocess output exceeded its configured limit");
  }
}
