# CodeAtlas Evidence Core Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real local CodeAtlas vertical slice that maps a TypeScript authentication change, selects and executes relevant tests on base and head, generates and executes one evidence-targeted regression test, produces a signed Change Passport, replays the finding, and renders the result in the Forensic Cartography workspace.

**Architecture:** A pnpm TypeScript monorepo keeps evidence schemas, static analysis, selection, execution, differential comparison, Passport assembly, CLI, and web UI behind focused package interfaces. This milestone uses a local execution provider and local fixture snapshots, but the provider contracts and immutable evidence model are the same contracts that the later Firebase/GKE plans will implement.

**Tech Stack:** Node.js 24.18.0 LTS, pnpm 11.9.0, TypeScript 5.9.3, Vitest 4.1.10, Zod 4.4.3, Next.js 15.2.9, React 19.0.8, IBM Plex Sans/Mono, Familjen Grotesk, Playwright 1.62.0.

## Global Constraints

- The product name is **CodeAtlas** everywhere.
- V1 supports TypeScript and JavaScript repositories only.
- Core verification remains useful with AI disabled.
- Repository code, generated tests, test output, and package scripts are untrusted inputs.
- Child processes use argument arrays, bounded time/output, a minimal environment, and never interpolate user input into a shell command.
- Every source citation includes an immutable snapshot SHA and repository-relative path.
- `AI_INFERENCE` is never visually or semantically equivalent to observed runtime evidence.
- A confirmed finding requires repeatable base/head execution evidence; static inference alone cannot confirm a regression.
- Generated tests are labelled generated and executed or unexecuted; they cannot certify themselves.
- The UI uses Forensic Cartography: `#EEF2F1`, `#F8FAF9`, `#102832`, `#2368D7`, `#55D5AA`, `#AE3A31`, and `#6F8A90`.
- No Tailwind CSS, glassmorphism, ambient particles, decorative metric cards, fake confidence percentages, or unsupported “safe to merge” claims.
- Keyboard access, reduced motion, graph-list equivalence, and WCAG 2.2 AA contrast are release requirements.
- Test-first development and a focused commit are required for every task.

---

## Delivery decomposition

The approved product spec contains several independent systems. Delivery is split so each plan ends in working software:

1. **This plan — Evidence Core vertical slice:** local real-data analysis, Passport, replay, and workspace.
2. **Hosted control plane plan:** Firebase Authentication/App Hosting, Cloud SQL, Firestore progress, Cloud Storage, Tasks, and Workflows.
3. **Sandbox execution plan:** GKE Autopilot gVisor Jobs, source broker, result ingestor, egress proxy, quotas, cleanup, and adversarial tests.
4. **GitHub production plan:** GitHub App installation, public/private repositories, webhook handling, Checks, tenant authorization, retention, and deletion.
5. **Launch-hardening plan:** production observability, cost controls, benchmark fixtures, accessibility, security review, and deployment acceptance gates.

## File structure

```text
.
├── apps/
│   ├── cli/
│   │   ├── package.json
│   │   ├── src/{index.ts,commands/analyze.ts,commands/replay.ts}
│   │   └── test/cli.test.ts
│   └── web/
│       ├── package.json
│       ├── next.config.ts
│       ├── src/app/{layout.tsx,page.tsx,globals.css}
│       ├── src/app/api/demo/route.ts
│       ├── src/app/demo/pr/284/page.tsx
│       ├── src/components/{evidence-map.tsx,proof-card.tsx,passport-bar.tsx,workspace-nav.tsx}
│       └── test/workspace.test.tsx
├── fixtures/auth-regression/
│   ├── base/{package.json,src/auth.ts,test/auth.test.ts}
│   └── head/{package.json,src/auth.ts,test/auth.test.ts}
├── packages/
│   ├── evidence/src/{schema.ts,manifest.ts,index.ts}
│   ├── analyzer/src/{types.ts,snapshot-digest.ts,analyze-snapshot.ts,changed-lines.ts,index.ts}
│   ├── selector/src/{select-tests.ts,index.ts}
│   ├── runner/src/{execution-provider.ts,local-execution-provider.ts,vitest-result.ts,index.ts}
│   ├── generator/src/{derive-objectives.ts,template-generator.ts,index.ts}
│   ├── differential/src/{compare-runs.ts,index.ts}
│   ├── passport/src/{build-passport.ts,index.ts}
│   └── pipeline/src/{analyze-comparison.ts,local-artifact-store.ts,index.ts}
├── test/e2e/{cli-replay.spec.ts,workspace.spec.ts}
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.json
├── tsconfig.base.json
├── vitest.workspace.ts
├── eslint.config.mjs
├── .prettierignore
├── playwright.config.ts
├── .node-version
└── README.md
```

Each package owns its tests beside `src` in a `test` directory. Package entrypoints export only documented public contracts. Infrastructure-specific code may depend on domain packages; domain packages never depend on infrastructure or Next.js.

All internal packages use version `0.0.0`, `private: true`, `type: "module"`, and `exports: { ".": "./src/index.ts" }`. Declare dependencies in the owning manifest as follows:

| Package | Runtime dependencies | Development dependencies |
| --- | --- | --- |
| `@codeatlas/evidence` | `zod@4.4.3`, `json-canonicalize@2.0.0` | root toolchain |
| `@codeatlas/analyzer` | `@codeatlas/evidence@workspace:*`, `diff@9.0.0`, `fast-glob@3.3.3`, `typescript@5.9.3` | root toolchain |
| `@codeatlas/selector` | `@codeatlas/evidence@workspace:*`, `@codeatlas/analyzer@workspace:*` | root toolchain |
| `@codeatlas/runner` | `@codeatlas/evidence@workspace:*`, `execa@10.0.0` | `@vitest/coverage-v8@4.1.10` |
| `@codeatlas/generator` | `@codeatlas/evidence@workspace:*`, `@codeatlas/analyzer@workspace:*`, `@codeatlas/runner@workspace:*` | root toolchain |
| `@codeatlas/differential` | `@codeatlas/evidence@workspace:*`, `@codeatlas/runner@workspace:*` | root toolchain |
| `@codeatlas/passport` | `@codeatlas/evidence@workspace:*` | root toolchain |
| `@codeatlas/pipeline` | all seven domain packages above | root toolchain |
| `@codeatlas/cli` | `@codeatlas/pipeline@workspace:*`, `@codeatlas/evidence@workspace:*`, `commander@15.0.0` | root toolchain |
| `@codeatlas/web` | `@codeatlas/evidence@workspace:*`, `@codeatlas/pipeline@workspace:*`, `next@15.2.9`, `react@19.0.8`, `react-dom@19.0.8` | `@testing-library/jest-dom@7.0.0`, `@testing-library/react@16.3.2`, `@types/react@19.0.14`, `@types/react-dom@19.0.6`, `eslint-config-next@15.2.9`, `jsdom@30.0.0` |

