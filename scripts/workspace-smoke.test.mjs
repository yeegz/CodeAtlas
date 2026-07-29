import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workspace pins the production LTS toolchain", async () => {
  const root = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(root.packageManager, "pnpm@11.9.0");
  assert.equal(root.engines.node, ">=24.18.0 <27");
  assert.equal(root.private, true);
});
