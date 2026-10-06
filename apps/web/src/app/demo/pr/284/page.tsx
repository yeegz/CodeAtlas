import { EvidenceWorkspace } from "@/components/evidence-map";
import { PassportBar } from "@/components/passport-bar";
import { RunDemoButton } from "@/components/run-demo-button";
import { WorkspaceNav } from "@/components/workspace-nav";
import { getDemoModel } from "@/lib/demo-store";

export const dynamic = "force-dynamic";

/**
 * The workspace renders the stored terminal analysis. It never imports a
 * hard-coded Passport: with no analysis in this process it offers to run one.
 */
export default function ImpactWorkspacePage() {
  const model = getDemoModel();

  if (model === undefined) {
    return (
      <div className="workspace">
        <WorkspaceNav current="/demo/pr/284" />
        <main className="workspace-main">
          <div className="workspace-body">
            <section className="panel" aria-labelledby="no-analysis">
              <h1 id="no-analysis">No analysis to display</h1>
              <p className="promise">
                No comparison has reached a terminal state in this process, so
                there is no evidence to render.
              </p>
              {process.env.CODEATLAS_DEMO_MODE === "true" ? (
                <RunDemoButton />
              ) : (
                <p className="error-note">
                  Demo mode is disabled. Start the app with
                  CODEATLAS_DEMO_MODE=true to run a local analysis.
                </p>
              )}
            </section>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="workspace">
      <WorkspaceNav current="/demo/pr/284" />
      <main className="workspace-main">
        <h1 className="visually-hidden">
          Impact workspace for {model.impactTitle}
        </h1>
        <PassportBar model={model} />
        <EvidenceWorkspace model={model} />
      </main>
    </div>
  );
}
