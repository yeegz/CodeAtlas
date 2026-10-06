import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { glob } from "tinyglobby";

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".git",
]);
const IGNORED_PATHS = [...IGNORED_DIRECTORIES].map((name) => `**/${name}/**`);

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repositoryPath(root: string, absolutePath: string): string {
  const path = relative(root, absolutePath).split(sep).join("/");
  if (
    path === "" ||
    path === ".." ||
    path.startsWith("../") ||
    isAbsolute(path)
  ) {
    throw new Error(`Path escapes snapshot root: ${absolutePath}`);
  }
  return path;
}

async function assertNoEscapingSymlinks(root: string): Promise<void> {
  // Globbing without following links omits them entirely. Inspect directory
  // entries separately so even non-source and hidden links are validated.
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(path);
        if (!isWithinRoot(root, target)) {
          throw new Error(
            `Symlink escapes snapshot root: ${repositoryPath(root, path)}`,
          );
        }
      } else if (entry.isDirectory()) {
        directories.push(path);
      }
    }
  }
}

export interface SnapshotFileContent {
  absolutePath: string;
  path: string;
  text: string;
  digest: string;
}

export async function readSnapshotFiles(
  suppliedRoot: string,
  patterns: string | string[],
): Promise<{ root: string; files: SnapshotFileContent[] }> {
  const root = await realpath(resolve(suppliedRoot));
  await assertNoEscapingSymlinks(root);
  const entries = await glob(patterns, {
    cwd: root,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    expandDirectories: false,
    ignore: IGNORED_PATHS,
    absolute: true,
  });
  const files: SnapshotFileContent[] = [];

  for (const entry of entries) {
    const stats = await lstat(entry);
    if (!stats.isFile()) continue;
    const resolvedEntry = await realpath(entry);
    if (!isWithinRoot(root, resolvedEntry)) {
      throw new Error(
        `File escapes snapshot root: ${repositoryPath(root, entry)}`,
      );
    }
    const content = await readFile(resolvedEntry);
    files.push({
      absolutePath: resolvedEntry,
      path: repositoryPath(root, resolvedEntry),
      text: content.toString("utf8"),
      digest: createHash("sha256").update(content).digest("hex"),
    });
  }

  files.sort((left, right) => compareText(left.path, right.path));
  return { root, files };
}

export async function computeSnapshotDigest(root: string): Promise<string> {
  const snapshot = await readSnapshotFiles(root, "**/*");
  const digest = createHash("sha256");

  for (const file of snapshot.files) {
    const pathBytes = Buffer.from(file.path, "utf8");
    const contentDigestBytes = Buffer.from(file.digest, "hex");
    const pathLength = Buffer.allocUnsafe(4);
    pathLength.writeUInt32BE(pathBytes.length);
    digest.update(pathLength).update(pathBytes).update(contentDigestBytes);
  }

  return digest.digest("hex").slice(0, 40);
}
