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
      artifactDigest: "sha256:abc",
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
});
