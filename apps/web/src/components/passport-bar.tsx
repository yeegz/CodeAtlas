import type { WorkspaceModel } from "@/lib/demo-store";

const STATE_TEXT: Readonly<Record<WorkspaceModel["overallState"], string>> = {
  ACTION_REQUIRED: "Action required",
  INCOMPLETE: "Incomplete",
  VERIFIED: "Verified",
};

const STATE_MARK: Readonly<Record<WorkspaceModel["overallState"], string>> = {
  ACTION_REQUIRED: "!",
  INCOMPLETE: "?",
  VERIFIED: "=",
};

/** Every number here is derived from the Passport, never authored. */
export function PassportBar({ model }: { model: WorkspaceModel }) {
  const { findings, runs, tests } = model.summary;
  return (
    <div className="passport-bar">
      <p className="passport-state" data-state={model.overallState}>
        <span aria-hidden="true">{STATE_MARK[model.overallState]}</span>
        {STATE_TEXT[model.overallState]}
      </p>
      <dl className="passport-counts">
        <div>
          <dt className="label">Confirmed regressions</dt>
          <dd>{findings.confirmedRegressions}</dd>
        </div>
        <div>
          <dt className="label">Confirmed changes</dt>
          <dd>{findings.confirmedChanges}</dd>
        </div>
        <div>
          <dt className="label">Unverified</dt>
          <dd>{findings.unverified}</dd>
        </div>
        <div>
          <dt className="label">Completed runs</dt>
          <dd>
            {runs.completed}/{runs.total}
          </dd>
        </div>
        <div>
          <dt className="label">Tests executed</dt>
          <dd>
            {tests.executedOnBase}/{tests.executedOnHead}
          </dd>
        </div>
        <div>
          <dt className="label">Generated tests</dt>
          <dd>{tests.generated}</dd>
        </div>
      </dl>
      <p className="sha">
        {model.baseSha.slice(0, 12)} → {model.headSha.slice(0, 12)} · engine{" "}
        {model.engineVersion} · retention {model.retentionPolicy}
      </p>
    </div>
  );
}