Root acceptance dependencies added in Task 12 are `@playwright/test@1.62.0` and `@axe-core/playwright@4.12.1`.

### Task 1: Establish the monorepo and deterministic toolchain

**Files:**
- Create: `.node-version`
- Create: `.npmrc`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.json`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `eslint.config.mjs`
- Create: `.prettierignore`
- Create: `scripts/workspace-smoke.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: none.
- Produces: root commands `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and workspace package discovery under `apps/*`, `packages/*`, and `fixtures/*/*`.

- [ ] **Step 1: Write the failing workspace smoke test**

```js
// scripts/workspace-smoke.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workspace pins the production LTS toolchain", async () => {
  const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(root.packageManager, "pnpm@11.9.0");
  assert.equal(root.engines.node, ">=24.18.0 <27");
  assert.equal(root.private, true);
});
```

- [ ] **Step 2: Run the smoke test and verify it fails**

Run: `node --test scripts/workspace-smoke.test.mjs`

Expected: FAIL with `ENOENT` for `package.json` fields that do not yet exist.

- [ ] **Step 3: Create the pinned root configuration**

Use this root package contract:

```json
{
  "name": "codeatlas",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.9.0",
  "engines": { "node": ">=24.18.0 <27" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b --pretty false",
    "lint": "eslint .",
    "format:check": "prettier --check .",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "@types/node": "24.13.3",
    "eslint": "9.39.5",
    "prettier": "3.9.6",
    "tsx": "4.23.1",
    "typescript": "5.9.3",
    "typescript-eslint": "8.65.0",
    "vitest": "4.1.10"
  }
}
```

Set `.node-version` to `24.18.0`, `.npmrc` to `engine-strict=true`, and workspace globs to `apps/*`, `packages/*`, and `fixtures/*/*`. Node 24 is the production/CI runtime; the `<27` upper bound lets contributors run the current Node 26 release without weakening the production pin. Configure TypeScript with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `moduleResolution: NodeNext`, `target: ES2023`, declaration output, and an initially empty root `references` array that each later task extends. Configure Vitest to include `**/test/**/*.test.ts` and exclude fixture test files from the root suite. Configure `.prettierignore` to exclude `.superpowers/`, `.codeatlas/`, `docs/superpowers/`, `.next/`, `coverage/`, `dist/`, and `pnpm-lock.yaml`.

- [ ] **Step 4: Install and verify the toolchain**

Run: `corepack pnpm install`

Expected: a new `pnpm-lock.yaml` with no engine error under Node 24.18.x.

Run: `node --test scripts/workspace-smoke.test.mjs && pnpm format:check`

Expected: PASS.

- [ ] **Step 5: Commit the workspace foundation**

```bash
git add .node-version .npmrc .gitignore .prettierignore package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json tsconfig.base.json vitest.workspace.ts eslint.config.mjs scripts/workspace-smoke.test.mjs
git commit -m "build: establish CodeAtlas workspace"
```

### Task 2: Define evidence schemas and signed manifests

**Files:**
- Create: `packages/evidence/package.json`
- Create: `packages/evidence/tsconfig.json`
- Create: `packages/evidence/src/schema.ts`
- Create: `packages/evidence/src/manifest.ts`
- Create: `packages/evidence/src/index.ts`
- Create: `packages/evidence/test/schema.test.ts`
- Create: `packages/evidence/test/manifest.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: Node `crypto`; Zod 4.4.3; `json-canonicalize` 2.0.0.
- Produces: `EvidenceItem`, `GraphNode`, `GraphEdge`, `Finding`, `ProofCard`, `ChangePassport`, `EvidenceManifest`, `signManifest(manifest, privateKey)`, and `verifyManifest(signed, publicKey)`.

- [ ] **Step 1: Write failing schema tests**

```ts
import { describe, expect, it } from "vitest";
import { EvidenceItemSchema, GraphEdgeSchema } from "../src/index.js";

describe("evidence provenance", () => {
  it("rejects a source citation without an immutable snapshot", () => {
    const result = EvidenceItemSchema.safeParse({
      id: "ev_1",
      type: "RUNTIME_TRACE",
      origin: "runner@0.1.0",
      observedAt: "2026-07-29T00:00:00.000Z",
      reproducibility: "REPRODUCIBLE",
      source: { path: "src/auth.ts", startLine: 12, endLine: 14 },
      artifactDigest: "sha256:abc"
    });
    expect(result.success).toBe(false);
  });

  it("requires AI inference to remain explicitly typed", () => {
    const edge = GraphEdgeSchema.parse({
      id: "edge_1",
      from: "symbol:a",
      to: "symbol:b",
      relation: "MAY_CALL",
      evidenceType: "AI_INFERENCE",
      evidenceIds: ["ev_1"],
      snapshotSha: "a".repeat(40)
    });
    expect(edge.evidenceType).toBe("AI_INFERENCE");
  });
});
```

- [ ] **Step 2: Run the tests and verify missing exports**

Run: `pnpm vitest run packages/evidence/test/schema.test.ts`

Expected: FAIL because `EvidenceItemSchema` and `GraphEdgeSchema` do not exist.

- [ ] **Step 3: Implement the domain schemas**

Define exact enums:

```ts
export const EvidenceTypeSchema = z.enum([
  "STATIC_AST",
  "STATIC_DATAFLOW",
  "STATIC_CALLGRAPH",
  "FRAMEWORK_CONVENTION",
  "RUNTIME_TRACE",
  "LINE_COVERAGE",
  "TEST_ASSERTION",
  "CONTRACT_TEST",
  "DIFFERENTIAL_EXECUTION",
  "GIT_HISTORY",
  "CO_CHANGE_HISTORY",
  "DOCUMENTATION",
  "USER_DECLARATION",
  "AI_INFERENCE"
]);

export const GraphRelationSchema = z.enum([
  "CONTAINS",
  "DEFINES",
  "IMPORTS",
  "EXPORTS",
  "CALLS",
  "MAY_CALL",
  "TESTS",
  "COVERS",
  "AFFECTS",
  "OBSERVED_IN",
  "COMPARES_TO"
]);

export const FindingStateSchema = z.enum([
  "CONFIRMED_REGRESSION",
  "CONFIRMED_CHANGE",
  "PROBABLE_IMPACT",
  "POSSIBLE_IMPACT",
  "UNVERIFIED",
  "RESOLVED",
  "ACCEPTED_CHANGE"
]);

export const SourceLocationSchema = z.object({
  snapshotSha: z.string().regex(/^[0-9a-f]{40}$/),
  path: z.string().min(1).refine((value) => !value.startsWith("/") && !value.includes("..")),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive()
}).refine((value) => value.endLine >= value.startLine);
```

