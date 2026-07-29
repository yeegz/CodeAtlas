import { z } from "zod";

const IdentifierSchema = z.string().min(1);
const SnapshotShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

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

export const SourceLocationSchema = z
  .object({
    snapshotSha: z.string().regex(/^[0-9a-f]{40}$/),
    path: z
      .string()
      .min(1)
      .refine((value) => !value.startsWith("/") && !value.includes("..")),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine((value) => value.endLine >= value.startLine);

export const EvidenceItemSchema = z.object({
  id: IdentifierSchema,
  type: EvidenceTypeSchema,
  origin: z.string().min(1),
  observedAt: z.iso.datetime(),
  reproducibility: z.enum([
    "REPRODUCIBLE",
    "PARTIALLY_REPRODUCIBLE",
    "NOT_REPRODUCIBLE",
  ]),
  source: SourceLocationSchema.optional(),
  artifactDigest: z.string().regex(/^sha256:.+$/),
});

export const GraphNodeSchema = z.object({
  id: IdentifierSchema,
  kind: z.string().min(1),
  label: z.string().min(1),
  snapshotSha: SnapshotShaSchema,
  source: SourceLocationSchema.optional(),
  evidenceIds: z.array(IdentifierSchema).default([]),
});

export const GraphEdgeSchema = z.object({
  id: IdentifierSchema,
  from: IdentifierSchema,
  to: IdentifierSchema,
  relation: GraphRelationSchema,
  evidenceType: EvidenceTypeSchema,
  evidenceIds: z.array(IdentifierSchema).min(1),
  snapshotSha: SnapshotShaSchema,
});

export const ProofCardSchema = z.object({
  baseBehavior: z.string().min(1),
  headBehavior: z.string().min(1),
  evidenceIds: z.array(IdentifierSchema).min(1),
  affectedJourney: z.string().min(1),
  reproductionCommand: z.string().min(1),
  recommendedAction: z.string().min(1),
  limitations: z.array(z.string().min(1)),
});

export const FindingSchema = z.object({
  id: IdentifierSchema,
  state: FindingStateSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  proofCard: ProofCardSchema,
});

export const ChangePassportSchema = z.object({
  baseSha: SnapshotShaSchema,
  headSha: SnapshotShaSchema,
  engineVersion: z.string().min(1),
  findings: z.array(FindingSchema),
  executedTests: z.array(z.string().min(1)),
  unverifiedAreas: z.array(z.string().min(1)),
  retentionPolicy: z.string().min(1),
  manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const EvidenceManifestSchema = z.object({
  schemaVersion: z.string().min(1),
  repository: z.object({
    provider: z.string().min(1),
    baseSha: SnapshotShaSchema,
    headSha: SnapshotShaSchema,
  }),
  analysisId: IdentifierSchema,
  engineVersion: z.string().min(1),
  evidence: z.array(EvidenceItemSchema),
});

export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;
export type GraphRelation = z.infer<typeof GraphRelationSchema>;
export type FindingState = z.infer<typeof FindingStateSchema>;
export type SourceLocation = z.infer<typeof SourceLocationSchema>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type ProofCard = z.infer<typeof ProofCardSchema>;
export type ChangePassport = z.infer<typeof ChangePassportSchema>;
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;
