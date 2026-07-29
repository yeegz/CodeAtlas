import { createHmac, timingSafeEqual } from "node:crypto";

type UnknownRecord = Record<string, unknown>;

export function trustedVitestReporterSource(
  resultPath: string,
  coveragePath: string,
  nonce: string,
  key: string,
): string {
  return `import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";

const RESULT_PATH = ${JSON.stringify(resultPath)};
const COVERAGE_PATH = ${JSON.stringify(coveragePath)};
const REPORT_NONCE = ${JSON.stringify(nonce)};
const REPORT_KEY = ${JSON.stringify(key)};

export default class CodeAtlasReporter {
  coverageMap;

  onUserConsoleLog(log) {
    const stream = log.type === "stderr" ? process.stderr : process.stdout;
    stream.write(log.content);
  }

  onCoverage(coverageMap) {
    this.coverageMap = coverageMap;
  }

  onTestRunEnd(testModules) {
    const testResults = testModules.map((testModule) => {
      const assertionResults = [...testModule.children.allTests()].map((test) => {
        const result = test.result();
        const errors = result.errors ?? [];
        const ancestorTitles = [];
        let parent = test.parent;
        while (parent.type === "suite") {
          ancestorTitles.push(parent.name);
          parent = parent.parent;
        }
        ancestorTitles.reverse();
        return {
          ancestorTitles,
          fullName: [...ancestorTitles, test.name].join(" "),
          title: test.name,
          status: result.state,
          failureMessages: errors.map(
            (error) => error.stack || error.message || "",
          ),
          failureDetails: errors.map((error) => ({
            stack: error.stack || error.message || "",
            actual: behavior(error.actual) ?? serializedBehavior(error.actual),
            expected:
              behavior(error.expected) ?? serializedBehavior(error.expected),
            assertionAuthentic:
              error.name === "AssertionError" &&
              error.showDiff === true &&
              error.operator === "deepStrictEqual" &&
              typeof error.diff === "string",
          })),
        };
      });
      return {
        name: testModule.moduleId,
        status: assertionResults.some(({ status }) => status === "failed")
          ? "failed"
          : "passed",
        assertionResults,
      };
    });
    const payload = { testResults, coverageMap: this.coverageMap };
    const payloadJson = JSON.stringify(payload);
    const mac = createHmac("sha256", REPORT_KEY)
      .update(REPORT_NONCE)
      .update("\0")
      .update(payloadJson)
      .digest("hex");
    writeFileSync(
      RESULT_PATH,
      JSON.stringify({ nonce: REPORT_NONCE, mac, payload }),
      { mode: 0o600 },
    );
    writeFileSync(COVERAGE_PATH, JSON.stringify(this.coverageMap ?? {}), {
      mode: 0o600,
    });
  }
}

function behavior(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.httpStatus !== "number" ||
    !Number.isFinite(value.httpStatus) ||
    typeof value.code !== "string"
  ) {
    return null;
  }
  return { httpStatus: value.httpStatus, code: value.code };
}

function serializedBehavior(value) {
  return typeof value === "string" && value.length <= 1024 ? value : null;
}
`;
}

export function verifyTrustedVitestReport(
  raw: string,
  expectedNonce: string,
  key: string,
): string | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(envelope) ||
    Object.keys(envelope).length !== 3 ||
    envelope.nonce !== expectedNonce ||
    typeof envelope.mac !== "string" ||
    !/^[a-f0-9]{64}$/u.test(envelope.mac) ||
    !isRecord(envelope.payload)
  ) {
    return null;
  }
  const payloadJson = JSON.stringify(envelope.payload);
  const expectedMac = createHmac("sha256", key)
    .update(expectedNonce)
    .update("\0")
    .update(payloadJson)
    .digest();
  const suppliedMac = Buffer.from(envelope.mac, "hex");
  return suppliedMac.length === expectedMac.length &&
    timingSafeEqual(suppliedMac, expectedMac)
    ? payloadJson
    : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
