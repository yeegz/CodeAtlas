import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { z } from "zod";

const IdentifierSchema = z.string().min(1);
const SnapshotShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const ReproducibilitySchema = z.enum([
  "REPRODUCIBLE",
  "PARTIALLY_REPRODUCIBLE",
  "NOT_REPRODUCIBLE",
]);

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
  "AI_INFERENCE",
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
  "COMPARES_TO",
]);

export const FindingStateSchema = z.enum([
  "CONFIRMED_REGRESSION",
  "CONFIRMED_CHANGE",
  "PROBABLE_IMPACT",
  "POSSIBLE_IMPACT",
  "UNVERIFIED",
  "RESOLVED",
  "ACCEPTED_CHANGE",
]);

export const ConfidenceFactorSchema = z.union([
  z.enum([
    "DIFFERENTIAL_EXECUTION",
    "EXACT_TEST_IDENTITY",
    "EXACT_SYMBOL_PATH",
    "MATCHING_ENVIRONMENT",
    "CURRENT_EVIDENCE",
    "INSUFFICIENT_EVIDENCE",
  ]),
  z.string().regex(/^REPEATABLE_[1-9][0-9]*_OF_[1-9][0-9]*$/),
]);

export const FindingConfidenceSchema = z
  .strictObject({
    level: z.enum(["HIGH", "MEDIUM", "LOW"]),
    factors: z.array(ConfidenceFactorSchema).min(1).readonly(),
  })
  .readonly();

export const SourceLocationSchema = z
  .strictObject({
    snapshotSha: z.string().regex(/^[0-9a-f]{40}$/),
    path: z
      .string()
      .min(1)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.startsWith("\\") &&
          !/^[A-Za-z]:/.test(value) &&
          !value.includes(".."),
      ),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine((value) => value.endLine >= value.startLine);

export const EvidenceItemSchema = z.strictObject({
  id: IdentifierSchema,
  type: EvidenceTypeSchema,
  origin: z.string().min(1),
  observedAt: z.iso.datetime(),
  reproducibility: ReproducibilitySchema,
  source: SourceLocationSchema.optional(),
  artifactDigest: Sha256DigestSchema,
});

export const GraphNodeSchema = z.strictObject({
  id: IdentifierSchema,
  kind: z.string().min(1),
  label: z.string().min(1),
  snapshotSha: SnapshotShaSchema,
  source: SourceLocationSchema.optional(),
  evidenceIds: z.array(IdentifierSchema).default([]),
});

export const GraphEdgeSchema = z.strictObject({
  id: IdentifierSchema,
  from: IdentifierSchema,
  to: IdentifierSchema,
  relation: GraphRelationSchema,
  evidenceType: EvidenceTypeSchema,
  evidenceIds: z.array(IdentifierSchema).min(1),
  snapshotSha: SnapshotShaSchema,
});

export const ProofCardSchema = z.strictObject({
  baseBehavior: z.string().min(1),
  headBehavior: z.string().min(1),
  evidenceIds: z.array(IdentifierSchema).min(1),
  affectedJourney: z.string().min(1),
  reproductionCommand: z.string().min(1),
  recommendedAction: z.string().min(1),
  limitations: z.array(z.string().min(1)),
});

const EvidenceFreeUnverifiedProofCardSchema = ProofCardSchema.extend({
  evidenceIds: z.array(IdentifierSchema).length(0),
  limitations: z.array(z.string().min(1)).min(1),
});

export const FindingEvidenceSchema = z.strictObject({
  id: IdentifierSchema,
  type: EvidenceTypeSchema,
  reproducibility: ReproducibilitySchema,
  baseSha: SnapshotShaSchema,
  headSha: SnapshotShaSchema,
  executions: z.strictObject({
    base: z.number().int().nonnegative(),
    head: z.number().int().nonnegative(),
  }),
  testExecutionId: IdentifierSchema.optional(),
});

export const FindingSchema = z
  .strictObject({
    id: IdentifierSchema,
    state: FindingStateSchema,
    title: z.string().min(1),
    summary: z.string().min(1),
    graphPath: z.string().min(1).optional(),
    confidence: FindingConfidenceSchema.optional(),
    proofCard: z.union([
      ProofCardSchema,
      EvidenceFreeUnverifiedProofCardSchema,
    ]),
    evidence: z.array(FindingEvidenceSchema),
  })
  .superRefine((finding, context) => {
    if (
      finding.proofCard.evidenceIds.length === 0 &&
      finding.state !== "UNVERIFIED"
    ) {
      context.addIssue({
        code: "custom",
        path: ["proofCard", "evidenceIds"],
        message: "only unverified findings may omit evidence citations",
      });
    }
    const evidenceById = new Map(
      finding.evidence.map((evidence) => [evidence.id, evidence]),
    );
    if (evidenceById.size !== finding.evidence.length) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "finding evidence ids must be unique",
      });
    }

    finding.proofCard.evidenceIds.forEach((evidenceId, evidenceIndex) => {
      if (!evidenceById.has(evidenceId)) {
        context.addIssue({
          code: "custom",
          path: ["proofCard", "evidenceIds", evidenceIndex],
          message: "Proof Card evidence ids must resolve to finding evidence",
        });
      }
    });

    const citedEvidence = finding.evidence.filter((evidence) =>
      finding.proofCard.evidenceIds.includes(evidence.id),
    );
    if (
      (finding.state === "CONFIRMED_REGRESSION" ||
        finding.state === "CONFIRMED_CHANGE") &&
      !citedEvidence.some(
        (evidence) =>
          evidence.type === "DIFFERENTIAL_EXECUTION" &&
          evidence.reproducibility === "REPRODUCIBLE" &&
          evidence.executions.base > 0 &&
          evidence.executions.head > 0,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message:
          "confirmed findings require repeatable base and head differential execution evidence",
      });
    }
  });

