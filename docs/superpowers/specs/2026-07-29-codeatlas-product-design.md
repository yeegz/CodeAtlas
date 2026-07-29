# CodeAtlas Product Design

**Date:** 2026-07-29

**Status:** Approved concept; awaiting written-spec review

**Product:** CodeAtlas

## Product thesis

CodeAtlas is the open-source verification layer for human- and AI-written code.
It builds an executable evidence model of a repository, compares observable
behavior between a base and proposed revision, and produces a reproducible
Change Passport before merge.

The product answers five questions:

1. What changed?
2. What could it affect?
3. What behavior was actually executed?
4. What changed between the base and proposed versions?
5. Can every conclusion be independently reproduced?

The product promise is deliberately narrow: CodeAtlas produces reproducible
evidence and distinguishes observed behavior from inference. It does not
guarantee that a change is safe or replace human review.

## Release objective

The first release is a hosted, end-to-end product that real users can install
and use. It is not a frontend simulation. A user can install the CodeAtlas
GitHub App, select a public or private TypeScript/JavaScript repository, analyze
a pull request, inspect evidence, export a Change Passport and Evidence
Manifest, replay a confirmed finding, and permanently delete repository data.

The release is successful when the seeded authentication demonstration works
from start to finish in under 90 seconds after dependencies are cached:

1. A small authentication change is identified.
2. Three indirectly affected login journeys are shown.
3. A response-contract difference is detected.
4. Relevant existing tests are selected and explained.
5. An uncovered expired-token branch is identified.
6. A targeted regression test is executed against base and head.
7. The test passes on base and fails on head.
8. The exact exception and affected path are shown.
9. A Proof Card and Change Passport are generated.
10. `codeatlas replay <finding-id>` reproduces the result.

## V1 scope

### Included

- Hosted multi-tenant web application.
- Firebase Authentication with GitHub sign-in.
- GitHub App installation for selected public and private repositories.
- TypeScript and JavaScript repositories.
- npm, pnpm, and Yarn lockfiles.
- Jest and Vitest test discovery and execution.
- Initial framework detectors for Express, Fastify, and Next.js route handlers.
- Base/head commit selection from pull requests or manual comparison.
- Static file, symbol, import, export, and call relationships.
- Changed-line-to-symbol mapping.
- Transparent relevant-test selection.
- Isolated base and head execution.
- Line-level runtime evidence for selected tests.
- Test outcome, exception, HTTP response, and execution-path comparison.
- Evidence-targeted candidate test generation for uncovered changed behavior.
  A generated test must compile, run on both revisions, state why it exists,
  and remain labelled as generated and executed or unexecuted.
- Function signature, package export, route, and JSON response-contract changes.
- Evidence Graph, Proof Cards, and Change Passport.
- JSON Evidence Manifest and Markdown Passport export.
- One-command CLI replay.
- User-controlled retention, cancellation, export, and deletion.

### Explicitly deferred

- General repository chat.
- Broad multi-language support.
- Billing and paid subscriptions.
- Mutation testing.
- Autonomous agent-fix loops.
- Multi-repository system twins.
- Production telemetry ingestion.
- Mobile applications.
- Architecture time machine.
- Large plugin marketplaces.

The architecture preserves extension points for these capabilities without
requiring them in the first release.

## User journey

### 1. Sign in and install

The user signs in with GitHub, creates or selects a CodeAtlas organization, and
installs the GitHub App on explicitly selected repositories. The interface shows
the exact requested GitHub permissions before the installation is completed.
Selecting all repositories is never the default.

### 2. Repository preflight

CodeAtlas detects the package manager, framework, tests, repository size,
base/head commits, and execution requirements without running repository code.
It shows expected resource limits and retention settings before verification.

### 3. Start verification

A pull-request event or manual comparison creates an analysis. The trusted
control plane prepares content-addressed source artifacts for the base and head
commits. Two equivalent, clean execution sandboxes are scheduled.

### 4. Watch evidence form

The interface streams durable stage transitions: mapping, test selection, base
execution, head execution, comparison, and Passport publication. Observed,
inferred, stale, and unknown evidence remain visually distinct.

### 5. Investigate impact

The user follows changed symbols through dependants, tests, routes, contracts,
and user journeys. Every relationship exposes its evidence type, source,
snapshot, freshness, confidence factors, and reproducibility state.

### 6. Review the Change Passport

