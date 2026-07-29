# Contributing to CodeAtlas

CodeAtlas is currently in an active architecture and vertical-slice build. Small, evidence-backed changes are easier to review than broad speculative additions.

## Before you start

1. Read the product specification in `docs/superpowers/specs/`.
2. Check the active implementation plan in `docs/superpowers/plans/`.
3. Confirm the capability is not intentionally assigned to a later hosted milestone.
4. Never use the trusted-local runner on a repository you do not trust.

## Local setup

```bash
corepack enable
pnpm install --frozen-lockfile
```

Use Node.js `24.18.0` or newer within the repository's declared `<27` range and pnpm `11.9.0`.

## Change discipline

- Add one behavior-focused failing test before production code.
- Verify the failure is caused by the missing behavior, then implement the smallest correct change.
- Prefer real components and subprocesses over mocks when testing evidence or security boundaries.
- Keep repository code, generated tests, outputs, paths, and package metadata classified as untrusted inputs.
- Preserve the distinction between static evidence, observed runtime evidence, and `AI_INFERENCE`.
- Never turn missing or malformed evidence into a verified claim.
- Use conventional, focused commits such as `feat:`, `fix:`, `test:`, `docs:`, and `build:`.

## Verification

At minimum, run the focused package tests, then:

```bash
pnpm typecheck
pnpm lint
```

Run `pnpm test` only when the branch is expected to be green. The active development branch may intentionally contain committed RED tests at a documented TDD pause point; check the latest commit and handoff before changing those expectations.

## Pull requests

A pull request should explain:

- the user-visible or evidence-integrity outcome;
- the failing test that drove the change;
- the verification commands and results;
- security or trust-boundary implications;
- known limitations and deferred work.

Do not claim Firebase hosting, GitHub private-repository access, GKE sandboxing, or production readiness until the corresponding milestone and acceptance gates are complete.
