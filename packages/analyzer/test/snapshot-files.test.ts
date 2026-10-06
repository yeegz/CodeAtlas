import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, it } from "vitest";

import { readSnapshotFiles } from "../src/snapshot-digest.js";

it("includes hidden source files once and ignores generated trees at any depth", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeatlas-snapshot-files-"));
  try {
    const paths = [
      ".config/hidden.ts",
      "src/main.ts",
      "src/view.tsx",
      "src/readme.md",
      "node_modules/dependency.ts",
      "src/dist/generated.ts",
      "build/generated.ts",
      "out/generated.ts",
      "coverage/generated.ts",
      ".git/metadata.ts",
    ];
    for (const path of paths) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), path);
    }
    const snapshot = await readSnapshotFiles(root, [
      "**/*.{ts,tsx}",
      "src/*.ts",
    ]);
    expect(snapshot.files.map((file) => file.path)).toEqual([
      ".config/hidden.ts",
      "src/main.ts",
      "src/view.tsx",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects escaping directory symlinks even when they match no source pattern", async () => {
  const parent = await mkdtemp(join(tmpdir(), "codeatlas-snapshot-link-"));
  const root = join(parent, "snapshot");
  try {
    await mkdir(root);
    await symlink(parent, join(root, ".hidden-link"), "dir");
    await expect(readSnapshotFiles(root, "**/*.ts")).rejects.toThrow(
      "Symlink escapes snapshot root",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("does not traverse internal directory symlinks or include aliased files", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeatlas-snapshot-alias-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/main.ts"), "export const value = 1;");
    await symlink(join(root, "src"), join(root, "alias"), "dir");
    await symlink(root, join(root, "src/loop"), "dir");
    await symlink(join(root, "src/main.ts"), join(root, "alias.ts"));
    const snapshot = await readSnapshotFiles(root, "**/*");
    expect(snapshot.files.map((file) => file.path)).toEqual(["src/main.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
