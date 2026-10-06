import { RunDemoButton } from "@/components/run-demo-button";
import { getDemoModel } from "@/lib/demo-store";

export const dynamic = "force-dynamic";

/**
 * Repository state, not a metric dashboard: what is verified right now, what
 * is not, and the one action available.
 */
export default function RepositoryStatePage() {
  const model = getDemoModel();
  const demoEnabled = process.env.CODEATLAS_DEMO_MODE === "true";

  return (
    <main className="landing">
      <header className="landing-header">
        <p className="label">Repository state</p>
        <h1>fixtures/auth-regression</h1>
        <p className="promise">
          CodeAtlas produces reproducible evidence for a base and head
          comparison and distinguishes observed behaviour from inference. It
          does not certify that a change is safe to merge and does not replace
          human review.
        </p>
      </header>

      {model === undefined ? (
        <section className="panel" aria-labelledby="no-analysis">
          <h2 id="no-analysis">No verified analysis yet</h2>
          <p className="promise">
            Nothing has been executed for this repository in this process, so
            there is no evidence to show. Running the demo analyses the seeded
            authentication comparison with the real pipeline: it maps the
            change, selects and executes existing tests on both revisions,
            generates one evidence-targeted regression test, compares observed
            behaviour, and signs a Change Passport.
          </p>
          {demoEnabled ? (
            <RunDemoButton />
          ) : (
            <p className="error-note">
              Demo mode is disabled. Start the app with CODEATLAS_DEMO_MODE=true
              to run a local analysis.
            </p>
          )}
        </section>
      ) : (
        <section className="panel" aria-labelledby="current-analysis">
          <h2 id="current-analysis">Current verification state</h2>
          <div className="state-line">
            <span className="passport-state" data-state={model.overallState}>
              {model.overallState === "ACTION_REQUIRED"
                ? "Action required"
                : model.overallState === "VERIFIED"
                  ? "Verified"
                  : "Incomplete"}
            </span>
            <a href="/demo/pr/284">Open the impact workspace</a>
          </div>
          <div className="landing-grid">
            <div>
              <p className="label">Confirmed regressions</p>
              <p>{model.summary.findings.confirmedRegressions}</p>
            </div>
            <div>
              <p className="label">Changed files</p>
              <p>{model.changedFiles.join(", ")}</p>
            </div>
            <div>
              <p className="label">Base</p>
              <p className="sha">{model.baseSha}</p>
            </div>
            <div>
              <p className="label">Head</p>
              <p className="sha">{model.headSha}</p>
            </div>
          </div>
        </section>
      )}

      <section className="panel" aria-labelledby="scope">
        <h2 id="scope">What this milestone covers</h2>
        <p className="promise">
          This build is the local evidence core: static mapping, test selection,
          bounded local execution, evidence-targeted generation, differential
          comparison, signed Change Passports and one-command replay. Hosted
          sign-in, GitHub App installation, sandboxed execution and retention
          controls are later milestones and are not available here.
        </p>
      </section>
    </main>
  );
}
