import type { WorkspaceModel, WorkspaceProofCard } from "@/lib/demo-store";

const STATE_TEXT: Readonly<Record<string, string>> = {
  CONFIRMED_REGRESSION: "Confirmed regression",
  CONFIRMED_CHANGE: "Confirmed change",
  PROBABLE_IMPACT: "Probable impact",
  POSSIBLE_IMPACT: "Possible impact",
  UNVERIFIED: "Unverified",
  RESOLVED: "Resolved",
  ACCEPTED_CHANGE: "Accepted change",
};

export function ProofCard({
  card,
  model,
}: {
  card: WorkspaceProofCard;
  model: WorkspaceModel;
}) {
  return (
    <section
      className="panel proof-card reveal-card"
      aria-labelledby="proof-card-heading"
    >
      <div>
        <p className="label">{STATE_TEXT[card.state] ?? card.state}</p>
        <h2 id="proof-card-heading">{card.title}</h2>
      </div>

      <p>{card.summary}</p>

      <dl className="behavior-pair">
        <div data-revision="base">
          <dt>Base</dt>
          <dd>{card.baseBehavior}</dd>
        </div>
        <div data-revision="head">
          <dt>Head</dt>
          <dd>{card.headBehavior}</dd>
        </div>
      </dl>

      <div>
        <p className="label">Affected journey</p>
        <p>{card.affectedJourney}</p>
      </div>

      {card.graphPath === null ? null : (
        <div>
          <p className="label">Evidence path</p>
          <p className="mono">{card.graphPath}</p>
        </div>
      )}

      {card.confidenceLevel === null ? null : (
        <div>
          <p className="label">Confidence: {card.confidenceLevel}</p>
          <ul className="factor-list">
            {card.confidenceFactors.map((factor) => (
              <li key={factor}>{factor}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="label">Recommended action</p>
        <p>{card.recommendedAction}</p>
      </div>

      <div>
        <p className="label">Reproduce</p>
        <code className="replay-command">{card.reproductionCommand}</code>
      </div>

      <div>
        <p className="label">Limitations</p>
        {card.limitations.length === 0 ? (
          <p className="integrity-note">
            Every confirmation gate passed for this finding. CodeAtlas still
            does not certify that the change is safe to merge.
          </p>
        ) : (
          <ul className="limitations">
            {card.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="label">Citations</p>
        <p className="sha">
          base {model.baseSha}
          <br />
          head {model.headSha}
        </p>
        <p className="integrity-note">
          {card.evidenceIds.length} evidence items, manifest{" "}
          <span className="sha">{model.manifestDigest}</span>
        </p>
      </div>
    </section>
  );
}
