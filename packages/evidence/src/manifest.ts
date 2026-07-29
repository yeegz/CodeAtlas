import {
  createHash,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
  type KeyLike,
} from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { z } from "zod";
import { EvidenceManifestSchema, type EvidenceManifest } from "./schema.js";

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

const SignedManifestSchema = z.object({
  manifest: EvidenceManifestSchema,
  digest: DigestSchema,
  signature: Base64UrlSchema,
});

export interface SignedManifest {
  manifest: EvidenceManifest;
  digest: string;
  signature: string;
}

function canonicalBytes(manifest: EvidenceManifest): Buffer {
  return Buffer.from(canonicalize(manifest), "utf8");
}

function digestBytes(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function formatDigest(digest: Buffer): string {
  return `sha256:${digest.toString("hex")}`;
}

export function signManifest(
  manifest: unknown,
  privateKey: KeyLike,
): SignedManifest {
  const validatedManifest = EvidenceManifestSchema.parse(manifest);
  const bytes = canonicalBytes(validatedManifest);
  const digest = formatDigest(digestBytes(bytes));
  const signature = signBytes(null, bytes, privateKey).toString("base64url");

  return { manifest: validatedManifest, digest, signature };
}

export function verifyManifest(signed: unknown, publicKey: KeyLike): boolean {
  const result = SignedManifestSchema.safeParse(signed);
  if (!result.success) {
    return false;
  }

  const bytes = canonicalBytes(result.data.manifest);
  const expectedDigest = Buffer.from(formatDigest(digestBytes(bytes)), "utf8");
  const suppliedDigest = Buffer.from(result.data.digest, "utf8");

  if (
    expectedDigest.length !== suppliedDigest.length ||
    !timingSafeEqual(expectedDigest, suppliedDigest)
  ) {
    return false;
  }

  return verifyBytes(
    null,
    bytes,
    publicKey,
    Buffer.from(result.data.signature, "base64url"),
  );
}
