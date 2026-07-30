# Evidence Manifest v1

The Evidence Manifest is the signed, canonical record of every evidence item
behind an analysis. A Change Passport cites it by digest; `codeatlas replay`
verifies it before executing anything.

## Envelope

`signManifest` returns, and `evidence-manifest.sig` records:

```json
{
  "manifest": { "...": "the validated manifest" },
  "digest": "sha256:<64 hex characters>",
  "signature": "<base64url Ed25519 signature>"
}
```

`codeatlas analyze` writes the manifest to `evidence-manifest.json` and the
remaining envelope fields, plus the SPKI PEM public key, to
`evidence-manifest.sig`.

## Manifest fields

| Field                 | Type                | Meaning                                                     |
| --------------------- | ------------------- | ----------------------------------------------------------- |
| `schemaVersion`       | `"1.0"`             | Manifest format version.                                    |
| `repository.provider` | string              | `local` for this milestone.                                 |
| `repository.baseSha`  | 40 lowercase hex    | Base content snapshot digest.                               |
| `repository.headSha`  | 40 lowercase hex    | Head content snapshot digest.                               |
| `configurationDigest` | `sha256:<64 hex>`   | Digest of the analysis configuration and resource envelope. |
| `analysisId`          | `analysis_<64 hex>` | Deterministic identity, see below.                          |
| `engineVersion`       | string              | Engine version that produced the evidence.                  |
| `evidence`            | array               | Evidence items, each with the fields below.                 |

For the local provider, `baseSha` and `headSha` are **content** snapshot
digests, not Git commit SHAs: the first 40 hex characters of a SHA-256 over
every non-ignored file path and its content digest, in sorted order.

### Evidence item

| Field             | Meaning                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | Stable identifier for this item.                                                                                                 |
| `type`            | One of the evidence types, for example `STATIC_AST`, `RUNTIME_TRACE`, `LINE_COVERAGE`, `DIFFERENTIAL_EXECUTION`, `AI_INFERENCE`. |
| `origin`          | Producing component and version, for example `@codeatlas/differential@0.1.0`.                                                    |
| `observedAt`      | ISO-8601 timestamp.                                                                                                              |
| `reproducibility` | Whether the observation can be reproduced.                                                                                       |
| `source`          | Snapshot-bound citation: `snapshotSha`, repository-relative `path`, `startLine`, `endLine`.                                      |
| `artifactDigest`  | `sha256:` digest of the artifact that backs the claim.                                                                           |

A source citation without a `snapshotSha` is rejected by the schema. Claims are
never linked to a mutable branch location, and `AI_INFERENCE` is never
interchangeable with an observed runtime type.

## Deterministic analysis identity

```text
analysisId = "analysis_" + sha256(canonicalJson({
  provider, baseSha, headSha, configurationDigest, engineVersion
}))
```

The schema recomputes this and rejects a manifest whose `analysisId` does not
match its own inputs. Per-attempt identifiers are deliberately absent from the
canonical manifest, so re-running an identical analysis reproduces an identical
digest and signature payload.

## Canonicalisation and signing

1. Validate the manifest against the schema.
2. Serialise with JCS canonical JSON (RFC 8785).
3. `digest` is `sha256:` plus the hex SHA-256 of those canonical bytes.
4. `signature` is an Ed25519 signature over the same canonical bytes,
   base64url encoded.

Verification revalidates the schema, recomputes the canonical bytes and digest,
compares the digest with `timingSafeEqual`, and then verifies the signature.
Any schema, digest or signature mismatch returns `false`; it never throws a
partial result.

## Verifying a manifest yourself

```ts
import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { verifyManifest } from "@codeatlas/evidence";

const manifest = JSON.parse(await readFile("evidence-manifest.json", "utf8"));
const envelope = JSON.parse(await readFile("evidence-manifest.sig", "utf8"));

const verified = verifyManifest(
  { manifest, digest: envelope.digest, signature: envelope.signature },
  createPublicKey(envelope.publicKey),
);
```

The public key stored beside the signature detects modification; it does not
prove authorship. See
[the local execution boundary](./security/local-execution-boundary.md) for what
a locally signed Passport does and does not establish.

## Compatibility

`schemaVersion` is `1.0`. Additive fields will raise the minor version; any
change that alters canonical bytes for an existing manifest raises the major
version, because it would invalidate previously issued signatures.
