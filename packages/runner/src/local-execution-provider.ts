import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import type {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "./execution-provider.js";
import { parseVitestResult } from "./vitest-result.js";

const RUNNER_VERSION = "0.1.0";
const EXCLUDED_COPY_NAMES = new Set(["node_modules", "coverage", ".git"]);
const SECRET_NAME =
  /(?:api[_-]?key|authorization|cookie|credential|passwd|password|private[_-]?key|secret|session|token)/iu;

export interface LocalExecutionProviderOptions {
  workspaceRoot?: string;
  pnpmPath?: string;
  temporaryParent?: string;
}

export class LocalExecutionProvider implements ExecutionProvider {
  readonly #workspaceRoot: string;
  readonly #pnpmPath: string;
  readonly #temporaryParent: string;

  constructor(options: LocalExecutionProviderOptions = {}) {
    this.#workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    this.#pnpmPath = resolvePnpmPath(options.pnpmPath);
    this.#temporaryParent = resolve(options.temporaryParent ?? tmpdir());
  }

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    validatePolicy(request.policy);
    const workspaceRoot = await realpath(this.#workspaceRoot);
    const snapshotRoot = await resolveSnapshotRoot(
      request.snapshotRoot,
      workspaceRoot,
    );
    const testPaths = request.testPaths.map((path) =>
      validateRelativePath(path, "test path"),
    );
    const generatedPaths = request.generatedFiles.map((file) =>
      validateRelativePath(file.path, "generated path"),
    );
    rejectDuplicates(testPaths, "test paths");
    rejectDuplicates(generatedPaths, "generated paths");
    await access(this.#pnpmPath, fsConstants.X_OK);

    const startedAt = performance.now();
    let temporaryRoot: string | null = null;
    let childPid: number | undefined;
    try {
      await mkdir(this.#temporaryParent, { recursive: true });
      temporaryRoot = await realpath(
        await mkdtemp(join(this.#temporaryParent, "codeatlas-run-")),
      );
      const availableSnapshotFiles =
        request.policy.maxFiles - request.generatedFiles.length;
      if (availableSnapshotFiles < 0) {
        throw new InputValidationError(
          "Snapshot exceeds the configured file limit",
        );
      }
      await copySnapshot(snapshotRoot, temporaryRoot, availableSnapshotFiles);
      await validateSelectedTests(snapshotRoot, testPaths);
      await writeGeneratedFiles(
        temporaryRoot,
        request.generatedFiles,
        generatedPaths,
      );

      await createDependencyBridge(workspaceRoot, temporaryRoot);

      const temporaryCache = join(temporaryRoot, ".cache");
      await mkdir(temporaryCache, { recursive: true });
      const resultPath = join(temporaryRoot, ".codeatlas-vitest-result.json");
      const outputState = { bytes: 0, exceeded: false };
      const outputTransform = () => ({
        binary: true as const,
        transform: function* (
          chunk: unknown,
        ): Generator<Uint8Array, void, void> {
          if (!(chunk instanceof Uint8Array))
            throw new Error("Unexpected subprocess output type");
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

      const subprocess = execa(
        this.#pnpmPath,
        [
          "exec",
          "vitest",
          "run",
          ...testPaths,
          ...generatedPaths,
          "--reporter=json",
          `--outputFile=${resultPath}`,
          "--coverage.enabled",
          "--coverage.provider=v8",
          "--coverage.reporter=json",
        ],
        {
          cwd: temporaryRoot,
          timeout: request.policy.timeoutMs,
          maxBuffer: request.policy.maxOutputBytes,
          reject: false,
          extendEnv: false,
          detached: process.platform !== "win32",
          cleanup: true,
          forceKillAfterDelay: 100,
          encoding: "buffer",
          stdout: outputTransform(),
          stderr: outputTransform(),
          env: {
            PATH: process.env.PATH ?? "",
            NODE_ENV: "test",
            CI: "1",
            NPM_CONFIG_CACHE: temporaryCache,
            XDG_CACHE_HOME: temporaryCache,
          },
        },
      );
      childPid = subprocess.pid;
      const execution = await subprocess;
      if (execution.timedOut || execution.isMaxBuffer || outputState.exceeded) {
        await terminateProcessTree(childPid);
      } else {
        childPid = undefined;
      }

      const boundedOutput = capOutput(
        sanitizeOutput(toUtf8(execution.stdout), workspaceRoot, temporaryRoot),
        sanitizeOutput(toUtf8(execution.stderr), workspaceRoot, temporaryRoot),
        request.policy.maxOutputBytes,
      );
      const { stdout, stderr } = boundedOutput;
      const terminalState = execution.timedOut
        ? "TIMED_OUT"
        : outputState.exceeded || execution.isMaxBuffer
          ? "OUTPUT_LIMIT"
          : undefined;

      if (terminalState !== undefined) {
        return await buildResult(request, {
          terminalState,
          exitCode: execution.exitCode ?? null,
          durationMs: performance.now() - startedAt,
          stdout,
          stderr,
          environmentDigest: await environmentDigest(workspaceRoot),
          parsed: null,
        });
      }

      const remainingBytes = request.policy.maxOutputBytes - outputState.bytes;
      const resultJson = await readBoundedFile(resultPath, remainingBytes);
      if (resultJson === null) {
        await terminateProcessTree(childPid);
        return await buildResult(request, {
          terminalState: "OUTPUT_LIMIT",
          exitCode: execution.exitCode ?? null,
          durationMs: performance.now() - startedAt,
          stdout,
          stderr,
          environmentDigest: await environmentDigest(workspaceRoot),
          parsed: null,
        });
      }

      const parsed = parseVitestResult(resultJson, {
        temporaryRoot,
        generatedFiles: request.generatedFiles,
      });
      const sanitizedParsed = sanitizeParsedFailures(
        parsed,
        workspaceRoot,
        temporaryRoot,
      );
      return await buildResult(request, {
        terminalState: parsed.valid ? "COMPLETED" : "FAILED",
        exitCode: execution.exitCode ?? null,
        durationMs: performance.now() - startedAt,
        stdout,
        stderr,
        environmentDigest: await environmentDigest(workspaceRoot),
        parsed: sanitizedParsed,
      });
    } catch (error) {
      if (error instanceof InputValidationError) throw error;
      return await buildResult(request, {
        terminalState: "FAILED",
        exitCode: null,
        durationMs: performance.now() - startedAt,
        stdout: "",
        stderr: sanitizeOutput(
          error instanceof Error ? error.message : "Execution failed",
          this.#workspaceRoot,
          temporaryRoot,
        ),
        environmentDigest: await environmentDigest(this.#workspaceRoot).catch(
          () => "unavailable",
        ),
        parsed: null,
      });
    } finally {
      await terminateProcessTree(childPid);
      if (temporaryRoot !== null) {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  }
}

async function createDependencyBridge(
  workspaceRoot: string,
  temporaryRoot: string,
): Promise<void> {
  const nodeModules = join(temporaryRoot, "node_modules");
  await mkdir(join(nodeModules, ".bin"), { recursive: true });
  await mkdir(join(nodeModules, "@vitest"), { recursive: true });

  const links = [
    {
      source: join(workspaceRoot, "node_modules", "vitest", "vitest.mjs"),
      destination: join(nodeModules, ".bin", "vitest"),
      type: "file" as const,
    },
    {
      source: join(workspaceRoot, "node_modules", "vitest"),
      destination: join(nodeModules, "vitest"),
      type: "junction" as const,
    },
    {
      source: join(workspaceRoot, "node_modules", "@vitest", "coverage-v8"),
      destination: join(nodeModules, "@vitest", "coverage-v8"),
      type: "junction" as const,
    },
  ];
  for (const link of links) {
    const target = await realpath(link.source);
    ensureContained(workspaceRoot, target, "workspace dependency path");
    await symlink(target, link.destination, link.type);
  }
}

interface BuildResultOptions {
  terminalState: ExecutionResult["terminalState"];
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  environmentDigest: string;
  parsed: ReturnType<typeof parseVitestResult> | null;
}

async function buildResult(
  request: ExecutionRequest,
  options: BuildResultOptions,
): Promise<ExecutionResult> {
  return {
    revision: request.revision,
    snapshotSha: request.snapshotSha,
    terminalState: options.terminalState,
    exitCode: options.exitCode,
    durationMs: Math.max(0, Math.round(options.durationMs)),
    testCases: options.parsed?.testCases ?? [],
    coverage: options.parsed?.coverage ?? [],
    observations: options.parsed?.observations ?? [],
    stdout: options.stdout,
    stderr: options.stderr,
    environmentDigest: options.environmentDigest,
  };
}

async function resolveSnapshotRoot(
  candidate: string,
  workspaceRoot: string,
): Promise<string> {
  if (candidate.includes("\0"))
    throw new InputValidationError("Snapshot root contains NUL");
  if (!isAbsolute(candidate))
    throw new InputValidationError("Snapshot root must be absolute");
  const resolved = await realpath(candidate);
  ensureContained(workspaceRoot, resolved, "snapshot root");
  const info = await stat(resolved);
  if (!info.isDirectory())
    throw new InputValidationError("Snapshot root must be a directory");
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
  if (
    segments.some((segment) => segment === "..") ||
    segments.some((segment) => segment === "")
  ) {
    throw new InputValidationError(`${label} contains traversal`);
  }
  const normalized = segments.filter((segment) => segment !== ".").join("/");
  if (normalized.length === 0)
    throw new InputValidationError(`${label} is empty`);
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
      if (info.isSymbolicLink())
        throw new InputValidationError("Snapshot contains a symbolic link");
      if (info.isDirectory()) {
        await mkdir(destinationPath);
        await visit(sourcePath, destinationPath, false);
      } else if (info.isFile()) {
        if (files >= maxFiles) {
          throw new InputValidationError(
            "Snapshot exceeds the configured file limit",
          );
        }
        await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
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
    if (!info.isFile())
      throw new InputValidationError("Selected test is not a file");
  }
}

async function writeGeneratedFiles(
  temporaryRoot: string,
  files: ExecutionRequest["generatedFiles"],
  normalizedPaths: string[],
): Promise<void> {
  for (const [index, file] of files.entries()) {
    const normalizedPath = normalizedPaths[index];
    if (normalizedPath === undefined)
      throw new InputValidationError("Generated path is missing");
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

function ensureContained(root: string, candidate: string, label: string): void {
  const result = relative(root, candidate);
  if (result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    throw new InputValidationError(`${label} escapes its root`);
  }
}

function resolvePnpmPath(configured: string | undefined): string {
  if (configured !== undefined) {
    if (!isAbsolute(configured) || configured.includes("\0")) {
      throw new InputValidationError("pnpm executable path must be absolute");
    }
    return resolve(configured);
  }
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = resolve(directory, executable);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue searching the minimal PATH without invoking a shell.
    }
  }
  throw new InputValidationError(
    "Unable to resolve an absolute pnpm executable",
  );
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) return null;
    const content = await readFile(path);
    return content.byteLength <= maxBytes ? content.toString("utf8") : null;
  } catch (error) {
    if (isNotFound(error)) return "";
    throw error;
  }
}

async function environmentDigest(workspaceRoot: string): Promise<string> {
  const [manifest, lockfile] = await Promise.all([
    readFile(join(workspaceRoot, "package.json"), "utf8"),
    readFile(join(workspaceRoot, "pnpm-lock.yaml")),
  ]);
  const packageManager = (JSON.parse(manifest) as { packageManager?: unknown })
    .packageManager;
  const pnpmVersion =
    typeof packageManager === "string" && packageManager.startsWith("pnpm@")
      ? packageManager.slice("pnpm@".length)
      : "unknown";
  return createHash("sha256")
    .update(
      JSON.stringify({
        nodeVersion: process.version,
        pnpmVersion,
        lockfileDigest: createHash("sha256").update(lockfile).digest("hex"),
        runnerVersion: RUNNER_VERSION,
      }),
    )
    .digest("hex");
}

function sanitizeParsedFailures(
  parsed: ReturnType<typeof parseVitestResult>,
  workspaceRoot: string,
  temporaryRoot: string,
): ReturnType<typeof parseVitestResult> {
  return {
    ...parsed,
    testCases: parsed.testCases.map((testCase) => ({
      ...testCase,
      name: sanitizeOutput(testCase.name, workspaceRoot, temporaryRoot),
      failureMessage:
        testCase.failureMessage === null
          ? null
          : sanitizeOutput(
              testCase.failureMessage,
              workspaceRoot,
              temporaryRoot,
            ),
    })),
    observations: parsed.observations.map((observation) => ({
      ...observation,
      testName: sanitizeOutput(
        observation.testName,
        workspaceRoot,
        temporaryRoot,
      ),
    })),
  };
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

function sanitizeOutput(
  value: string,
  workspaceRoot: string,
  temporaryRoot: string | null,
): string {
  let sanitized = value;
  const roots = [workspaceRoot, temporaryRoot].filter(
    (root): root is string => root !== null,
  );
  for (const root of roots.sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.replaceAll(
      root,
      root === temporaryRoot ? "<sandbox>" : "<workspace>",
    );
  }
  sanitized = sanitized.replace(
    /(["']?)([A-Za-z_][A-Za-z0-9_-]*)(\1\s*[:=]\s*)(["']?)([^\s,"'}]+)(["']?)/gu,
    (
      whole,
      quote: string,
      name: string,
      separator: string,
      valueQuote: string,
      _value: string,
      endQuote: string,
    ) =>
      SECRET_NAME.test(name)
        ? `${quote}${name}${separator}${valueQuote}[REDACTED]${endQuote}`
        : whole,
  );
  sanitized = sanitized.replace(
    /(?:[A-Za-z]:[\\/]|\/)(?:[^\s:"'<>|]+[\\/])*[^\s:"'<>|]*/gu,
    (path) => (path.startsWith("<") ? path : "<absolute-path>"),
  );
  return sanitized;
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
    if (!isNoSuchProcess(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNoSuchProcess(error: unknown): boolean {
  return isNodeError(error) && error.code === "ESRCH";
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