The user reviews confirmed changes, regressions, probable impact, and unverified
paths. Intended changes can be accepted with an auditable reason. A user can
export JSON or Markdown and publish the result as a GitHub Check.

### 7. Replay or delete

The user copies a replay command, revises the pull request, cancels a running
analysis, or permanently deletes repository data. Deletion covers source
artifacts, evidence, snapshots, derived indexes, installation tokens, and
reproduction bundles governed by the repository retention policy.

## System architecture

CodeAtlas uses a Firebase product layer with a Google Cloud control and
execution plane.

### Product layer

- **Firebase App Hosting:** Next.js web application, CDN, server rendering,
  preview deployments, and the primary user experience.
- **Firebase Authentication:** GitHub sign-in and application sessions.
- **Firebase App Check:** abuse reduction for supported first-party clients.
- **GitHub App:** repository installation, pull-request events, commit metadata,
  and GitHub Checks.

### Trusted control plane

- **Cloud Run API:** authorization, repository registration, analysis creation,
  query endpoints, exports, and signed artifact access.
- **Cloud Tasks:** bounded asynchronous dispatch, rate control, deduplication,
  and retry scheduling.
- **Google Cloud Workflows:** durable orchestration of the multi-stage analysis
  and parallel base/head execution.
- **Trusted source broker:** exchanges short-lived GitHub installation tokens,
  downloads commit archives, validates size and digest, encrypts them, and
  issues one-use artifact access. Repository sandboxes never receive GitHub
  credentials.
- **Artifact Registry:** signed, digest-pinned analyzer and runner images.
- **Secret Manager and Cloud KMS:** application secrets and envelope encryption.

### Execution plane

- **GKE Autopilot:** managed scheduling and resource enforcement.
- **GKE Sandbox with gVisor:** every stage that reads or executes repository
  contents runs in an ephemeral Kubernetes Job whose Pod uses
  `runtimeClassName: gvisor`.
- **Base and head Jobs:** never share a sandbox. Static-mapping Jobs receive the
  same analyzer version and resource envelope; later execution Jobs receive the
  same runner image, dependency policy, resource envelope, and test-selection
  inputs.
- **Network egress proxy:** default-deny sandbox egress with explicit access to
  required package and source endpoints. The proxy logs destinations and never
  exposes platform credentials to the sandbox.
- **Result ingestor:** validates signed result envelopes, artifact hashes,
  schemas, size limits, and analysis ownership before accepting evidence.

### Data plane

- **Cloud SQL for PostgreSQL:** canonical tenant, repository, snapshot, graph,
  finding, Passport, and audit metadata. PostgreSQL row-level security adds a
  second tenant boundary beneath application authorization.
- **Firestore:** realtime, low-volume analysis progress documents consumed by
  the web application. Firestore is not the canonical Evidence Graph store.
- **Cloud Storage:** encrypted source archives, traces, logs, coverage, manifests,
  and reproduction bundles. Objects are addressed by digest and scoped by
  tenant/repository/analysis prefixes.
- **Cloud Logging and Monitoring:** sanitized operational logs, metrics, alerts,
  and audit events.

## Component boundaries

The codebase will be a TypeScript monorepo with small packages that expose
explicit interfaces:

| Component | Responsibility | Depends on |
| --- | --- | --- |
| `web` | Product UI, server rendering, authenticated navigation | API client, Firebase Auth |
| `api` | HTTP contracts, authorization, tenant scoping, query composition | application services |
| `github` | App installation, webhook verification, archive brokering, Checks | GitHub API, KMS, storage |
| `orchestrator` | State machine, idempotency, retries, cancellation | Tasks, Workflows, execution provider |
| `analyzer-static` | TypeScript AST, symbol, import/export, call and diff mapping | TypeScript compiler API |
| `test-selector` | Evidence-based test selection with explanations | graph and coverage interfaces |
| `test-generator` | Candidate tests derived from deterministic uncovered objectives | normalized evidence objectives, model adapter |
| `runner` | Controlled install, test execution, trace and coverage capture | sandbox-local tools only |
| `contract-engine` | Signature, route, export and response comparison | normalized snapshots |
| `differential-engine` | Base/head behavioral comparison and classification | execution results |
| `evidence-core` | Evidence types, provenance, confidence factors and manifests | no infrastructure |
| `passport` | Proof Card and Change Passport assembly and export | evidence-core |
| `execution-gke` | GKE Job creation, monitoring, cancellation and cleanup | Kubernetes API |
| `cli` | Authentication, replay, manifest verification and export | public API, local runner |
| `fixture-auth` | Seeded demonstration repository and known regression | test-only dependencies |

