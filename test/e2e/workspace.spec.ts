import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * One shared analysis for the whole file: the demo runs the real pipeline on
 * both revisions, so repeating it per test would only re-prove the same run.
 */
test.describe.configure({ mode: "serial" });

async function openWorkspace(page: Page): Promise<void> {
  await page.goto("/");
  const runDemo = page.getByRole("button", { name: "Run verified demo" });
  if (await runDemo.isVisible()) {
    // First visit in this server process: actually execute the comparison.
    await runDemo.click();
  } else {
    // A terminal analysis is already stored, so navigate to it.
    await page.getByRole("link", { name: "Open the impact workspace" }).click();
  }
  await page.waitForURL("**/demo/pr/284");
  await expect(page.getByText("Action required")).toBeVisible();
}

test("shows the complete authentication proof", async ({ page }) => {
  await openWorkspace(page);

  await expect(
    page.getByRole("heading", {
      name: "Expired sessions return an internal error",
    }),
  ).toBeVisible();
  // Exact matches target the base/head pair rather than the summary sentence
  // that also quotes both behaviours.
  await expect(
    page.getByText("HTTP 401 with SESSION_EXPIRED", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("HTTP 500 with INTERNAL_ERROR", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("codeatlas replay finding_expired_session", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "View impact as list" }).click();
  await expect(
    page.getByRole("list", { name: "Affected code path" }),
  ).toContainText("validateToken");
});

test("labels the generated test as generated and executed on both revisions", async ({
  page,
}) => {
  await openWorkspace(page);
  const reasons = page.getByRole("region", { name: "Why these tests ran" });
  await expect(reasons).toContainText("test/codeatlas.expired-session.test.ts");
  await expect(reasons).toContainText("generated");
  await expect(reasons).toContainText(
    "Executed on base: yes. Executed on head: yes.",
  );
});

test("keeps observed evidence distinct from inferred evidence", async ({
  page,
}) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: "View impact as list" }).click();

  const relationships = page.getByRole("list", {
    name: "Evidence relationships",
  });
  await expect(
    relationships.locator('li[data-observed="true"]').first(),
  ).toContainText("observed");
  await expect(
    relationships.locator('li[data-observed="false"]').first(),
  ).toContainText("inferred");
});

test("reaches the map and the Proof Card with the keyboard alone", async ({
  page,
}) => {
  await openWorkspace(page);

  const changedNode = page.getByRole("button", {
    name: "validateToken(), changed, src/auth.ts",
  });
  await changedNode.focus();
  await expect(changedNode).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(changedNode).toHaveAttribute("aria-pressed", "true");

  const toggle = page.getByRole("button", { name: "View impact as list" });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("list", { name: "Affected code path" }),
  ).toBeVisible();
});

test("renders the final state immediately under reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openWorkspace(page);

  const node = page.getByRole("button", {
    name: "validateToken(), changed, src/auth.ts",
  });
  await expect(node).toBeVisible();
  const animation = await node.evaluate(
    (element) => getComputedStyle(element).animationName,
  );
  expect(animation).toBe("none");
});

/**
 * The reveal fades elements in, so a scan started mid-animation measures a
 * blended colour rather than the rendered one. Settle first and assert against
 * the state a reader actually sees.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

test("the landing page has no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/");
  await settleAnimations(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(seriousOrCritical(results.violations)).toEqual([]);
});

test("the workspace has no serious accessibility violations", async ({
  page,
}) => {
  await openWorkspace(page);
  await settleAnimations(page);
  const mapResults = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(seriousOrCritical(mapResults.violations)).toEqual([]);

  await page.getByRole("button", { name: "View impact as list" }).click();
  await settleAnimations(page);
  const listResults = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(seriousOrCritical(listResults.violations)).toEqual([]);
});

/**
 * Report the offending selector alongside the rule id: a bare rule name gives
 * no way to find the element that broke.
 */
function seriousOrCritical(
  violations: Array<{
    id: string;
    impact?: string | null | undefined;
    nodes: Array<{ target: unknown[] }>;
  }>,
): string[] {
  return violations
    .filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    )
    .flatMap((violation) =>
      violation.nodes.map(
        (node) => `${violation.id} at ${JSON.stringify(node.target)}`,
      ),
    );
}
