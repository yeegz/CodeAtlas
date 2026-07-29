import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { posix } from "node:path";

import { canonicalize } from "json-canonicalize";

const ANALYSIS_ID = /^analysis_[0-9a-f]{64}$/u;
const KIND = /^[a-z][a-z0-9-]{0,63}$/u;
const ARTIFACT_NAME = /^([a-z][a-z0-9-]{0,63})-([0-9a-f]{64})\.json$/u;
const DEFAULT_MAX_READ_BYTES = 10 * 1024 * 1024;

export interface ArtifactStore {
  putJson(
    kind: string,
    value: unknown,
  ): Promise<{ digest: string; path: string }>;
  readJson<T>(path: string): Promise<T>;
}

export interface LocalArtifactStoreOptions {
  repositoryRoot: string;
  analysisId: string;
  maxReadBytes?: number;
}

export class LocalArtifactStore implements ArtifactStore {
  readonly #repositoryRoot: string;
  readonly #analysisId: string;
  readonly #relativeDirectory: string;
  readonly #maxReadBytes: number;

  constructor(options: LocalArtifactStoreOptions) {
    if (!ANALYSIS_ID.test(options.analysisId)) {
      throw new TypeError("analysisId is not a canonical analysis identifier");
    }
    const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) {
      throw new TypeError("maxReadBytes must be a positive safe integer");
    }
    this.#repositoryRoot = resolve(options.repositoryRoot);
    this.#analysisId = options.analysisId;
    this.#relativeDirectory = posix.join(
      ".codeatlas",
      "runs",
      this.#analysisId,
    );
    this.#maxReadBytes = maxReadBytes;
  }

  async putJson(
    kind: string,
    value: unknown,
  ): Promise<{ digest: string; path: string }> {
    if (!KIND.test(kind)) {
      throw new TypeError("artifact kind is invalid");
    }
    const canonical = canonicalJson(value);
    const hexadecimalDigest = sha256(canonical);
    const digest = `sha256:${hexadecimalDigest}`;
    const path = posix.join(
      this.#relativeDirectory,
      `${kind}-${hexadecimalDigest}.json`,
    );
    const directory = await this.#secureDirectory();
    const destination = resolve(directory, posix.basename(path));
    assertContained(directory, destination);

    try {
      const existing = await lstat(destination);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error("artifact destination is not a regular file");
      }
      await this.readJson(path);
      return { digest, path };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    const temporaryPath = resolve(
      directory,
      `.temporary-${kind}-${randomUUID()}`,
    );
    const handle = await open(
      temporaryPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(canonical, "utf8");
      await handle.sync();
      await chmod(temporaryPath, 0o600);
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, destination);
    const directoryHandle = await open(directory, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return { digest, path };
  }

  async readJson<T>(path: string): Promise<T> {
    const expectedPrefix = `${this.#relativeDirectory}/`;
    if (
      typeof path !== "string" ||
      path.includes("\0") ||
      path.includes("\\") ||
      isAbsolute(path) ||
      !path.startsWith(expectedPrefix) ||
      posix.normalize(path) !== path
    ) {
      throw new TypeError("artifact path is outside the analysis directory");
    }
    const name = posix.basename(path);
    const match = ARTIFACT_NAME.exec(name);
    if (!match || posix.dirname(path) !== this.#relativeDirectory) {
      throw new TypeError("artifact path is invalid");
    }
    const directory = await this.#secureDirectory();
    const absolutePath = resolve(directory, name);
    assertContained(directory, absolutePath);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("artifact is a symlink or is not a regular file");
    }
    if (info.size > this.#maxReadBytes) {
      throw new Error("artifact exceeds the configured read size");
    }

    const handle = await open(
      absolutePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    let content: string;
    try {
      const descriptorInfo = await handle.stat();
      if (
        !descriptorInfo.isFile() ||
        descriptorInfo.size > this.#maxReadBytes
      ) {
        throw new Error("artifact is not a bounded regular file");
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength > this.#maxReadBytes) {
        throw new Error("artifact exceeds the configured read size");
      }
      content = bytes.toString("utf8");
    } finally {
      await handle.close();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      throw new Error("artifact is not valid JSON");
    }
    const canonical = canonicalJson(parsed);
    if (canonical !== content) {
      throw new Error("artifact is not canonical JSON");
    }
    if (sha256(canonical) !== match[2]) {
      throw new Error("artifact digest does not match its content");
    }
    return parsed as T;
  }

  async #secureDirectory(): Promise<string> {
    const repositoryRoot = await realpath(this.#repositoryRoot);
    let current = repositoryRoot;
    for (const segment of [".codeatlas", "runs", this.#analysisId]) {
      current = resolve(current, segment);
      assertContained(repositoryRoot, current);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error(
            "artifact directory contains a symlink or non-directory",
          );
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await mkdir(current, { mode: 0o700 });
      }
      await chmod(current, 0o700);
    }
    return current;
  }
}

function canonicalJson(value: unknown): string {
  const result = canonicalize(value);
  if (typeof result !== "string") {
    throw new TypeError("artifact value is not canonical JSON data");
  }
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertContained(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path) ||
    path === ""
  ) {
    throw new TypeError("artifact path escapes its analysis directory");
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
