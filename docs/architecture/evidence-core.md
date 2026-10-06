# Evidence core architecture

This milestone is the local vertical slice of CodeAtlas: it maps a TypeScript
change, selects and executes the relevant tests on both revisions, generates one
evidence-targeted regression test, compares observed behaviour, signs a Change
Passport, and replays the result.

Everything here runs on one machine. The hosted control plane, sandboxed
execution plane, GitHub App and tenant model are later plans. The package
interfaces below are the ones those plans implement.

## Package graph

```text
evidence ── analyzer ── selector ─┐
    │           │                 ├── pipeline ── cli
    │           ├── generator ────┤              └ web
    │           ├── runner ───────┤
    │           ├── differential ─┤
    └───────────── passport ──────┘
```

| Package                   | Responsibility                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@codeatlas/evidence`     | Evidence, graph, finding, Proof Card and Passport schemas; canonical manifest signing and verification. Depends on no infrastructure.                                                                                                               |
| `@codeatlas/analyzer`     | Content snapshot digests, TypeScript symbol/import/call extraction, test discovery, branch locations, changed-line to symbol mapping. Never imports or executes repository code.                                                                    |
| `@codeatlas/selector`     | Deterministic reverse reachability from changed symbols to tests, with a human-readable reason per selection and an inspectable exclusion explanation.                                                                                              |
| `@codeatlas/runner`       | The `ExecutionProvider` contract and a bounded local implementation: copies a snapshot to a temporary directory, runs Vitest through an argument array with no shell, captures outcomes, coverage and assertion observations, and sanitises output. |
| `@codeatlas/generator`    | Derives test objectives from uncovered changed branches and emits a narrow template test. The generator cannot choose its own objective or certify its own output.                                                                                  |
| `@codeatlas/differential` | Compares base and head executions and classifies findings against explicit evidence-eligibility rules.                                                                                                                                              |
| `@codeatlas/passport`     | Assembles the Change Passport from validated findings and runs, and exports the same object as JSON or Markdown.                                                                                                                                    |
| `@codeatlas/pipeline`     | Orchestrates the sequence and stores content-addressed artifacts through an `ArtifactStore`.                                                                                                                                                        |
| `@codeatlas/cli`          | `codeatlas analyze` and `codeatlas replay`.                                                                                                                                                                                                         |
| `@codeatlas/web`          | The Forensic Cartography workspace.                                                                                                                                                                                                                 |

## Orchestration sequence

`analyzeComparison` performs, in order:

1. Compute content snapshot digests for both roots.
2. Analyze both snapshots, then map changed lines to symbols.
3. Select relevant existing tests, recording why each was chosen.
4. Execute the selected tests once to obtain coverage.
5. Derive objectives for changed branches with no runtime coverage, and
   generate a candidate test per objective.
6. Execute the combined existing and generated set three times on each revision.
7. Compare the runs and produce findings.
8. Sign the Evidence Manifest, build the Passport, and write the reproduction
   bundle.

Every stored artifact is addressed by the SHA-256 digest of its canonical JSON
and written with a temporary file plus a link, so a reader never observes a
partial artifact. The temporary file stays open through ownership-checked
cleanup, preventing inode reuse from making a substituted file look like the
file this operation created.

## Determinism

The analysis id is derived from provider, both snapshot digests, the
configuration digest and the engine version. The same inputs always produce the
same analysis id. Canonical evidence with the same observation timestamps has
the same manifest digest; the same signing key also produces the same signature.
Per-attempt identifiers exist outside the canonical manifest. Ordinary CLI runs
use the current time and a new signing key, so repeated analyses can share an
analysis id while producing different signed manifests.

The CLI retains content-addressed artifacts and publishes a current
`reproduction-bundle.json` beside the matching signature. Finding-ID replay uses
that bundle. For older run directories without a current pointer, it selects a
bundle whose manifest digest matches the recorded signature envelope. Explicit
exported bundle paths remain available for replaying older analyses.

## Replaceable boundaries

`ExecutionProvider`, `ArtifactStore` and `TestGenerator` are injected. The local
implementations in this milestone satisfy the same contracts that the GKE
sandbox provider, Cloud Storage artifact store and model-backed generator will
implement, so the evidence model does not change when execution moves off the
developer machine.

## What this milestone does not do

No part of this build provides hosted authentication, GitHub App installation,
private repository access, tenant isolation, sandboxed execution, retention
policy enforcement or production telemetry. Those are assigned to the hosted
control plane, sandbox execution, GitHub production and launch hardening plans.