Infrastructure providers remain behind interfaces. In particular,
`ExecutionProvider`, `ArtifactStore`, `ProgressPublisher`, and `RepositoryHost`
allow future Vercel Sandbox, self-hosted, or other code-host integrations
without changing the evidence model.

## Canonical data model

The minimum canonical entities are:

- Tenant, user, membership, and audit event.
- GitHub installation and repository.
- Pull request, commit, and immutable repository snapshot.
- File and symbol with snapshot-bound source locations.
- Static and runtime graph nodes and edges.
- Test definition, test selection reason, test run, assertion, and coverage.
- Generated-test objective, source, compilation result, base/head outcomes, and
  permanent-inclusion recommendation.
- Contract and contract change.
- User journey and affected-journey path.
- Evidence item and evidence freshness.
- Finding, Proof Card, Change Passport, and accepted-change decision.
- Artifact, Evidence Manifest, and reproduction bundle.

Every evidence edge stores:

- evidence type;
- confidence factors rather than an invented model percentage;
- origin and analysis-engine version;
- repository snapshot and source citation;
- creation time and freshness state;
- artifact digest;
- reproducibility status;
- optional limitations.

Source locations always include a snapshot SHA. The UI must never link a claim
to a mutable branch location.

## Analysis state machine

An analysis moves through these durable states:

```text
QUEUED
  -> PREFLIGHTING
  -> FETCHING_SNAPSHOTS
  -> MAPPING_BASE + MAPPING_HEAD
  -> SELECTING_TESTS
  -> EXECUTING_BASE + EXECUTING_HEAD
  -> COMPARING_BEHAVIOR
  -> BUILDING_PASSPORT
  -> COMPLETED | PARTIAL | FAILED | CANCELLED
```

Each transition is idempotent and records its input digest, attempt, start/end
time, engine version, and outcome. Base and head execution can proceed in
parallel after selection. Passport construction proceeds when both complete or
when the orchestrator has enough terminal information to publish a truthful
partial result.

## Analysis flow

1. Verify the GitHub webhook signature and reject replays.
2. Resolve the installation, tenant, repository, pull request, and immutable
   base/head SHAs.
3. Create a unique analysis idempotency key from repository, SHAs,
   configuration, and engine version.
4. Perform a read-only preflight and enforce size/resource policy.
5. Broker encrypted, content-addressed base/head source archives.
6. Start separate gVisor static-mapping Jobs for base and head. These Jobs parse
   both snapshots, map changed lines to symbols, discover tests, and return
   schema-validated graph fragments without installing dependencies or running
   repository code.
7. Ingest the graph fragments and build or incrementally update canonical static
   entities.
8. Select relevant tests with inspectable reasons.
9. Derive candidate-test objectives only where deterministic evidence identifies
   a changed branch or contract with no mapped test. Generate candidates through
   a replaceable model adapter, then treat the output as untrusted source.
10. Start separate, equivalent gVisor execution Jobs for base and head.
11. Install locked dependencies under time, network, process, disk, CPU, and
    memory limits.
12. Compile generated candidates, then execute relevant existing and compiled
    generated tests on both revisions. Capture outcomes, exceptions, HTTP
    observations, paths, coverage, and timing.
13. Ingest signed, schema-validated result envelopes.
14. Compare base/head results and external contracts.
15. Produce evidence-backed findings. Unsupported AI commentary cannot create a
    confirmed finding.
16. Build Proof Cards, the Change Passport, Evidence Manifest, and optional
    reproduction bundle.
17. Publish progress and the GitHub Check, then destroy temporary Jobs and
    apply the configured artifact retention policy.

## Test selection

V1 selection uses deterministic evidence:

- changed symbols;
- static dependants;
- test imports and call relationships;
- current or retained runtime coverage;
- framework conventions;
- user-declared critical paths.

Every selected test stores one or more human-readable reasons. Excluded tests
are inspectable. The UI never equates selected-test success with full repository
verification and always shows unverified critical paths.

Generated tests begin with a deterministic objective such as “changed error
branch has no mapped test.” Model output cannot select its own objective or
certify itself. The runner compiles and executes the candidate on base and head.
Only observed, repeatable results contribute runtime evidence. Uncompiled,
unexecuted, or flaky candidates remain visible as such and cannot create a
confirmed finding.

## Replay contract

`codeatlas replay <finding-id>` performs a defined, verifiable workflow:

