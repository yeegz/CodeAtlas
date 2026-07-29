import { describe, expect, it } from "vitest";
import {
  ChangePassportSchema,
  EvidenceItemSchema,
  EvidenceManifestSchema,
  FindingSchema,
  GraphEdgeSchema,
  deriveAnalysisId,
} from "../src/index.js";

const proofCard = {
  baseBehavior: "Login succeeds",
  headBehavior: "Login fails",
  evidenceIds: ["ev_1"],
  affectedJourney: "User login",
  reproductionCommand: "pnpm test login",
  recommendedAction: "Restore the authentication branch",
  limitations: [],
};

const identityInput = {
  provider: "local",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  configurationDigest: `sha256:${"c".repeat(64)}`,
  engineVersion: "0.1.0",
};

describe("evidence provenance", () => {
  it("round-trips optional graph path and qualitative confidence metadata", () => {
    const finding = {
      id: "finding_1",
      state: "UNVERIFIED",
      title: "Login behavior needs verification",
      summary: "Authentication may have changed",
      graphPath: "restoreSession → validateToken",
      confidence: {
        level: "LOW",
        factors: ["EXACT_SYMBOL_PATH", "REPEATABLE_2_OF_2"],
      },
      proofCard,
      evidence: [
        {
          id: "ev_1",
          type: "AI_INFERENCE",
          reproducibility: "NOT_REPRODUCIBLE",
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          executions: { base: 0, head: 0 },
        },
      ],
    };

    const parsed = FindingSchema.parse(JSON.parse(JSON.stringify(finding)));

    expect(parsed.graphPath).toBe("restoreSession → validateToken");
    expect(parsed.confidence).toEqual(finding.confidence);
  });

  it("rejects numeric or malformed confidence metadata", () => {
    const finding = {
      id: "finding_1",
      state: "UNVERIFIED",
      title: "Login behavior needs verification",
      summary: "Authentication may have changed",
      graphPath: "restoreSession → validateToken",
      proofCard,
      evidence: [
        {
          id: "ev_1",
          type: "AI_INFERENCE",
          reproducibility: "NOT_REPRODUCIBLE",
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          executions: { base: 0, head: 0 },
        },
      ],
    };

    expect(
      FindingSchema.safeParse({ ...finding, confidence: { level: 0.91 } })
        .success,
    ).toBe(false);
    expect(
      FindingSchema.safeParse({
        ...finding,
        confidence: { level: "HIGH", factors: ["REPEATABLE_MANY"] },
      }).success,
    ).toBe(false);
  });

  it("rejects a source citation without an immutable snapshot", () => {
    const result = EvidenceItemSchema.safeParse({
      id: "ev_1",
      type: "RUNTIME_TRACE",
      origin: "runner@0.1.0",
      observedAt: "2026-07-29T00:00:00.000Z",
      reproducibility: "REPRODUCIBLE",
      source: { path: "src/auth.ts", startLine: 12, endLine: 14 },
      artifactDigest: `sha256:${"a".repeat(64)}`,
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
      snapshotSha: "a".repeat(40),
    });
    expect(edge.evidenceType).toBe("AI_INFERENCE");
  });

  it.each(["C:\\repo\\auth.ts", "\\\\server\\share\\auth.ts"])(
    "rejects the absolute source path %s",
    (path) => {
      const result = EvidenceItemSchema.safeParse({
        id: "ev_1",
        type: "RUNTIME_TRACE",
        origin: "runner@0.1.0",
        observedAt: "2026-07-29T00:00:00.000Z",
        reproducibility: "REPRODUCIBLE",
        source: {
          snapshotSha: "a".repeat(40),
          path,
          startLine: 12,
          endLine: 14,
        },
        artifactDigest: `sha256:${"a".repeat(64)}`,
      });

      expect(result.success).toBe(false);
    },
  );

  it("rejects a malformed SHA-256 artifact digest", () => {
    const result = EvidenceItemSchema.safeParse({
      id: "ev_1",
      type: "RUNTIME_TRACE",
      origin: "runner@0.1.0",
      observedAt: "2026-07-29T00:00:00.000Z",
      reproducibility: "REPRODUCIBLE",
      artifactDigest: "sha256:not-a-digest",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a confirmed regression without repeatable base and head execution", () => {
    const result = FindingSchema.safeParse({
      id: "finding_1",
      state: "CONFIRMED_REGRESSION",
      title: "Login regression",
      summary: "Authentication changed",
      proofCard,
      evidence: [
        {
          id: "ev_1",
          type: "AI_INFERENCE",
          reproducibility: "REPRODUCIBLE",
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          executions: { base: 1, head: 1 },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects AI-only Proof Card citations backed by unrelated differential evidence", () => {
    const result = FindingSchema.safeParse({
      id: "finding_1",
      state: "CONFIRMED_REGRESSION",
      title: "Login regression",
      summary: "Authentication changed",
      proofCard: { ...proofCard, evidenceIds: ["ev_ai"] },
      evidence: [
        {
          id: "ev_ai",
          type: "AI_INFERENCE",
          reproducibility: "NOT_REPRODUCIBLE",
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          executions: { base: 0, head: 0 },
        },
        {
          id: "ev_diff",
          type: "DIFFERENTIAL_EXECUTION",
          reproducibility: "REPRODUCIBLE",
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          executions: { base: 1, head: 1 },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("preserves structured evidence for lesser finding states", () => {
    const finding = FindingSchema.parse({
      id: "finding_1",
      state: "POSSIBLE_IMPACT",
      title: "Possible login impact",
      summary: "Authentication may have changed",
      proofCard,
      evidence: [
        {
          id: "ev_1",
          type: "AI_INFERENCE",
          reproducibility: "NOT_REPRODUCIBLE",
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          executions: { base: 0, head: 0 },
        },
      ],
    });

    expect(finding.evidence).toHaveLength(1);
  });

  it("represents an unexecuted generated test without treating it as absent", () => {
    const passport = ChangePassportSchema.parse({
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      engineVersion: "0.1.0",
      findings: [],
      executedTests: [
        {
          id: "generated_1",
          command: "pnpm vitest run generated/login.test.ts",
          provenance: "GENERATED",
          executedOnBase: false,
          executedOnHead: false,
          evidenceIds: [],
        },
      ],
      unverifiedAreas: ["Generated login test was not executed"],
      retentionPolicy: "30 days",
      manifestDigest: `sha256:${"d".repeat(64)}`,
    });

    expect(passport.executedTests[0]?.provenance).toBe("GENERATED");
    expect(passport.executedTests[0]?.executedOnBase).toBe(false);
    expect(passport.executedTests[0]?.executedOnHead).toBe(false);
  });

  it("rejects an unexecuted generated test as confirmation evidence", () => {
    const result = ChangePassportSchema.safeParse({
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      engineVersion: "0.1.0",
      findings: [
        {
          id: "finding_1",
          state: "CONFIRMED_REGRESSION",
          title: "Login regression",
          summary: "Authentication changed",
          proofCard,
          evidence: [
            {
              id: "ev_diff",
              type: "DIFFERENTIAL_EXECUTION",
              reproducibility: "REPRODUCIBLE",
              baseSha: "a".repeat(40),
              headSha: "b".repeat(40),
              executions: { base: 1, head: 1 },
              testExecutionId: "generated_1",
            },
          ],
        },
      ],
      executedTests: [
        {
          id: "generated_1",
          command: "pnpm vitest run generated/login.test.ts",
          provenance: "GENERATED",
          executedOnBase: false,
          executedOnHead: false,
          evidenceIds: ["ev_diff"],
        },
      ],
      unverifiedAreas: [],
      retentionPolicy: "30 days",
      manifestDigest: `sha256:${"d".repeat(64)}`,
    });

    expect(result.success).toBe(false);
  });

  it("cannot bypass generated-test execution checks by omitting the test reference", () => {
    const result = ChangePassportSchema.safeParse({
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      engineVersion: "0.1.0",
      findings: [
        {
          id: "finding_1",
          state: "CONFIRMED_REGRESSION",
          title: "Login regression",
          summary: "Authentication changed",
          proofCard,
          evidence: [
            {
              id: "ev_diff",
              type: "DIFFERENTIAL_EXECUTION",
              reproducibility: "REPRODUCIBLE",
              baseSha: "a".repeat(40),
              headSha: "b".repeat(40),
              executions: { base: 1, head: 1 },
            },
          ],
        },
      ],
      executedTests: [
        {
          id: "generated_1",
          command: "pnpm vitest run generated/login.test.ts",
          provenance: "GENERATED",
          executedOnBase: false,
          executedOnHead: false,
          evidenceIds: ["ev_diff"],
        },
      ],
      unverifiedAreas: [],
      retentionPolicy: "30 days",
      manifestDigest: `sha256:${"d".repeat(64)}`,
    });

    expect(result.success).toBe(false);
  });

  it("rejects an executed generated test as the sole confirmation evidence", () => {
    const result = ChangePassportSchema.safeParse({
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      engineVersion: "0.1.0",
      findings: [
        {
          id: "finding_1",
          state: "CONFIRMED_REGRESSION",
          title: "Login regression",
          summary: "Authentication changed",
          proofCard: { ...proofCard, evidenceIds: ["ev_diff"] },
          evidence: [
            {
              id: "ev_diff",
              type: "DIFFERENTIAL_EXECUTION",
              reproducibility: "REPRODUCIBLE",
              baseSha: "a".repeat(40),
              headSha: "b".repeat(40),
              executions: { base: 1, head: 1 },
              testExecutionId: "generated_1",
            },
          ],
        },
      ],
      executedTests: [
        {
          id: "generated_1",
          command: "pnpm vitest run generated/login.test.ts",
          provenance: "GENERATED",
          executedOnBase: true,
          executedOnHead: true,
          evidenceIds: ["ev_diff"],
        },
      ],
      unverifiedAreas: [],
      retentionPolicy: "30 days",
      manifestDigest: `sha256:${"d".repeat(64)}`,
    });

    expect(result.success).toBe(false);
  });

  it("accepts executed generated confirmation evidence with cited independent corroboration", () => {
    const result = ChangePassportSchema.safeParse({
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      engineVersion: "0.1.0",
      findings: [
        {
          id: "finding_1",
          state: "CONFIRMED_REGRESSION",
          title: "Login regression",
          summary: "Authentication changed",
          proofCard: {
            ...proofCard,
            evidenceIds: ["ev_diff", "ev_static"],
          },
          evidence: [
            {
              id: "ev_diff",
              type: "DIFFERENTIAL_EXECUTION",
              reproducibility: "REPRODUCIBLE",
              baseSha: "a".repeat(40),
              headSha: "b".repeat(40),
              executions: { base: 1, head: 1 },
              testExecutionId: "generated_1",
            },
            {
              id: "ev_static",
              type: "STATIC_DATAFLOW",
              reproducibility: "REPRODUCIBLE",
              baseSha: "a".repeat(40),
              headSha: "b".repeat(40),
              executions: { base: 0, head: 0 },
            },
          ],
        },
      ],
      executedTests: [
        {
          id: "generated_1",
          command: "pnpm vitest run generated/login.test.ts",
          provenance: "GENERATED",
          executedOnBase: true,
          executedOnHead: true,
          evidenceIds: ["ev_diff"],
        },
      ],
      unverifiedAreas: [],
      retentionPolicy: "30 days",
      manifestDigest: `sha256:${"d".repeat(64)}`,
    });

    expect(result.success).toBe(true);
  });

  it("rejects finding evidence from revisions outside the Passport", () => {
    const result = ChangePassportSchema.safeParse({
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      engineVersion: "0.1.0",
      findings: [
        {
          id: "finding_1",
          state: "POSSIBLE_IMPACT",
          title: "Possible login impact",
          summary: "Authentication may have changed",
          proofCard,
          evidence: [
            {
              id: "ev_1",
              type: "AI_INFERENCE",
              reproducibility: "NOT_REPRODUCIBLE",
              baseSha: "f".repeat(40),
              headSha: "b".repeat(40),
              executions: { base: 0, head: 0 },
            },
          ],
        },
      ],
      executedTests: [],
      unverifiedAreas: ["Login behavior was not executed"],
      retentionPolicy: "30 days",
      manifestDigest: `sha256:${"d".repeat(64)}`,
    });

    expect(result.success).toBe(false);
  });
});

describe("analysis identity", () => {
  it("derives the documented identity from canonical repository inputs", () => {
    expect(deriveAnalysisId(identityInput)).toBe(
      "analysis_0364a45c70336fd653229fc8725174320a4245c7333863238f59c75b7e2f0aef",
    );
  });

  it("rejects an invented analysis id", () => {
    const result = EvidenceManifestSchema.safeParse({
      schemaVersion: "1.0",
      repository: {
        provider: identityInput.provider,
        baseSha: identityInput.baseSha,
        headSha: identityInput.headSha,
      },
      configurationDigest: identityInput.configurationDigest,
      analysisId: "analysis_invented",
      engineVersion: identityInput.engineVersion,
      evidence: [],
    });

    expect(result.success).toBe(false);
  });
});
