"use client";

import { useMemo, useState } from "react";

import type {
  WorkspaceEdge,
  WorkspaceModel,
  WorkspaceNode,
} from "@/lib/demo-store";
import { ProofCard } from "@/components/proof-card";

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 340;
const BAND_X: Readonly<Record<number, number>> = { 0: 800, 1: 500, 2: 170 };

const STATE_TEXT: Readonly<Record<string, string>> = {
  CHANGED: "changed",
  OBSERVED: "observed at runtime",
  FAILED: "failed at runtime",
  INFERRED: "inferred, not executed",
  UNCHANGED: "unchanged",
};

/** Shape and text carry the state; colour only reinforces it. */
const LEGEND = [
  { state: "CHANGED", text: "Square, Route Cobalt: changed" },
  { state: "OBSERVED", text: "Circle, Observed Teal: executed" },
  { state: "FAILED", text: "Triangle, Fault Red: failed on head" },
  { state: "INFERRED", text: "Dashed diamond, Contour Slate: inferred" },
] as const;

interface Placed {
  node: WorkspaceNode;
  x: number;
  y: number;
}

export function EvidenceWorkspace({ model }: { model: WorkspaceModel }) {
  const [view, setView] = useState<"map" | "list">("map");
  const [selectedId, setSelectedId] = useState<string | null>(
    model.proofCards[0]?.findingId ?? null,
  );

  const placed = useMemo(() => placeNodes(model.nodes), [model.nodes]);
  const positions = useMemo(
    () => new Map(placed.map((item) => [item.node.id, item])),
    [placed],
  );

  const selectedCard =
    model.proofCards.find((card) => card.findingId === selectedId) ??
    model.proofCards[0];

  return (
    <div className="workspace-body">
      <section className="map-region" aria-labelledby="impact-heading">
        <div className="map-header">
          <div>
            <h2 id="impact-heading">{model.impactTitle}</h2>
            <p className="integrity-note">
              Observed evidence is drawn solid. Inferred relationships stay
              dotted and are never presented as executed behaviour.
            </p>
          </div>
          <button
            type="button"
            className="action-quiet"
            onClick={() => setView(view === "map" ? "list" : "map")}
          >
            {view === "map" ? "View impact as list" : "View impact as map"}
          </button>
        </div>

        {view === "map" ? (
          <div className="map-canvas">
            <div
              className="map-figure"
              role="group"
              aria-label={`Evidence map for ${model.impactTitle}`}
            >
              <svg
                viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
                preserveAspectRatio="none"
                aria-hidden="true"
                focusable="false"
              >
                <ContourBands placed={placed} />
                <g className="reveal-edge">
                  {model.edges.map((edge) => (
                    <EdgeLine key={edge.id} edge={edge} positions={positions} />
                  ))}
                </g>
              </svg>
              {placed.map(({ node, x, y }) => (
                <button
                  key={node.id}
                  type="button"
                  className={`map-node reveal-band-${node.band}`}
                  data-state={node.state}
                  style={{
                    left: `${(x / VIEW_WIDTH) * 100}%`,
                    top: `${(y / VIEW_HEIGHT) * 100}%`,
                  }}
                  aria-pressed={node.id === selectedId}
                  aria-label={nodeLabel(node)}
                  onClick={() => setSelectedId(node.id)}
                >
                  <span className="map-node-mark" aria-hidden="true" />
                  <span className="map-node-label">{node.label}</span>
                  <span className="map-node-state">
                    {STATE_TEXT[node.state] ?? node.state}
                  </span>
                </button>
              ))}
            </div>
            <ul className="map-legend">
              {LEGEND.map((item) => (
                <li key={item.state}>
                  <span>
                    <span
                      className="map-node-mark"
                      data-legend={item.state}
                      aria-hidden="true"
                    />
                    {item.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ImpactList model={model} />
        )}

        <SelectionReasons model={model} />
      </section>

      {selectedCard === undefined ? (
        <section className="panel proof-card" aria-label="Proof Card">
          <h2>No findings</h2>
          <p>This comparison produced no findings that require a Proof Card.</p>
        </section>
      ) : (
        <ProofCard card={selectedCard} model={model} />
      )}
    </div>
  );
}

/**
 * The list view is an equivalent, not a fallback: it carries the same nodes,
 * the same evidence states and the same relationships as the map.
 */
function ImpactList({ model }: { model: WorkspaceModel }) {
  return (
    <div>
      <ul className="impact-list" aria-label="Affected code path">
        {model.nodes.map((node) => (
          <li key={node.id}>
            <span className="impact-entry-head">
              <span className="impact-entry-name">{node.label}</span>
              <span className="state-tag" data-state={node.state}>
                {STATE_TEXT[node.state] ?? node.state}
              </span>
              <span className="label">distance band {node.band}</span>
            </span>
            {node.path === node.label ? null : (
              <span className="sha">{node.path}</span>
            )}
            <span>{node.detail}</span>
          </li>
        ))}
      </ul>
      <h3 style={{ marginTop: "1rem" }}>Relationships</h3>
      <ul className="edge-list" aria-label="Evidence relationships">
        {model.edges.map((edge) => (
          <li key={edge.id} data-observed={edge.observed}>
            <span className="impact-entry-name">
              {edge.from.split(":").slice(1).join(":")} → {edge.relation} →{" "}
              {edge.to.split(":").slice(1).join(":")}
            </span>
            <span className="label">
              {edge.evidenceType} · {edge.observed ? "observed" : "inferred"}
            </span>
            <span>{edge.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SelectionReasons({ model }: { model: WorkspaceModel }) {
  return (
    <section className="panel" aria-labelledby="selection-heading">
      <h3 id="selection-heading">Why these tests ran</h3>
      <ul className="edge-list">
        {model.selections.map((selection) => (
          <li key={selection.path} data-observed="true">
            <span className="impact-entry-name">{selection.path}</span>
            {selection.reasons.map((reason) => (
              <span key={reason}>{reason}</span>
            ))}
          </li>
        ))}
        {model.generatedTests.map((test) => (
          <li key={test.path} data-observed="true">
            <span className="impact-entry-name">{test.path}</span>
            <span className="label">generated</span>
            <span>
              Executed on base: {test.executedOnBase ? "yes" : "no"}. Executed
              on head: {test.executedOnHead ? "yes" : "no"}.
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ContourBands({ placed }: { placed: Placed[] }) {
  const centre = placed.find((item) => item.node.band === 0);
  if (centre === undefined) return null;
  return (
    <g aria-hidden="true">
      {[220, 430, 640].map((radius) => (
        <ellipse
          key={radius}
          cx={centre.x}
          cy={centre.y}
          rx={radius}
          ry={radius * 0.42}
          fill="none"
          stroke="#6f8a90"
          strokeOpacity={0.35}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}

function EdgeLine({
  edge,
  positions,
}: {
  edge: WorkspaceEdge;
  positions: Map<string, Placed>;
}) {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  if (from === undefined || to === undefined) return null;
  return (
    <line
      x1={from.x}
      y1={from.y}
      x2={to.x}
      y2={to.y}
      stroke={edge.observed ? "#55d5aa" : "#6f8a90"}
      strokeWidth={edge.observed ? 2 : 1.5}
      strokeDasharray={edge.observed ? undefined : "3 5"}
      vectorEffect="non-scaling-stroke"
    />
  );
}

/**
 * Entity, evidence state and affected path. Test nodes are named by their path
 * already, so it is not repeated.
 */
function nodeLabel(node: WorkspaceNode): string {
  const state = STATE_TEXT[node.state] ?? node.state;
  return node.path === node.label
    ? `${node.label}, ${state}`
    : `${node.label}, ${state}, ${node.path}`;
}

/** Deterministic layout: distance band drives x, order within a band drives y. */
function placeNodes(nodes: readonly WorkspaceNode[]): Placed[] {
  const byBand = new Map<number, WorkspaceNode[]>();
  for (const node of nodes) {
    const bucket = byBand.get(node.band) ?? [];
    bucket.push(node);
    byBand.set(node.band, bucket);
  }
  const placed: Placed[] = [];
  for (const [band, bucket] of [...byBand.entries()].sort(
    (left, right) => left[0] - right[0],
  )) {
    for (const [index, node] of bucket.entries()) {
      placed.push({
        node,
        x: BAND_X[band] ?? 500,
        y: (VIEW_HEIGHT * (index + 1)) / (bucket.length + 1),
      });
    }
  }
  return placed;
}