1. Authenticate the user and reauthorize access to the finding's repository.
2. Download the signed Evidence Manifest and reproduction bundle.
3. Verify manifest signature, artifact digests, engine version, base/head SHAs,
   lockfile hashes, and bundle expiry.
4. Clone or fetch the immutable SHAs directly from GitHub. Private source is not
   embedded in the bundle.
5. Create equivalent local Docker environments from the recorded runner image
   digest and resource policy.
6. Apply only the recorded generated-test source or minimal reproduction patch.
7. Execute the recorded base and head commands and compare sanitized outcomes.
8. Print `REPRODUCED`, `NOT_REPRODUCED`, or `ENVIRONMENT_MISMATCH` with exact
   limitations and local artifact locations.

Docker is the V1 local replay prerequisite. A replay is never reported as
successful merely because the bundle downloaded or a command exited.

## Findings and confidence

Finding states are:

- `CONFIRMED_REGRESSION`
- `CONFIRMED_CHANGE`
- `PROBABLE_IMPACT`
- `POSSIBLE_IMPACT`
- `UNVERIFIED`
- `RESOLVED`
- `ACCEPTED_CHANGE`

Confidence is derived from explicit factors: exact symbol resolution, evidence
independence, runtime observation, differential reproduction, repeatability,
freshness, path length, dynamic uncertainty, environment reproducibility, and
flakiness. The UI prefers qualitative confidence when numerical precision would
be misleading and always exposes the contributing factors.

## Security and user safety

CodeAtlas assumes imported source, dependencies, build scripts, test commands,
and test output are hostile.

### Isolation

- Base and head run in separate ephemeral gVisor sandboxes.
- Pods run without production secrets or default Google Cloud permissions.
- Each Job has an isolated namespace identity and explicit resource limits.
- Workspaces are writable only where execution requires it; analyzer images are
  otherwise immutable and digest-pinned.
- Privileged mode, host paths, raw sockets, cloud metadata, and private network
  access are prohibited.
- Default-deny ingress and egress are applied before repository code starts.
- CPU, memory, process, disk, output, network, and wall-time limits are enforced.
- Temporary Pods and workspaces are destroyed at terminal completion.

### Credentials and source

- The trusted broker alone receives short-lived GitHub installation tokens.
- Source artifacts use KMS-backed envelope encryption and short-lived,
  single-use access.
- Sandboxes use signed capability tokens limited to the current analysis and
  result upload operation.
- Secret Manager stores service credentials; Workload Identity replaces static
  Google Cloud keys.
- Logs and errors are sanitized before leaving the execution boundary.
- Private source is excluded from model training and AI providers by default.
  Generated-test features receive only the minimum normalized objective and
  cited code window under an explicit, visible repository policy. Disabling AI
  leaves static analysis, test selection, execution, comparison, Passports, and
  replay fully functional.

### Tenant and application security

- Every API request authorizes tenant, membership, repository, and action.
- PostgreSQL row-level security enforces tenant ownership again at persistence.
- Firebase custom claims are hints, not the sole source of authorization truth.
- OAuth state, PKCE where applicable, secure cookies, CSRF protection, strict
  CSP, output encoding, and webhook signature/replay validation are required.
- Rate limits, quotas, budget ceilings, repository-size limits, and concurrency
  limits protect users from abuse and denial-of-wallet attacks.
- Artifact download links are short-lived, tenant-bound, and audited.
- Sensitive actions such as repository deletion and retention changes require
  recent authentication and produce audit records.

### User control

- Repository selection is least-privilege by default.
- Privacy mode and retention are visible in the workspace header.
- Users can cancel analysis and delete source plus derived data.
- Raw source archives are deleted after terminal analysis completion, with a
  one-hour cleanup service-level objective. Traces, coverage, and test artifacts
  default to seven-day retention. Passports and signed manifests remain until
  repository deletion. Optional reproduction bundles default to seven days and
  contain no repository source archive.
- Repository owners can shorten artifact retention to one day or extend it to
  thirty days before an analysis runs. The effective policy is recorded in the
  Passport.
- Deletion progress is explicit and ends with an auditable completion record
  that contains no deleted source or derived evidence.
- Evidence exports identify engine versions, limitations, and snapshot SHAs.

## Reliability and failure behavior

Failures are classified as `USER_CONFIGURATION`, `REPOSITORY`, `TEST`,
`INFRASTRUCTURE`, `SECURITY_POLICY`, or `INTERNAL`.

