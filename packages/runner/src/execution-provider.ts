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