export const TestExecutionSchema = z.strictObject({
  id: IdentifierSchema,
  command: z.string().min(1),
  provenance: z.enum(["EXISTING", "GENERATED"]),
  executedOnBase: z.boolean(),
  executedOnHead: z.boolean(),
  evidenceIds: z.array(IdentifierSchema),
});

export const ChangePassportSchema = z
  .strictObject({
    baseSha: SnapshotShaSchema,
    headSha: SnapshotShaSchema,
    engineVersion: z.string().min(1),
    findings: z.array(FindingSchema),
    executedTests: z.array(TestExecutionSchema),
    unverifiedAreas: z.array(z.string().min(1)),
    retentionPolicy: z.string().min(1),
    manifestDigest: Sha256DigestSchema,
  })
  .superRefine((passport, context) => {
    passport.findings.forEach((finding, findingIndex) => {
      const citedEvidence = finding.evidence.filter((evidence) =>
        finding.proofCard.evidenceIds.includes(evidence.id),
      );
      const isGeneratedExecutionEvidence = (evidence: FindingEvidence) =>
        passport.executedTests.some(
          (test) =>
            test.provenance === "GENERATED" &&
            (test.id === evidence.testExecutionId ||
              test.evidenceIds.includes(evidence.id)),
        );
      const citesGeneratedConfirmationEvidence = citedEvidence.some(
        (evidence) =>
          evidence.type === "DIFFERENTIAL_EXECUTION" &&
          evidence.reproducibility === "REPRODUCIBLE" &&
          evidence.executions.base > 0 &&
          evidence.executions.head > 0 &&
          isGeneratedExecutionEvidence(evidence),
      );
      const hasIndependentCorroboration = citedEvidence.some(
        (evidence) =>
          evidence.type !== "AI_INFERENCE" &&
          !isGeneratedExecutionEvidence(evidence) &&
          evidence.baseSha === passport.baseSha &&
          evidence.headSha === passport.headSha,
      );

      if (
        (finding.state === "CONFIRMED_REGRESSION" ||
          finding.state === "CONFIRMED_CHANGE") &&
        citesGeneratedConfirmationEvidence &&
        !hasIndependentCorroboration
      ) {
        context.addIssue({
          code: "custom",
          path: ["findings", findingIndex, "proofCard", "evidenceIds"],
          message:
            "generated execution confirmation requires independent cited corroborating evidence",
        });
      }

      finding.evidence.forEach((evidence, evidenceIndex) => {
        const evidencePath = [
          "findings",
          findingIndex,
          "evidence",
          evidenceIndex,
        ] as const;

        if (
          evidence.baseSha !== passport.baseSha ||
          evidence.headSha !== passport.headSha
        ) {
          context.addIssue({
            code: "custom",
            path: [...evidencePath],
            message: "finding evidence revisions must match the Passport",
          });
        }

        const unexecutedGeneratedTest = passport.executedTests.find(
          (test) =>
            test.provenance === "GENERATED" &&
            test.evidenceIds.includes(evidence.id) &&
            (!test.executedOnBase || !test.executedOnHead),
        );
        if (
          (finding.state === "CONFIRMED_REGRESSION" ||
            finding.state === "CONFIRMED_CHANGE") &&
          unexecutedGeneratedTest !== undefined
        ) {
          context.addIssue({
            code: "custom",
            path: [...evidencePath],
            message:
              "an unexecuted generated test cannot certify a confirmed finding",
          });
        }

        if (evidence.testExecutionId === undefined) {
          return;
        }

        const testExecution = passport.executedTests.find(
          (test) => test.id === evidence.testExecutionId,
        );
        if (testExecution === undefined) {
          context.addIssue({
            code: "custom",
            path: [...evidencePath, "testExecutionId"],
            message: "finding evidence must reference a Passport test entry",
          });
          return;
        }

        if (!testExecution.evidenceIds.includes(evidence.id)) {
          context.addIssue({
            code: "custom",
            path: [...evidencePath, "testExecutionId"],
            message: "the referenced test must identify this evidence",
          });
        }

        if (
          evidence.executions.base > 0 !== testExecution.executedOnBase ||
          evidence.executions.head > 0 !== testExecution.executedOnHead
        ) {
          context.addIssue({
            code: "custom",
            path: [...evidencePath, "executions"],
            message: "evidence execution counts must match the Passport test",
          });
        }
      });
    });
  });

