import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { posix } from "node:path";

import { canonicalize } from "json-canonicalize";

const ANALYSIS_ID = /^analysis_[0-9a-f]{64}$/u;
const KIND = /^[a-z][a-z0-9-]{0,63}$/u;
const ARTIFACT_NAME = /^([a-z][a-z0-9-]{0,63})-sha256-([0-9a-f]{64})\.json$/u;
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

interface DirectoryIdentity {
  path: string;
  realPath: string;
  device: number;
  inode: number;
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
    if (Buffer.byteLength(canonical, "utf8") > this.#maxReadBytes) {
      throw new Error("artifact exceeds the configured size limit");
    }
    const hexadecimalDigest = sha256(canonical);
    const digest = `sha256:${hexadecimalDigest}`;
    const path = posix.join(
      this.#relativeDirectory,
      `${kind}-sha256-${hexadecimalDigest}.json`,
    );
    const directory = await this.#secureDirectory();
    const destination = resolve(directory.path, posix.basename(path));
    assertContained(directory.path, destination);

    try {
      await this.#readAndVerify(path, canonical);
      await this.#revalidateDirectory(directory);
      return { digest, path };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    const temporaryPath = resolve(
      directory.path,
      `.temporary-${kind}-${randomUUID()}`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.writeFile(canonical, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
      const temporaryInfo = await handle.stat();
      assertPrivateRegularFile(temporaryInfo, "temporary artifact");
      await handle.close();
      handle = undefined;

      await this.#revalidateDirectory(directory);
      try {
        await link(temporaryPath, destination);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await this.#readAndVerify(path, canonical);
        await this.#revalidateDirectory(directory);
        return { digest, path };
      }
      await this.#revalidateDirectory(directory);
      await this.#readAndVerify(path, canonical);
      await syncDirectory(directory);
      return { digest, path };
    } finally {
      await handle?.close();
      await this.#revalidateDirectory(directory);
      try {
        await unlink(temporaryPath);
        await syncDirectory(directory);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
  }

  async readJson<T>(path: string): Promise<T> {
    return (await this.#readAndVerify(path)) as T;
  }

  async #readAndVerify(path: string, expected?: string): Promise<unknown> {
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
    const absolutePath = resolve(directory.path, name);
    assertContained(directory.path, absolutePath);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("artifact is a symlink or is not a regular file");
    }
    assertPrivateRegularFile(info, "artifact");
    if (info.size > this.#maxReadBytes) {
      throw new Error("artifact exceeds the configured read size");
    }

    await this.#revalidateDirectory(directory);
    const handle = await open(
      absolutePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    let content: string;
    try {
      const descriptorInfo = await handle.stat();
      assertPrivateRegularFile(descriptorInfo, "artifact");
      if (
        !descriptorInfo.isFile() ||
        descriptorInfo.size > this.#maxReadBytes ||
        descriptorInfo.dev !== info.dev ||
        descriptorInfo.ino !== info.ino
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
    await this.#revalidateDirectory(directory);

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
    if (expected !== undefined && canonical !== expected) {
      throw new Error("existing artifact content does not match");
    }
    if (sha256(canonical) !== match[2]) {
      throw new Error("artifact digest does not match its content");
    }
    return parsed;
  }

  async #secureDirectory(): Promise<DirectoryIdentity> {
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
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (!isAlreadyExists(mkdirError)) throw mkdirError;
        }
      }
      const info = await lstat(current);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        (info.mode & 0o077) !== 0
      ) {
        throw new Error("artifact directory is not a private directory");
      }
      if ((await realpath(current)) !== current) {
        throw new Error("artifact directory real path changed");
      }
    }
    const info = await lstat(current);
    return {
      path: current,
      realPath: await realpath(current),
      device: info.dev,
      inode: info.ino,
    };
  }

  async #revalidateDirectory(identity: DirectoryIdentity): Promise<void> {
    const info = await lstat(identity.path);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      info.dev !== identity.device ||
      info.ino !== identity.inode ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(identity.path)) !== identity.realPath
    ) {
      throw new Error("artifact directory identity changed during publication");
    }
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

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function assertPrivateRegularFile(
  info: { isFile(): boolean; mode: number },
  description: string,
): void {
  if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
    throw new Error(`${description} mode or permissions are unsafe`);
  }
}

async function syncDirectory(directory: DirectoryIdentity): Promise<void> {
  const handle = await open(
    directory.path,
    fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    if (
      !info.isDirectory() ||
      info.dev !== directory.device ||
      info.ino !== directory.inode
    ) {
      throw new Error("artifact directory identity changed before sync");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}