- Invalid authorization, tenant mismatch, artifact mismatch, or signature
  failure is fail-closed and never retried automatically.
- Transient control-plane and GKE scheduling failures use bounded exponential
  retries with jitter and idempotency keys.
- Dependency-install and repository test failures are repository outcomes, not
  infrastructure retry signals. They are reported with sanitized output and do
  not become confirmed behavioral findings without comparable base/head
  evidence.
- Flaky tests can be repeated within the configured budget; all attempts remain
  visible and cannot become confirmed evidence unless repeatability rules pass.
- A base or head timeout produces a `PARTIAL` Passport with the missing side and
  affected conclusions explicitly marked unverified.
- User cancellation stops scheduling, terminates running Jobs, retains a minimal
  audit record, and applies the repository cleanup policy.
- Result schema, size, or digest failure quarantines the artifact and creates a
  security event without displaying untrusted output.
- Progress comes from durable state transitions, so refreshing the browser never
  loses job state.
- GitHub Check publication failure does not destroy a completed Passport; it is
  retried independently.

## Product information architecture

The product has six primary surfaces:

1. **Repository state:** current verification state, stale evidence, attention
   items, and recent Change Passports. It is not a generic metric dashboard.
2. **Analysis progress:** one chronological, resumable execution story.
3. **Impact workspace:** the Evidence Map with lenses for Change, Runtime,
   Contracts, Tests, Security, Architecture, History, and User Journeys.
4. **Proof Cards:** focused findings with base/head behavior, evidence, journey,
   citations, limitations, and replay.
5. **Change Passport:** permanent report, decisions, exports, engine metadata,
   and integrity information.
6. **Repository settings:** GitHub access, critical paths, retention, deletion,
   privacy, quotas, and audit history.

The primary desktop workspace uses a narrow navigation rail, a central Evidence
Map, and a right-side Proof Card. On smaller screens, the graph becomes a
filterable impact list and Proof Cards become full-screen sheets. No critical
information depends on hover, color, or animation.

## Visual design: Forensic Cartography

### Design thesis

The interface combines a quiet review document with a deep map room. Calm,
paper-like surfaces hold navigation and decisions. Technical power is
concentrated in a deep marine Evidence Map. The map is structural: contour bands
represent blast-radius distance, edge treatments represent evidence type, and
node state represents changed, executed, failed, or unverified entities.

This avoids the common dark-neon AI dashboard, decorative particles,
glassmorphism, fake metrics, and unearned gradients.

### Color tokens

- `Survey Paper` `#EEF2F1`: primary application background.
- `Field White` `#F8FAF9`: cards and document surfaces.
- `Atlas Ink` `#102832`: map canvas and primary text.
- `Route Cobalt` `#2368D7`: selected and changed entities.
- `Observed Teal` `#55D5AA`: runtime-confirmed evidence.
- `Fault Red` `#AE3A31`: confirmed regressions and failed paths.
- `Contour Slate` `#6F8A90`: inferred and secondary graph structure.

Status never relies on color alone; every color signal includes text, shape, or
line treatment.

### Typography

- **Display and brand:** Familjen Grotesk, used for product titles and decisive
  headings.
- **Body and interface:** IBM Plex Sans, used for dense readable product copy.
- **Evidence and utility:** IBM Plex Mono, used for SHAs, commands, labels,
  evidence types, and machine-readable identifiers.

Fonts are self-hosted with explicit subsets and fallbacks. Body text never uses
the mono face merely to look technical.

### Signature element

The signature is the evidence route. During analysis, a restrained sequence
illuminates changed symbols, expands direct and indirect dependants, adds user
journeys, turns runtime-confirmed edges solid, leaves inferred edges dotted, and
opens the first material Proof Card. The sequence explains the analysis and can
be skipped. Reduced-motion mode shows the final state immediately.

### Restraint rules

- One primary focal point per screen.
- No ambient particle or looping graph animation.
- No decorative charts without a decision they support.
- No rows of interchangeable dashboard cards.
- No unsupported percentage presented as confidence.
- Advanced lenses progressively disclose depth without changing the underlying
  system twin.
- Keyboard focus, screen-reader names, contrast, zoom, and reduced motion meet
  WCAG 2.2 AA as a release requirement.

## Testing strategy

### Unit tests