Build all exported schemas from these primitives. `ProofCardSchema` must require base behavior, head behavior, evidence ids, affected journey, reproduction command, recommended action, and limitations. `ChangePassportSchema` must require base/head SHAs, engine version, findings, executed tests, unverified areas, retention policy, and manifest digest. `EvidenceManifest.analysisId` is the deterministic idempotency id derived from repository provider, base/head digests, configuration digest, and engine version; per-attempt ids are never included in the signed canonical manifest.

- [ ] **Step 4: Write failing manifest signature tests**

```ts
import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { signManifest, verifyManifest } from "../src/index.js";

it("detects a modified signed manifest", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = signManifest({
    schemaVersion: "1.0",
    repository: { provider: "local", baseSha: "a".repeat(40), headSha: "b".repeat(40) },
    analysisId: "analysis_1",
    engineVersion: "0.1.0",
    evidence: []
  }, privateKey);
  expect(verifyManifest(signed, publicKey)).toBe(true);
  signed.manifest.engineVersion = "tampered";
  expect(verifyManifest(signed, publicKey)).toBe(false);
});
```

- [ ] **Step 5: Implement canonical Ed25519 signing**

`signManifest` canonicalizes the validated manifest, hashes it with SHA-256, signs the canonical bytes using Ed25519, and returns `{ manifest, digest, signature }` using base64url for the signature. `verifyManifest` revalidates the schema, recomputes the digest, then verifies the signature with `timingSafeEqual` for digest comparison and `crypto.verify` for the signature.

- [ ] **Step 6: Run package verification**

Run: `pnpm vitest run packages/evidence/test && pnpm typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 7: Commit the evidence model**

```bash
git add package.json pnpm-lock.yaml tsconfig.json packages/evidence
git commit -m "feat: define the evidence model"
```

### Task 3: Create the seeded authentication regression fixture

**Files:**
- Create: `fixtures/auth-regression/base/package.json`
- Create: `fixtures/auth-regression/base/src/auth.ts`
- Create: `fixtures/auth-regression/base/test/auth.test.ts`
- Create: `fixtures/auth-regression/head/package.json`
- Create: `fixtures/auth-regression/head/src/auth.ts`
- Create: `fixtures/auth-regression/head/test/auth.test.ts`
- Create: `fixtures/auth-regression/README.md`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Vitest 4.1.10 from the workspace.
- Produces: two immutable fixture directory snapshots; both pass the existing valid-session test, while an expired non-refreshable token returns 401 on base and 500 on head. Task 4 derives stable content-addressed snapshot digests from these directories.

- [ ] **Step 1: Write the existing test in both snapshots**

```ts
import { describe, expect, it } from "vitest";
import { restoreSession } from "../src/auth.js";

describe("restoreSession", () => {
  it("restores a valid session", () => {
    expect(restoreSession({ subject: "usr_1", expiresAt: 200, refreshable: true }, 100)).toEqual({
      status: 200,
      body: { userId: "USR_1" }
    });
  });
});
```

The base manifest is:

```json
{
  "name": "@codeatlas/fixture-auth-base",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run" },
  "devDependencies": { "vitest": "4.1.10" }
}
```

The head manifest is identical except its name is `@codeatlas/fixture-auth-head`.

- [ ] **Step 2: Add the safe base implementation**

```ts
export interface Token {
  subject: string | null;
  expiresAt: number;
  refreshable: boolean;
}

export type SessionResponse =
  | { status: 200; body: { userId: string } }
  | { status: 401; body: { code: "SESSION_EXPIRED" } }
  | { status: 500; body: { code: "INTERNAL_ERROR" } };

class SessionExpiredError extends Error {}

export function validateToken(token: Token, now: number): string {
  if (token.expiresAt <= now) throw new SessionExpiredError("expired");
  if (token.subject === null) throw new TypeError("missing subject");
  return token.subject.toUpperCase();
}

export function restoreSession(token: Token, now: number): SessionResponse {
  try {
    return { status: 200, body: { userId: validateToken(token, now) } };
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      return { status: 401, body: { code: "SESSION_EXPIRED" } };
    }
    return { status: 500, body: { code: "INTERNAL_ERROR" } };
  }
}
```

- [ ] **Step 3: Add the regressed head implementation**

The head file is identical except `validateToken` is exactly:

```ts
export function validateToken(token: Token, now: number): string {
  if (token.expiresAt <= now && token.refreshable) {
    throw new SessionExpiredError("expired");
  }
  return token.subject!.toUpperCase();
}
```

- [ ] **Step 4: Verify the existing suite passes on both revisions**

Run: `pnpm --dir fixtures/auth-regression/base test && pnpm --dir fixtures/auth-regression/head test`

Expected: both commands PASS one existing test. This proves the regression is not exposed by the repository suite.

- [ ] **Step 5: Commit the fixture**

```bash
git add fixtures/auth-regression pnpm-lock.yaml
git commit -m "test: add authentication regression fixture"
```

### Task 4: Map snapshots and changed lines to symbols

**Files:**
- Create: `packages/analyzer/package.json`
- Create: `packages/analyzer/tsconfig.json`
- Create: `packages/analyzer/src/types.ts`
- Create: `packages/analyzer/src/snapshot-digest.ts`
- Create: `packages/analyzer/src/analyze-snapshot.ts`
- Create: `packages/analyzer/src/changed-lines.ts`
- Create: `packages/analyzer/src/index.ts`
- Create: `packages/analyzer/test/analyze-snapshot.test.ts`
- Create: `packages/analyzer/test/changed-lines.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: graph and source-location schemas from `@codeatlas/evidence`; TypeScript compiler API 5.9.3; `diff` 9.0.0; `fast-glob` 3.3.3.
- Produces: analyzer-owned `SnapshotAnalysis` and `AnalyzedEdge` types, `computeSnapshotDigest(root: string): Promise<string>`, `analyzeSnapshot(input: { root: string; snapshotSha: string }): Promise<SnapshotAnalysis>`, and `mapChangedSymbols(base, head): ChangedSymbol[]`.

- [ ] **Step 1: Write failing analyzer expectations**

