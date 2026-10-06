import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";

import { EvidenceWorkspace } from "@/components/evidence-map";
import { PassportBar } from "@/components/passport-bar";
import { runDemoAnalysis, type WorkspaceModel } from "@/lib/demo-store";

const ANALYSIS_TIMEOUT_MS = 600_000;

let model: WorkspaceModel;

beforeAll(async () => {
  // The workspace must render a real terminal analysis, never a fixture
  // Passport checked into the repository.
  model = await runDemoAnalysis();
}, ANALYSIS_TIMEOUT_MS);

describe("Passport bar", () => {
  it("states the overall result and derived counts", () => {
    render(<PassportBar model={model} />);
    expect(screen.getByText("Action required")).toBeInTheDocument();
    expect(screen.getByText("Confirmed regressions")).toBeInTheDocument();
    expect(model.summary.findings.confirmedRegressions).toBe(1);
    expect(
      screen.getByText(
        `${model.summary.runs.completed}/${model.summary.runs.total}`,
      ),
    ).toBeInTheDocument();
  });
});

describe("Evidence workspace", () => {
  it("names the impacted area and the confirmed finding", () => {
    render(<EvidenceWorkspace model={model} />);
    expect(
      screen.getByRole("heading", { name: "Authentication impact" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Expired sessions return an internal error",
      }),
    ).toBeInTheDocument();
  });

  it("shows both observed behaviours and the replay command", () => {
    render(<EvidenceWorkspace model={model} />);
    expect(
      screen.getByText("HTTP 401 with SESSION_EXPIRED"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("HTTP 500 with INTERNAL_ERROR"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/^codeatlas replay finding_expired_session$/u),
    ).toBeInTheDocument();
  });

  it("labels every map node with its entity, evidence state and path", () => {
    render(<EvidenceWorkspace model={model} />);
    const changed = screen.getByRole("button", {
      name: "validateToken(), changed, src/auth.ts",
    });
    expect(changed).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "test/codeatlas.expired-session.test.ts, failed at runtime",
      }),
    ).toBeInTheDocument();
  });

  it("exposes the same nodes through a list alternative without SVG", async () => {
    const user = userEvent.setup();
    const { container } = render(<EvidenceWorkspace model={model} />);
    expect(container.querySelector("svg")).not.toBeNull();

    await user.click(
      screen.getByRole("button", { name: "View impact as list" }),
    );

    const list = screen.getByRole("list", { name: "Affected code path" });
    expect(within(list).getByText("validateToken()")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();

    for (const node of model.nodes) {
      expect(within(list).getByText(node.label)).toBeInTheDocument();
    }
  });

  it("keeps observed evidence distinct from inferred evidence in the list", async () => {
    const user = userEvent.setup();
    render(<EvidenceWorkspace model={model} />);
    await user.click(
      screen.getByRole("button", { name: "View impact as list" }),
    );

    const relationships = screen.getByRole("list", {
      name: "Evidence relationships",
    });
    const entries = within(relationships).getAllByRole("listitem");
    const observed = entries.filter(
      (entry) => entry.dataset.observed === "true",
    );
    const inferred = entries.filter(
      (entry) => entry.dataset.observed === "false",
    );
    expect(observed.length).toBeGreaterThan(0);
    expect(inferred.length).toBeGreaterThan(0);
    for (const entry of inferred) {
      expect(entry.textContent).toContain("inferred");
    }
  });

  it("never presents a confirmed finding without citations", () => {
    render(<EvidenceWorkspace model={model} />);
    const card = model.proofCards[0];
    expect(card?.state).toBe("CONFIRMED_REGRESSION");
    expect(card?.evidenceIds.length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        new RegExp(`${card!.evidenceIds.length} evidence items`, "u"),
      ),
    ).toBeInTheDocument();
  });
});
