import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

import type { ExecutionResult } from "./execution-provider.js";

export type BoundExecutionResult = Omit<ExecutionResult, "resultDigest">;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export function computeExecutionResultDigest(
  result: BoundExecutionResult,
): string {
  return `sha256:${createHash("sha256")
    .update(canonicalize(result), "utf8")
    .digest("hex")}`;
}

export function hasValidExecutionResultBinding(
  value: unknown,
): value is ExecutionResult {
  if (!isRecord(value)) return false;
  if (
    typeof value.executionId !== "string" ||
    !UUID.test(value.executionId) ||
    typeof value.resultDigest !== "string" ||
    !SHA256.test(value.resultDigest)
  ) {
    return false;
  }
  const { resultDigest, ...boundResult } = value;
  try {
    return (
      resultDigest ===
      computeExecutionResultDigest(boundResult as BoundExecutionResult)
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