```ts
import { expect, it } from "vitest";
import { analyzeSnapshot, mapChangedSymbols } from "../src/index.js";

it("maps the authentication change to validateToken and its dependant", async () => {
  const base = await analyzeSnapshot({
    root: "fixtures/auth-regression/base",
    snapshotSha: "a".repeat(40)
  });
  const head = await analyzeSnapshot({
    root: "fixtures/auth-regression/head",
    snapshotSha: "b".repeat(40)
  });
  const changed = mapChangedSymbols(base, head);
  expect(changed.map((item) => item.name)).toEqual(["validateToken"]);
  expect(head.edges).toContainEqual(expect.objectContaining({ relation: "CALLS", fromName: "restoreSession", toName: "validateToken" }));
  expect(head.tests[0]?.path).toBe("test/auth.test.ts");
});
```

Add a second test that calls `computeSnapshotDigest` twice for base and once for head. Assert both base calls return the same 40-character lowercase hex digest and the head digest differs.

- [ ] **Step 2: Run and verify the missing analyzer failure**

Run: `pnpm vitest run packages/analyzer/test/analyze-snapshot.test.ts`

Expected: FAIL because `analyzeSnapshot` is not exported.

- [ ] **Step 3: Implement safe snapshot traversal**

Resolve the provided root once with `realpath`, enumerate only `.ts`, `.tsx`, `.js`, and `.jsx` files beneath it, reject symlinks that resolve outside the root, and ignore `node_modules`, build output, and coverage. Create a TypeScript `Program`, then traverse `SourceFile` nodes to emit:

- files with SHA-256 content digests;
- exported functions, classes, methods, and interfaces with start/end lines;
- import/export edges;
- direct call edges resolved to symbols when possible;
- test definitions from `*.test.*` and `*.spec.*` files;
- function signatures as static contracts;
- branch locations for `if`, conditional, switch, and catch nodes.

Build stable ids using `sha256(snapshotSha + ":" + path + ":" + kind + ":" + qualifiedName)`. Never execute or import repository modules.

`computeSnapshotDigest` enumerates every non-ignored regular file in sorted repository-relative order, hashes each relative path plus its SHA-256 content digest into a canonical byte sequence, and returns the first 40 lowercase hex characters of the final SHA-256 digest. The local provider labels this as a content snapshot digest rather than a Git commit SHA.

Define `AnalyzedEdge` with exact fields `id`, `from`, `to`, `fromName`, `toName`, `relation`, `evidenceIds`, `evidenceType`, and `snapshotSha`. Define `ChangedSymbol` as `{ id, name, path, baseLocation, headLocation, changedLines, signatureChanged }`. Define `SnapshotAnalysis` with `snapshotSha`, `files`, `symbols`, `edges`, `tests`, `contracts`, `branches`, and `evidence`. These exported types are the inputs used by Tasks 5, 7, and 9.

- [ ] **Step 4: Implement line-diff mapping**

Use `diffLines(baseText, headText)` to track old and new line cursors. Record added/removed line spans, then intersect each span with symbol source ranges. A symbol is changed when its body intersects a changed span or its signature digest differs. Sort changed symbols by path and start line for deterministic output.

- [ ] **Step 5: Verify citations and change mapping**

Run: `pnpm vitest run packages/analyzer/test && pnpm typecheck`

Expected: PASS; every emitted source location contains the correct fixture SHA and a repository-relative path.

- [ ] **Step 6: Commit the analyzer**

```bash
git add package.json pnpm-lock.yaml tsconfig.json packages/analyzer
git commit -m "feat: map TypeScript snapshots and changes"
```

### Task 5: Select relevant tests with inspectable reasons

**Files:**
- Create: `packages/selector/package.json`
- Create: `packages/selector/tsconfig.json`
- Create: `packages/selector/src/select-tests.ts`
- Create: `packages/selector/src/index.ts`
- Create: `packages/selector/test/select-tests.test.ts`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: `SnapshotAnalysis`, `ChangedSymbol[]`, and graph edges.
- Produces: `selectTests(input: TestSelectionInput): TestSelection[]`, where each result has `testId`, `path`, `reasons`, and `evidenceIds`.

- [ ] **Step 1: Write the failing selection test**

```ts
import { expect, it } from "vitest";
import { selectTests } from "../src/index.js";

it("selects the auth test through the changed symbol call path", () => {
  const selections = selectTests({
    changedSymbolIds: ["symbol:validateToken"],
    tests: [{ id: "test:auth", path: "test/auth.test.ts", importedFileIds: ["file:auth"] }],
    edges: [
      { from: "symbol:restoreSession", to: "symbol:validateToken", relation: "CALLS", evidenceIds: ["ev:call"] },
      { from: "test:auth", to: "symbol:restoreSession", relation: "TESTS", evidenceIds: ["ev:test"] }
    ]
  });
  expect(selections[0]).toEqual({
    testId: "test:auth",
    path: "test/auth.test.ts",
    reasons: ["Calls restoreSession(), which reaches changed validateToken()."],
    evidenceIds: ["ev:test", "ev:call"]
  });
});
```

- [ ] **Step 2: Run and verify the missing selector failure**

Run: `pnpm vitest run packages/selector/test/select-tests.test.ts`

Expected: FAIL because `selectTests` does not exist.

- [ ] **Step 3: Implement deterministic reverse reachability**

Create a reverse adjacency map for `CALLS`, `IMPORTS`, and `TESTS`. Starting from each changed symbol, walk at most eight edges and stop cycles using the shortest visited distance. Select a test when the walk reaches a test node. Reasons use the shortest resolved path and exact symbol names. Deduplicate evidence ids and sort selections by path.

- [ ] **Step 4: Verify selection and exclusion behavior**

Add a second unrelated test and assert it is excluded with an inspectable `NO_REACHABLE_CHANGED_SYMBOL` explanation returned by `explainExclusion(testId, input)`.

Run: `pnpm vitest run packages/selector/test && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the selector**

```bash
git add packages/selector tsconfig.json
git commit -m "feat: select tests from change impact"
```

### Task 6: Execute selected Vitest tests with bounded local isolation

**Files:**
- Create: `packages/runner/package.json`
- Create: `packages/runner/tsconfig.json`
- Create: `packages/runner/src/execution-provider.ts`
- Create: `packages/runner/src/local-execution-provider.ts`
- Create: `packages/runner/src/vitest-result.ts`
- Create: `packages/runner/src/index.ts`
- Create: `packages/runner/test/local-execution-provider.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: selected test paths, snapshot root/SHA, optional generated test files, and a resource policy.
- Produces: `ExecutionProvider.run(request: ExecutionRequest): Promise<ExecutionResult>` with test cases, exit code, duration, sanitized stdout/stderr, coverage locations, environment digest, and terminal state.

- [ ] **Step 1: Define the provider contract and failing test**

