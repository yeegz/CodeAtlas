import { generateKeyPairSync } from "node:crypto";

import { deriveAnalysisId, signManifest } from "@codeatlas/evidence";
import { describe, expect, it } from "vitest";

import {
  UNVERIFIED_MANIFEST_MESSAGE,
  assertVerifiedManifest,
} from "@/lib/demo-store";

const IDENTITY = {
  provider: "local",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  configurationDigest: `sha256:${"c".repeat(64)}`,
  engineVersion: "0.1.0",
} as const;

function signedFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = signManifest(
    {
      schemaVersion: "1.0",
      repository: {
        provider: IDENTITY.provider,
        baseSha: IDENTITY.baseSha,
        headSha: IDENTITY.headSha,
      },
      configurationDigest: IDENTITY.configurationDigest,
      analysisId: deriveAnalysisId(IDENTITY),
      engineVersion: IDENTITY.engineVersion,
      evidence: [],
    },
    privateKey,
  );
  return { signed, publicKey };
}

describe("workspace evidence guard", () => {
  it("accepts a manifest whose signature still verifies", () => {
    const { signed, publicKey } = signedFixture();
    expect(() => assertVerifiedManifest(signed, publicKey)).not.toThrow();
  });

  it("refuses to present a modified manifest as evidence", () => {
    const { signed, publicKey } = signedFixture();
    signed.manifest.engineVersion = "0.1.0-tampered";
    expect(() => assertVerifiedManifest(signed, publicKey)).toThrow(
      UNVERIFIED_MANIFEST_MESSAGE,
    );
  });

  it("refuses a manifest signed by a different key", () => {
    const { signed } = signedFixture();
    const other = generateKeyPairSync("ed25519");
    expect(() => assertVerifiedManifest(signed, other.publicKey)).toThrow(
      UNVERIFIED_MANIFEST_MESSAGE,
    );
  });
});
