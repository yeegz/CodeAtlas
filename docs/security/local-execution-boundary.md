# The local execution boundary

## The honest claim

`LocalExecutionProvider` is a **containment convenience for code you already
trust**. It is not a security boundary, and it must never be used to execute a
repository you would not run on your own machine.

Running an analysis executes the repository's test suite. If that repository is
hostile, it runs with your user account, your filesystem access and your
network access. Nothing in this milestone prevents that.

Hosted, third-party or untrusted execution is the job of the later sandbox
execution plan, where every stage that reads or executes repository content
runs in an ephemeral gVisor Kubernetes Job with default-deny egress, no cloud
credentials and enforced resource limits.

## What the local provider does enforce

These reduce accidental damage and make results reproducible. They do not
contain a determined attacker.

- The snapshot is copied into a fresh `mkdtemp` directory, and the temporary
  directory is removed in a `finally` block.
- `node_modules`, `coverage` and `.git` are excluded from the copy, and a file
  count cap rejects oversized snapshots.
- Symlinks that resolve outside the snapshot root are rejected.
- Generated test paths are validated as relative and traversal-free before
  anything is written.
- The child process is spawned with an argument array. No user-controlled value
  is ever interpolated into a shell command, and no shell is used.
- The environment is not inherited: the child receives only `PATH`, `NODE_ENV`,
  `CI` and temporary cache directories.
- Wall-clock time and output size are bounded. Exceeding either produces a
  terminal `TIMED_OUT` or `OUTPUT_LIMIT` state with no retry.
- Absolute workspace paths and environment-shaped secrets are redacted from
  returned logs.
- The runtime identity (Node version, pnpm version, lockfile digest, runner
  version) is hashed into an environment digest, and a comparison across
  mismatched environments cannot produce a confirmed finding.

## Integrity of stored evidence

- Artifacts are addressed by the SHA-256 digest of their canonical JSON. Reading
  an artifact re-verifies the content against the digest in its own filename.
- The Evidence Manifest is signed with Ed25519 over the canonical serialisation.
  Verification revalidates the schema, recomputes the digest and compares it
  with `timingSafeEqual` before checking the signature.
- `codeatlas replay` verifies the bundle schema, every artifact's
  content address, the manifest digest and the manifest signature **before any
  test process is created**. A tampered bundle exits `5` having executed
  nothing.
- The workspace refuses to render an analysis whose manifest does not verify,
  rather than displaying it with a warning.

## Trust model of the local signing key

`codeatlas analyze` generates an ephemeral Ed25519 key per run and writes the
public key next to the signature in `evidence-manifest.sig`. This detects
modification of an artifact or manifest **in transit or at rest**. It does not
prove authorship: anyone able to rewrite the manifest can also rewrite the
adjacent public key.

Binding a Passport to an identity requires a key the verifier already trusts.
That is a property of the hosted control plane, not of this local milestone.
Treat a locally produced Passport as evidence you generated yourself, not as
evidence you can hand to a third party as proof of origin.

## Reporting

Please report suspected vulnerabilities as described in
[SECURITY.md](../../SECURITY.md).