```ts
export interface ExecutionRequest {
  analysisId: string;
  revision: "base" | "head";
  snapshotRoot: string;
  snapshotSha: string;
  testPaths: string[];
  generatedFiles: Array<{
    path: string;
    content: string;
    objectiveId: string;
    evidenceIds: string[];
    expectedBehavior: { httpStatus: number; code: string };
  }>;
  policy: { timeoutMs: number; maxOutputBytes: number; maxFiles: number };
}

export interface ExecutionResult {
  revision: "base" | "head";
  snapshotSha: string;
  terminalState: "COMPLETED" | "TIMED_OUT" | "OUTPUT_LIMIT" | "FAILED";
  exitCode: number | null;
  durationMs: number;
  testCases: Array<{
    name: string;
    path: string;
    status: "PASSED" | "FAILED" | "SKIPPED";
    failureMessage: string | null;
    generatedObjectiveId: string | null;
  }>;
  coverage: Array<{ path: string; coveredLines: number[] }>;
  observations: Array<{
    testName: string;
    source: "TEST_ASSERTION";
    expected: { httpStatus: number; code: string };
    actual: { httpStatus: number; code: string };
  }>;
  stdout: string;
  stderr: string;
  environmentDigest: string;
}

export interface ExecutionProvider {
  run(request: ExecutionRequest): Promise<ExecutionResult>;
}
```

The first test runs `test/auth.test.ts` against both fixture roots and expects `terminalState: "COMPLETED"`, one passing case, different snapshot SHAs, and output shorter than the configured cap.

- [ ] **Step 2: Run and verify the missing implementation failure**

Run: `pnpm vitest run packages/runner/test/local-execution-provider.test.ts`

Expected: FAIL because `LocalExecutionProvider` does not exist.

- [ ] **Step 3: Implement the local provider without shell interpolation**

For each request:

1. Resolve and validate the snapshot root.
2. Create a temporary directory with `mkdtemp`.
3. Copy the snapshot without following external symlinks.
4. Reject more files than `maxFiles`.
5. Write generated files only after validating relative paths.
6. Link the workspace `node_modules` into the temporary root for this local milestone.
7. Invoke the absolute pnpm executable through Execa using an argument array:

```ts
await execa(pnpmPath, [
  "exec",
  "vitest",
  "run",
  ...request.testPaths,
  ...request.generatedFiles.map((file) => file.path),
  "--reporter=json",
  `--outputFile=${resultPath}`,
  "--coverage.enabled",
  "--coverage.provider=v8",
  "--coverage.reporter=json"
], {
  cwd: temporaryRoot,
  timeout: request.policy.timeoutMs,
  maxBuffer: request.policy.maxOutputBytes,
  reject: false,
  extendEnv: false,
  env: {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "test",
    CI: "1",
    NPM_CONFIG_CACHE: temporaryCache,
    XDG_CACHE_HOME: temporaryCache
  }
});
```

Always delete the temporary directory in `finally`. Redact absolute workspace paths and environment-shaped secrets from returned logs. Hash Node version, pnpm version, lockfile digest, and runner version into `environmentDigest`. For generated tests, use the declared expected behavior when the assertion passes. When it fails, parse Vitest's serialized `toBe` and `toEqual` assertion values for the status and code; if either value cannot be parsed, omit the observation and force the later finding to `UNVERIFIED`.

- [ ] **Step 4: Add timeout and output-cap tests**

Use synthetic fixture tests to exceed 50 ms and 1 KiB. Assert terminal states `TIMED_OUT` and `OUTPUT_LIMIT`, no retry, sanitized output, and temporary-directory cleanup.

- [ ] **Step 5: Run runner verification**

Run: `pnpm vitest run packages/runner/test && pnpm typecheck`

Expected: PASS; fixture existing tests pass on both revisions.

- [ ] **Step 6: Commit the execution provider**

```bash
git add package.json pnpm-lock.yaml tsconfig.json packages/runner
git commit -m "feat: execute bounded local test runs"
```

### Task 7: Derive and generate the uncovered expired-token test

**Files:**
- Create: `packages/generator/package.json`
- Create: `packages/generator/tsconfig.json`
- Create: `packages/generator/src/derive-objectives.ts`
- Create: `packages/generator/src/template-generator.ts`
- Create: `packages/generator/src/index.ts`
- Create: `packages/generator/test/generator.test.ts`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: changed symbol locations, branch locations, base coverage, public function contracts, and selected-test evidence.
- Produces: `deriveTestObjectives(input): TestObjective[]` and `TestGenerator.generate(objective): Promise<GeneratedTest>`.

- [ ] **Step 1: Write the failing objective test**

```ts
import { expect, it } from "vitest";
import { deriveTestObjectives } from "../src/index.js";

it("targets the uncovered changed expiration branch", () => {
  const objectives = deriveTestObjectives({
    changedSymbols: [{ id: "symbol:validateToken", name: "validateToken", path: "src/auth.ts", changedLines: [17, 18, 19] }],
    branches: [{ symbolId: "symbol:validateToken", line: 17, kind: "IF" }],
    coveredLines: [18, 22, 27],
    publicEntryPoints: [{ name: "restoreSession", path: "src/auth.ts" }]
  });
  expect(objectives).toEqual([expect.objectContaining({
    category: "REGRESSION_TEST",
    targetSymbol: "validateToken",
    entryPoint: "restoreSession",
    reason: "Changed expiration branch at src/auth.ts:17 has no mapped runtime coverage."
  })]);
});
```

- [ ] **Step 2: Run and verify the missing generator failure**

Run: `pnpm vitest run packages/generator/test/generator.test.ts`

Expected: FAIL because `deriveTestObjectives` is missing.

- [ ] **Step 3: Implement deterministic objective derivation**

Intersect changed lines with branch locations, subtract covered lines, and create one objective per uncovered changed branch. Objectives contain evidence ids and source locations; generator output cannot alter the objective or evidence list.

- [ ] **Step 4: Implement the narrow template generator**

Define the generator contract:

```ts
export interface TestGenerator {
  generate(objective: TestObjective): Promise<
    | { state: "GENERATED"; test: GeneratedTest }
    | { state: "UNSUPPORTED_OBJECTIVE"; objectiveId: string; reason: string }
  >;
}

export interface GeneratedTest {
  path: string;
  content: string;
  objectiveId: string;
  evidenceIds: string[];
  expectedBehavior: { httpStatus: 401; code: "SESSION_EXPIRED" };
  generated: true;
  executed: false;
}
```

For an objective targeting `validateToken` through `restoreSession`, emit exactly:

```ts
import { describe, expect, it } from "vitest";
import { restoreSession } from "../src/auth.js";

describe("generated: expired session regression", () => {
  it("returns SESSION_EXPIRED for a non-refreshable expired token", () => {
    const response = restoreSession({ subject: null, expiresAt: 50, refreshable: false }, 100);
    expect(response.status).toBe(401);
    expect("code" in response.body ? response.body.code : null).toBe("SESSION_EXPIRED");
  });
});
```