export const AnalysisIdentityInputSchema = z.strictObject({
  provider: z.string().min(1),
  baseSha: SnapshotShaSchema,
  headSha: SnapshotShaSchema,
  configurationDigest: Sha256DigestSchema,
  engineVersion: z.string().min(1),
});

export type AnalysisIdentityInput = z.infer<typeof AnalysisIdentityInputSchema>;

export function deriveAnalysisId(input: unknown): string {
  const validatedInput = AnalysisIdentityInputSchema.parse(input);
  const digest = createHash("sha256")
    .update(canonicalize(validatedInput), "utf8")
    .digest("hex");

  return `analysis_${digest}`;
}

export const EvidenceManifestSchema = z
  .strictObject({
    schemaVersion: z.string().min(1),
    repository: z.strictObject({
      provider: z.string().min(1),
      baseSha: SnapshotShaSchema,
      headSha: SnapshotShaSchema,
    }),
    configurationDigest: Sha256DigestSchema,
    analysisId: IdentifierSchema,
    engineVersion: z.string().min(1),
    evidence: z.array(EvidenceItemSchema),
  })
  .superRefine((manifest, context) => {
    const expectedAnalysisId = deriveAnalysisId({
      provider: manifest.repository.provider,
      baseSha: manifest.repository.baseSha,
      headSha: manifest.repository.headSha,
      configurationDigest: manifest.configurationDigest,
      engineVersion: manifest.engineVersion,
    });

    if (manifest.analysisId !== expectedAnalysisId) {
      context.addIssue({
        code: "custom",
        path: ["analysisId"],
        message: "analysisId does not match the deterministic analysis inputs",
      });
    }
  });

export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;
export type GraphRelation = z.infer<typeof GraphRelationSchema>;
export type FindingState = z.infer<typeof FindingStateSchema>;
export type ConfidenceFactor = z.infer<typeof ConfidenceFactorSchema>;
export type FindingConfidence = z.infer<typeof FindingConfidenceSchema>;
export type SourceLocation = z.infer<typeof SourceLocationSchema>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type FindingEvidence = z.infer<typeof FindingEvidenceSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type ProofCard = z.infer<typeof ProofCardSchema>;
export type TestExecution = z.infer<typeof TestExecutionSchema>;
export type ChangePassport = z.infer<typeof ChangePassportSchema>;
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;
