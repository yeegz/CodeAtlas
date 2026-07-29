import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { signManifest, verifyManifest } from "../src/index.js";

it("detects a modified signed manifest", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = signManifest(
    {
      schemaVersion: "1.0",
      repository: {
        provider: "local",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
      analysisId: "analysis_1",
      engineVersion: "0.1.0",
      evidence: [],
    },
    privateKey,
  );
  expect(verifyManifest(signed, publicKey)).toBe(true);
  signed.manifest.engineVersion = "tampered";
  expect(verifyManifest(signed, publicKey)).toBe(false);
});