Return metadata `{ generated: true, executed: false, path: "test/codeatlas.expired-session.test.ts", objectiveId, evidenceIds, expectedBehavior: { httpStatus: 401, code: "SESSION_EXPIRED" } }`. For unsupported objective shapes, return a typed `UNSUPPORTED_OBJECTIVE` result rather than speculative code.

- [ ] **Step 5: Execute the generated test on both revisions**

Use `LocalExecutionProvider` in the package test. Assert compilation and PASS on base, FAIL on head, head actual status 500, and that both execution results retain the generated label and objective id.

Run: `pnpm vitest run packages/generator/test && pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit objective generation**

```bash
git add packages/generator tsconfig.json
git commit -m "feat: generate evidence-targeted regression tests"
```

### Task 8: Compare behavior and build the Proof Card

**Files:**
- Create: `packages/differential/package.json`
- Create: `packages/differential/tsconfig.json`
- Create: `packages/differential/src/compare-runs.ts`
- Create: `packages/differential/src/index.ts`
- Create: `packages/differential/test/compare-runs.test.ts`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: base/head `ExecutionResult`, test objectives, changed symbols, graph paths, and evidence items.
- Produces: `compareRuns(input: ComparisonInput): Finding[]` with evidence eligibility and qualitative confidence factors.

- [ ] **Step 1: Write the failing differential test**

```ts
import { expect, it } from "vitest";
import { compareRuns } from "../src/index.js";

it("confirms the repeatable 401 to 500 regression", () => {
  const makeExpiredSessionComparison = (input: { baseStatus: number; headStatus: number; repeatCount: number }) => ({
    findingId: "finding_expired_session",
    baseStatus: input.baseStatus,
    headStatus: input.headStatus,
    repeatCount: input.repeatCount,
    baseCode: "SESSION_EXPIRED",
    headCode: "INTERNAL_ERROR",
    environmentDigestsMatch: true,
    compiled: true,
    evidenceCurrent: true
  });
  const findings = compareRuns(makeExpiredSessionComparison({ baseStatus: 401, headStatus: 500, repeatCount: 3 }));
  expect(findings).toEqual([expect.objectContaining({
    state: "CONFIRMED_REGRESSION",
    title: "Expired sessions return an internal error",
    baseBehavior: "HTTP 401 with SESSION_EXPIRED",
    headBehavior: "HTTP 500 with INTERNAL_ERROR",
    confidence: { level: "HIGH", factors: expect.arrayContaining(["DIFFERENTIAL_EXECUTION", "REPEATABLE_3_OF_3"]) }
  })]);
});
```

- [ ] **Step 2: Run and verify the missing comparison failure**

Run: `pnpm vitest run packages/differential/test/compare-runs.test.ts`

Expected: FAIL because `compareRuns` does not exist.

- [ ] **Step 3: Implement evidence eligibility rules**

Create a confirmed regression only when:

- the generated or existing test compiled;
- base and head ran in matching environment digests;
- the base assertion passed;
- the head assertion failed with a parsed behavioral difference;
- the result repeated at least twice without contradiction;
- every evidence item has a current snapshot and artifact digest.

Otherwise return `CONFIRMED_CHANGE`, `PROBABLE_IMPACT`, or `UNVERIFIED` with a limitation explaining the failed eligibility rule. Calculate qualitative confidence from factors; never accept a model-provided percentage.

- [ ] **Step 4: Build the exact Proof Card fields**

Map the fixture finding to journey `Returning user → Restore session → Validate expired token`, graph path `restoreSession → validateToken`, reproduction command `codeatlas replay <finding-id>`, recommended action `Restore the unconditional expiration guard or accept the changed behavior with a contract update`, and an empty limitations array only when every confirmation gate passes.

- [ ] **Step 5: Verify partial and mismatch cases**

Add tests for environment mismatch, head timeout, one flaky repeat, and unexecuted generated test. Expected state for each is `UNVERIFIED`, never `CONFIRMED_REGRESSION`.

Run: `pnpm vitest run packages/differential/test && pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit differential findings**

```bash
git add packages/differential tsconfig.json
git commit -m "feat: compare base and head behavior"
```

### Task 9: Assemble the Passport and end-to-end analysis pipeline

**Files:**
- Create: `packages/passport/package.json`
- Create: `packages/passport/tsconfig.json`
- Create: `packages/passport/src/build-passport.ts`
- Create: `packages/passport/src/index.ts`
- Create: `packages/passport/test/build-passport.test.ts`
- Create: `packages/pipeline/package.json`
- Create: `packages/pipeline/tsconfig.json`
- Create: `packages/pipeline/src/analyze-comparison.ts`
- Create: `packages/pipeline/src/local-artifact-store.ts`
- Create: `packages/pipeline/src/index.ts`
- Create: `packages/pipeline/test/analyze-comparison.test.ts`
- Modify: `.gitignore`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: all prior package interfaces plus an `ArtifactStore` and signing key.
- Produces: `analyzeComparison(request: AnalyzeComparisonRequest): Promise<AnalysisOutput>` containing graph, selections, runs, generated tests, findings, signed Passport, manifest, and reproduction bundle.

Use these infrastructure-neutral boundaries:

```ts
export interface ArtifactStore {
  putJson(kind: string, value: unknown): Promise<{ digest: string; path: string }>;
  readJson<T>(path: string): Promise<T>;
}

export interface AnalyzeComparisonRequest {
  baseRoot: string;
  headRoot: string;
  engineVersion: string;
  configurationDigest: string;
  executionProvider: ExecutionProvider;
  artifactStore: ArtifactStore;
  testGenerator: TestGenerator;
  clock: { now(): Date };
  signingKey: KeyObject;
}

export interface AnalysisOutput {
  analysisId: string;
  attemptId: string;
  changedSymbols: ChangedSymbol[];
  selections: TestSelection[];
  runs: ExecutionResult[];
  generatedTests: Array<GeneratedTest & { executedOnBase: boolean; executedOnHead: boolean }>;
  findings: Finding[];
  passport: ChangePassport;
  signedManifest: SignedEvidenceManifest;
  publicKey: KeyObject;
  reproductionBundle: ReproductionBundle;
}
```

- [ ] **Step 1: Write the failing Passport test**

Assert a Passport cannot be built without base/head SHAs, engine version, executed-test counts, unverified areas, retention policy, and a manifest digest. Assert the fixture Passport state is `ACTION_REQUIRED`, contains one confirmed regression, one generated test executed on both revisions, and exact replay command.

- [ ] **Step 2: Implement Passport assembly**