- Diff-to-symbol mapping.
- TypeScript symbol and call relationship extraction.
- Test selection and explanation generation.
- Contract normalization and compatibility classification.
- Confidence factor calculation.
- Evidence Manifest canonicalization, hashing, and signature verification.
- Generated-test objective derivation, labelling, and result eligibility.
- Analysis state transitions and retry classification.
- Tenant authorization policies.

### Fixture and differential tests

Versioned fixture repositories contain seeded changes for authentication errors,
removed validation, response-schema changes, nullability, boundary comparisons,
event payloads, architecture violations, weak tests, and dependency failures.
Every confirmed-finding detector must pass a base/head golden fixture and
demonstrate valid citations and replay.

### Integration tests

- GitHub App installation and webhook replay protection.
- Source broker token isolation and encrypted artifact lifecycle.
- Tasks and Workflows idempotency.
- GKE Job creation, cancellation, timeout, and cleanup.
- Result-envelope schema, signature, digest, and size validation.
- Cloud SQL row-level tenant isolation.
- Firestore progress publication and recovery.
- Storage retention and deletion.
- GitHub Check retry behavior.

### Adversarial security tests

Test repositories attempt metadata access, private-network access, credential
theft, fork bombs, disk exhaustion, oversized output, symlink escapes, malicious
package scripts, egress bypass, artifact spoofing, and cross-tenant identifiers.
The expected result is containment, a sanitized error, cleanup, and an audit
event where appropriate.

### End-to-end tests

Browser tests cover sign-in, installation, preflight, manual and PR-triggered
analysis, live progress, Evidence Map navigation, Proof Card citations, Passport
export, candidate-test labelling, CLI replay instructions, cancellation,
retention changes, and deletion.
Accessibility tests cover keyboard traversal, focus management, screen-reader
labels, contrast, zoom, reduced motion, and the list alternative to the graph.

### Production acceptance gates

- Every displayed citation resolves to the correct immutable snapshot location.
- Every runtime-confirmed finding includes reproducible evidence.
- No uncited AI statement is displayed as fact.
- Every generated test is labelled executed or unexecuted.
- Every risk or confidence display exposes its factors.
- Private source never appears in sanitized platform logs.
- Cross-tenant access tests fail at both API and database boundaries.
- Temporary execution resources are removed after all terminal states.
- The complete seeded demonstration produces the expected Passport and replay.

## Deployment and environments

- **Local:** Firebase emulators, PostgreSQL, local object storage, and a local
  execution-provider adapter. The same evidence schemas and fixture repositories
  are used locally and in production.
- **Preview:** Firebase App Hosting preview plus isolated non-production Google
  Cloud resources. Preview never receives production GitHub or KMS credentials.
- **Staging:** production-equivalent GKE Sandbox, Cloud SQL, Storage, Workflows,
  and GitHub test installation.
- **Production:** Firebase Blaze, regional Google Cloud resources, GKE Autopilot
  sandbox Jobs, managed backups, KMS, monitoring, and budget alerts.

Infrastructure is declared through Terraform. Schema migrations are explicit,
forward-compatible during rollout, and tested against production-like data
volumes. Analyzer and runner versions are embedded in every result.

## Observability and operations

- Correlation ids connect GitHub delivery, analysis, workflow, GKE Jobs,
  artifacts, findings, and Passport without logging source.
- Metrics include queue latency, stage duration, sandbox startup, install time,
  test time, cleanup latency, artifact size, retry count, and failure class.
- Alerts cover signature failures, cross-tenant denials, cleanup backlog,
  abnormal egress, quota exhaustion, analysis error rate, and cost anomalies.
- Operational dashboards are internal and separate from the customer product.
- Runbooks cover GitHub degradation, GKE scheduling failure, KMS/storage failure,
  database restore, malicious workload containment, and deletion backlog.

## Product integrity rules

CodeAtlas may say:

- “Produces reproducible evidence.”
- “Identifies verified and unverified impact.”
- “Increases confidence before merging.”
- “Distinguishes observed behavior from inference.”
- “Helps reviewers focus on meaningful risk.”

CodeAtlas must not claim that it guarantees safe code, finds every bug, proves a
change correct, understands every repository perfectly, or removes the need for
human review.

## Final acceptance statement

The first release is complete when a user can securely install CodeAtlas on a
selected public or private TypeScript/JavaScript repository, analyze a real pull
request in equivalent isolated base/head environments, inspect a truthful
Evidence Graph and Proof Card, export a signed Change Passport and Evidence
Manifest, replay a confirmed seeded regression, and delete all repository data
through the product interface.
