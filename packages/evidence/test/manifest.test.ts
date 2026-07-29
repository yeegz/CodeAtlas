import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signManifest, verifyManifest } from "../src/index.js";

describe("signed manifests", () => {
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
        configurationDigest: `sha256:${"c".repeat(64)}`,
        analysisId:
          "analysis_0364a45c70336fd653229fc8725174320a4245c7333863238f59c75b7e2f0aef",
        engineVersion: "0.1.0",
        evidence: [],
      },
      privateKey,
    );
    expect(verifyManifest(signed, publicKey)).toBe(true);
    signed.manifest.engineVersion = "tampered";
    expect(verifyManifest(signed, publicKey)).toBe(false);
  });

  it("rejects an unsigned extra field added to a signed manifest", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = signManifest(
      {
        schemaVersion: "1.0",
        repository: {
          provider: "local",
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
        },
        configurationDigest: `sha256:${"c".repeat(64)}`,
        analysisId:
          "analysis_0364a45c70336fd653229fc8725174320a4245c7333863238f59c75b7e2f0aef",
        engineVersion: "0.1.0",
        evidence: [],
      },
      privateKey,
    );
    Object.assign(signed.manifest, { attemptId: "attempt_1" });

    expect(verifyManifest(signed, publicKey)).toBe(false);
  });
});
