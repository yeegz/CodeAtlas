import type {
  EvidenceItem,
  EvidenceType,
  GraphNode,
  GraphRelation,
  SourceLocation,
} from "@codeatlas/evidence";

export interface AnalyzedFile {
  id: string;
  path: string;
  digest: string;
  text: string;
}

export interface AnalyzedSymbol extends GraphNode {
  name: string;
  qualifiedName: string;
  source: SourceLocation;
  signature: string;
  signatureDigest: string;
}

export interface AnalyzedEdge {
  id: string;
  from: string;
  to: string;
  fromName: string;
  toName: string;
  relation: GraphRelation;
  evidenceIds: string[];
  evidenceType: EvidenceType;
  snapshotSha: string;
}

export interface AnalyzedTest {
  id: string;
  name: string;
  path: string;
  source: SourceLocation;
  evidenceIds: string[];
}

export interface AnalyzedContract {
  id: string;
  symbolId: string;
  name: string;
  signature: string;
  signatureDigest: string;
  source: SourceLocation;
  evidenceIds: string[];
}

export interface AnalyzedBranch {
  id: string;
  kind: "if" | "conditional" | "switch" | "catch";
  source: SourceLocation;
  evidenceIds: string[];
}

export interface SnapshotAnalysis {
  snapshotSha: string;
  files: AnalyzedFile[];
  symbols: AnalyzedSymbol[];
  edges: AnalyzedEdge[];
  tests: AnalyzedTest[];
  contracts: AnalyzedContract[];
  branches: AnalyzedBranch[];
  evidence: EvidenceItem[];
}

export interface ChangedSymbol {
  id: string;
  name: string;
  path: string;
  baseLocation: SourceLocation | null;
  headLocation: SourceLocation | null;
  changedLines: number[];
  signatureChanged: boolean;
}