`buildPassport` derives summary counts from validated findings and runs. It never accepts caller-provided summary totals. Sort files, symbols, tests, findings, and evidence ids deterministically. Export JSON and Markdown from the same validated object.

- [ ] **Step 3: Write the failing pipeline test**

```ts
it("runs the complete authentication proof workflow", async () => {
  const output = await analyzeComparison(fixtureRequest());
  expect(output.changedSymbols.map((symbol) => symbol.name)).toEqual(["validateToken"]);
  expect(output.selections[0]?.path).toBe("test/auth.test.ts");
  expect(output.generatedTests[0]).toEqual(expect.objectContaining({ executedOnBase: true, executedOnHead: true }));
  expect(output.passport.overallState).toBe("ACTION_REQUIRED");
  expect(output.findings[0]?.state).toBe("CONFIRMED_REGRESSION");
  expect(verifyManifest(output.signedManifest, output.publicKey)).toBe(true);
});
```

- [ ] **Step 4: Implement the orchestration sequence**

Compute content snapshot digests, run analyzer on base/head, map changes, select existing tests, execute selected tests once for coverage, derive and generate objectives, execute the combined existing/generated set three times on both revisions, compare results, store content-addressed artifacts, build the Passport and manifest, then write a reproduction bundle. Derive the canonical analysis id from provider `local`, both snapshot digests, configuration digest, and engine version. The local artifact path is `.codeatlas/runs/<analysis-id>/` and writes use a temporary file plus atomic rename. Add `.codeatlas/` to `.gitignore` before the first pipeline test writes artifacts.

`AnalyzeComparisonRequest` accepts `executionProvider`, `artifactStore`, `testGenerator`, `clock`, and `signingKey` dependencies so tests remain deterministic and the later GKE provider can replace local execution.

- [ ] **Step 5: Verify deterministic reruns**

Run the pipeline twice with the same inputs and fixed clock. Assert identical manifest digests and different analysis attempt ids only outside the canonical manifest.

Run: `pnpm vitest run packages/passport/test packages/pipeline/test && pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the Passport pipeline**

```bash
git add .gitignore packages/passport packages/pipeline tsconfig.json
git commit -m "feat: build signed Change Passports"
```

### Task 10: Provide the analyze and replay CLI

**Files:**
- Create: `apps/cli/package.json`
- Create: `apps/cli/tsconfig.json`
- Create: `apps/cli/src/index.ts`
- Create: `apps/cli/src/commands/analyze.ts`
- Create: `apps/cli/src/commands/replay.ts`
- Create: `apps/cli/test/cli.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: `analyzeComparison`, signed manifests, reproduction bundles, and local execution provider.
- Produces: executable `codeatlas`, `codeatlas analyze --base <path> --head <path> --out <path>`, and `codeatlas replay <bundle-path>`.

- [ ] **Step 1: Write a failing CLI analyze test**

Invoke the CLI through Execa with the two fixture paths and a temporary output directory. Expect exit code `2` for `ACTION_REQUIRED`, stdout containing `Expired sessions return an internal error`, and files `passport.json`, `passport.md`, `evidence-manifest.json`, `evidence-manifest.sig`, and `reproduction-bundle.json`.

- [ ] **Step 2: Implement validated CLI arguments and exit codes**

Use Commander 15.0.0. Resolve paths, reject nonexistent or identical base/head roots, reject output paths inside either snapshot, and use no shell. Exit codes are `0 VERIFIED`, `2 ACTION_REQUIRED`, `3 PARTIAL`, `4 ANALYSIS_FAILED`, and `5 SECURITY_POLICY`. Human output and `--json` output derive from the same result.

- [ ] **Step 3: Write the failing replay test**

Replay the generated fixture bundle. Expect signature verification before execution, then exact final line `REPRODUCED finding_expired_session`. Modify one artifact digest and expect exit code `5` with `Bundle integrity verification failed`; no test process may start.

- [ ] **Step 4: Implement local replay**

Validate bundle schema, verify manifest signature/digests, confirm fixture base/head paths remain within the explicitly supplied workspace root, rerun the recorded generated test under the recorded runner policy, compare sanitized results, and print one of `REPRODUCED`, `NOT_REPRODUCED`, or `ENVIRONMENT_MISMATCH`.

This local-fixture source adapter is intentionally replaced by GitHub SHA fetching in the later GitHub production plan; the integrity and execution sequence stay unchanged.

- [ ] **Step 5: Verify CLI behavior**

Run: `pnpm vitest run apps/cli/test && pnpm typecheck`

Expected: PASS.

Run manually:

```bash
pnpm --filter @codeatlas/cli codeatlas analyze \
  --base fixtures/auth-regression/base \
  --head fixtures/auth-regression/head \
  --out .codeatlas/demo
pnpm --filter @codeatlas/cli codeatlas replay .codeatlas/demo/reproduction-bundle.json
```

Expected: first command reports `ACTION_REQUIRED`; second ends with `REPRODUCED finding_expired_session`.

- [ ] **Step 6: Commit the CLI**

```bash
git add apps/cli package.json tsconfig.json
git commit -m "feat: add CodeAtlas analyze and replay CLI"
```

