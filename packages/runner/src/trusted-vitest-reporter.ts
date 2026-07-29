export function trustedVitestReporterSource(resultPath: string): string {
  return `import { writeFileSync } from "node:fs";

const RESULT_PATH = ${JSON.stringify(resultPath)};

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
    writeFileSync(
      RESULT_PATH,
      JSON.stringify({ testResults, coverageMap: this.coverageMap }),
      { mode: 0o600 },
    );
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
