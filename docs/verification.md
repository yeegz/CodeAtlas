# Local release verification

This record covers the local evidence workflow in
[PR #5](https://github.com/yeegz/CodeAtlas/pull/5), with implementation revision
`204caba036321d6efb6645b12907a9384f73bc0c` checked on 2026-10-06.

## Release scope

The implementation analyzes trusted local TypeScript/JavaScript snapshots,
selects relevant tests, executes base/head comparisons, generates the supported
regression test, and exposes the resulting evidence through the CLI and web
workspace. Passports and manifests are signed and exported; replay verifies
integrity before executing recorded tests.

The completion fixes require signature verification even when key material is
missing, select the current replay bundle after repeated analyses, and preserve
temporary artifact ownership during cleanup. Snapshot traversal retains hidden
files, ignored-directory rules, deduplicated matches, and symlink checks after
replacing the vulnerable globbing dependency.

This is a local release for trusted repositories on macOS/Linux. Hosted
authentication, Firebase services, a GitHub App, tenant isolation, gVisor
execution, and Windows process containment remain unimplemented. See the
[execution boundary](security/local-execution-boundary.md).

## Checks on the implementation revision

Local verification used Node.js 26.0.0 and pnpm 11.9.0 on macOS. CI uses the
repository's `.node-version` on Ubuntu.

| Check                                                                              | Recorded result                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------ |
| Fresh `pnpm install --offline --frozen-lockfile` using the populated package cache | Passed                                     |
| `pnpm vitest run packages/analyzer/test apps/web/test`                             | 28 tests passed in 5 files                 |
| Real runner regression: selected authentication test on both snapshot revisions    | Passed                                     |
| Artifact-store ownership and cleanup tests                                         | 17 focused tests passed                    |
| `pnpm typecheck` after deleting `apps/web/.next`                                   | Passed; route declarations generated first |
| `pnpm --filter @codeatlas/web build`                                               | Passed with Next.js 15.5.27                |
| `pnpm lint` and `pnpm format:check`                                                | Passed                                     |
| `pnpm audit`                                                                       | Zero reported vulnerabilities              |
| `pnpm audit --prod`                                                                | Zero reported vulnerabilities              |

Earlier validation of the replay completion included 12 CLI checks and all
9 production-build acceptance tests. Those results predate the dependency and
artifact-cleanup changes and do not replace the complete Linux check below.

The dependency update includes Next.js 15.5.27, sharp 0.35.5, Vitest and its
coverage provider 4.1.11, and compatible patched resolutions for PostCSS,
Nano ID, source-map-js, brace-expansion, js-yaml, and undici. No advisory is
suppressed. Fixture content digests remain unchanged.

## Complete Linux gate

At publication, the complete `pnpm verify` runs for the implementation revision
were still in progress:

- [Pull-request verification](https://github.com/yeegz/CodeAtlas/actions/runs/37449237024)
- [Push verification](https://github.com/yeegz/CodeAtlas/actions/runs/37449230257)

These links are evidence for that revision. For a later commit, use the checks
on the [current pull request](https://github.com/yeegz/CodeAtlas/pull/5/checks).
A queued or running workflow is not a passing release gate. Merge review must
confirm a successful complete check on the current head.

`pnpm verify` runs formatting, lint, route generation and type checking, all
unit/integration tests, CLI and browser acceptance tests, and a production
build. Dependency audits are separate commands. The real execution tests can
take more than thirty minutes; run them without competing analysis jobs.