### Task 11: Render the real Passport in the Forensic Cartography workspace

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/app/globals.css`
- Create: `apps/web/src/app/api/demo/route.ts`
- Create: `apps/web/src/app/demo/pr/284/page.tsx`
- Create: `apps/web/src/components/evidence-map.tsx`
- Create: `apps/web/src/components/proof-card.tsx`
- Create: `apps/web/src/components/passport-bar.tsx`
- Create: `apps/web/src/components/workspace-nav.tsx`
- Create: `apps/web/src/lib/demo-store.ts`
- Create: `apps/web/test/workspace.test.tsx`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: `AnalysisOutput` from `@codeatlas/pipeline`; `ProofCard` and `ChangePassport` from `@codeatlas/evidence`.
- Produces: local demo route `POST /api/demo`, repository-state landing page, and real-data workspace `/demo/pr/284`.

- [ ] **Step 1: Write failing component hierarchy tests**

Render the workspace with the real pipeline fixture output. Assert accessible text `Action required`, `Authentication impact`, `Expired sessions return an internal error`, `HTTP 401 with SESSION_EXPIRED`, `HTTP 500 with INTERNAL_ERROR`, and `codeatlas replay`. Assert a `View impact as list` control exposes the same nodes and evidence states without SVG.

- [ ] **Step 2: Create the visual token system**

Define CSS custom properties for every approved color, self-hosted font declarations for Familjen Grotesk, IBM Plex Sans, and IBM Plex Mono, spacing in a 4 px scale, 6–10 px radii, and focus outlines using Route Cobalt plus a 2 px offset. Do not use gradients, backdrop filters, or global animation.

- [ ] **Step 3: Build the product surfaces**

The landing page begins with current repository verification state, not a generic dashboard. The workspace uses:

- a 148 px navigation rail;
- a Passport status bar derived from actual counts;
- a central Atlas Ink map canvas;
- contour bands representing dependency distance;
- solid Observed Teal runtime edges and dotted Contour Slate inferred edges;
- Route Cobalt changed nodes and Fault Red failing nodes;
- a 320 px Proof Card drawer with exact evidence and replay command.

Use a custom accessible SVG rather than a stock graph theme. Nodes are buttons with `aria-label` including entity, evidence state, and affected path. The list alternative is always available.

- [ ] **Step 4: Connect the real demo analysis**

`POST /api/demo` is enabled only when `CODEATLAS_DEMO_MODE=true`. It starts `analyzeComparison` using the fixture paths, stores the terminal `AnalysisOutput` in a process-local demo store, and returns the analysis id. The client navigates to `/demo/pr/284`; the page reads the stored output and never imports a hard-coded Passport. If no analysis exists, show a `Run verified demo` action rather than fabricated results.

- [ ] **Step 5: Add purposeful and reduced motion**

On first result display, changed nodes appear, dependency edges reveal, runtime edges become solid, and the Proof Card opens. Total duration is under 900 ms, runs once, and is disabled by `prefers-reduced-motion`. No element loops.

- [ ] **Step 6: Verify UI tests and production build**

Run: `pnpm vitest run apps/web/test && pnpm --filter @codeatlas/web build`

Expected: PASS and a successful Next.js 15.2.9 build under Node 24.

- [ ] **Step 7: Commit the workspace**

```bash
git add apps/web package.json pnpm-lock.yaml tsconfig.json
git commit -m "feat: render the CodeAtlas evidence workspace"
```

### Task 12: Add full acceptance tests and contributor documentation

**Files:**
- Create: `playwright.config.ts`
- Create: `test/e2e/cli-replay.spec.ts`
- Create: `test/e2e/workspace.spec.ts`
- Create: `docs/architecture/evidence-core.md`
- Create: `docs/security/local-execution-boundary.md`
- Create: `docs/evidence-manifest-v1.md`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: complete local vertical slice.
- Produces: `pnpm verify`, reproducible contributor setup, manifest documentation, and an acceptance record for the next hosted plan.

- [ ] **Step 1: Write the failing CLI acceptance test**

The test runs analyze, asserts `ACTION_REQUIRED`, verifies the manifest signature through the public API, runs replay, and asserts `REPRODUCED finding_expired_session`. It also asserts generated-test metadata says why it was generated, compiled, passed on base, failed on head, and is suitable for permanent inclusion.

- [ ] **Step 2: Write the failing browser acceptance test**

```ts
import { expect, test } from "@playwright/test";

test("shows the complete authentication proof", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Run verified demo" }).click();
  await expect(page.getByText("Action required")).toBeVisible();
  await expect(page.getByText("Expired sessions return an internal error")).toBeVisible();
  await expect(page.getByText("HTTP 401 with SESSION_EXPIRED")).toBeVisible();
  await expect(page.getByText("HTTP 500 with INTERNAL_ERROR")).toBeVisible();
  await page.getByRole("button", { name: "View impact as list" }).click();
  await expect(page.getByRole("list", { name: "Affected code path" })).toContainText("validateToken");
});
```

- [ ] **Step 3: Add accessibility and tamper cases**

Run Axe on the landing and workspace pages with no serious or critical violations. Test keyboard navigation into the map/list and Proof Card. Tamper with the manifest and assert the UI refuses to render it as verified evidence.

- [ ] **Step 4: Document exact contributor workflows**

README commands are:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
CODEATLAS_DEMO_MODE=true pnpm --filter @codeatlas/web dev
```

Document the local boundary honestly: it isolates filesystem writes in a temporary directory and bounds processes, but it is not a security boundary for hostile repositories. Only the later GKE gVisor provider may be used for third-party hosted execution.

- [ ] **Step 5: Add the one-command verification script**

Set root `verify` to:

```json
"verify": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm --filter @codeatlas/web build"
```

Set `test:e2e` to start the web app in demo mode through Playwright's `webServer` configuration and run both acceptance files.

- [ ] **Step 6: Run final verification**

Run: `pnpm verify`

Expected: formatting, lint, types, unit/integration tests, CLI replay acceptance, browser accessibility, and production build all PASS.

- [ ] **Step 7: Inspect the result manually**

Start the web app, run the verification, inspect desktop at 1440 px and mobile at 390 px, enable reduced motion, use keyboard-only navigation, and run replay from the displayed command. Record any defect as a failing test before fixing it.

- [ ] **Step 8: Commit the verified vertical slice**

```bash
git add README.md package.json .gitignore playwright.config.ts test docs/architecture docs/security docs/evidence-manifest-v1.md
git commit -m "test: verify the CodeAtlas vertical slice"
```

## Completion criteria

This plan is complete only when:

- the repository is clean after `pnpm verify`;
- both fixture existing suites pass;
- the generated expired-token test passes on base and fails on head;
- the finding is `CONFIRMED_REGRESSION` using repeatable differential evidence;
- the Change Passport and Evidence Manifest validate against public schemas;
- manifest tampering is detected before replay or display;
- `codeatlas replay` prints `REPRODUCED finding_expired_session`;
- the workspace renders the pipeline result rather than hard-coded findings;
- observed and inferred edges are distinct in both map and list views;
- reduced motion and keyboard-only workflows pass;
- documentation states that local execution is not the hosted security boundary;
- no private-repository, Firebase, GitHub App, or GKE capability is falsely presented as complete before its later plan lands.

## Spec coverage review

- Product thesis, evidence semantics, confidence, and integrity are implemented by Tasks 2, 8, and 9.
- The seeded end-to-end proof workflow is implemented by Tasks 3 through 10 and accepted in Task 12.
- TypeScript/JavaScript static mapping, change mapping, test selection, execution, generated testing, comparison, Proof Cards, Passports, manifests, and replay are implemented by Tasks 4 through 10.
- The Forensic Cartography information hierarchy, visual tokens, evidence distinctions, responsive list alternative, motion restraint, and accessibility are implemented by Tasks 11 and 12.
- Local failure containment, path validation, process bounds, tamper handling, and truthful limitations are implemented by Tasks 2, 6, 8, 10, and 12.
- Firebase, Cloud SQL, Firestore, Cloud Storage, Tasks, Workflows, GKE gVisor, source brokering, GitHub public/private access, tenant row-level security, retention/deletion, production telemetry, and hosted adversarial isolation are intentionally not claimed by this milestone; they are assigned to delivery plans 2 through 5 above.
