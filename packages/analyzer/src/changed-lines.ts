import { diffLines } from "diff";

import type {
  AnalyzedSymbol,
  ChangedSymbol,
  SnapshotAnalysis,
} from "./types.js";

interface LineSpans {
  base: Array<{ start: number; end: number }>;
  head: Array<{ start: number; end: number }>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function changedSpans(baseText: string, headText: string): LineSpans {
  const spans: LineSpans = { base: [], head: [] };
  let baseLine = 1;
  let headLine = 1;

  for (const change of diffLines(baseText, headText)) {
    const count = change.count ?? 0;
    if (change.added) {
      if (count > 0)
        spans.head.push({ start: headLine, end: headLine + count - 1 });
      headLine += count;
    } else if (change.removed) {
      if (count > 0)
        spans.base.push({ start: baseLine, end: baseLine + count - 1 });
      baseLine += count;
    } else {
      baseLine += count;
      headLine += count;
    }
  }

  return spans;
}

function symbolKey(symbol: AnalyzedSymbol): string {
  return `${symbol.source.path}\u0000${symbol.kind}\u0000${symbol.qualifiedName}`;
}

function intersectingLines(
  symbol: AnalyzedSymbol | undefined,
  spans: Array<{ start: number; end: number }>,
): number[] {
  if (!symbol) return [];
  const lines: number[] = [];
  for (const span of spans) {
    const start = Math.max(symbol.source.startLine, span.start);
    const end = Math.min(symbol.source.endLine, span.end);
    for (let line = start; line <= end; line += 1) lines.push(line);
  }
  return lines;
}

export function mapChangedSymbols(
  base: SnapshotAnalysis,
  head: SnapshotAnalysis,
): ChangedSymbol[] {
  const baseFiles = new Map(base.files.map((file) => [file.path, file.text]));
  const headFiles = new Map(head.files.map((file) => [file.path, file.text]));
  const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort(
    compareText,
  );
  const spansByPath = new Map<string, LineSpans>();
  for (const path of paths) {
    const baseText = baseFiles.get(path);
    const headText = headFiles.get(path);
    if (baseText === undefined) {
      const lineCount =
        headText === "" ? 0 : (headText?.match(/\n/g)?.length ?? 0) + 1;
      spansByPath.set(path, {
        base: [],
        head: lineCount === 0 ? [] : [{ start: 1, end: lineCount }],
      });
    } else if (headText === undefined) {
      const lineCount =
        baseText === "" ? 0 : (baseText.match(/\n/g)?.length ?? 0) + 1;
      spansByPath.set(path, {
        base: lineCount === 0 ? [] : [{ start: 1, end: lineCount }],
        head: [],
      });
    } else {
      spansByPath.set(path, changedSpans(baseText, headText));
    }
  }

  const baseSymbols = new Map(
    base.symbols.map((symbol) => [symbolKey(symbol), symbol]),
  );
  const headSymbols = new Map(
    head.symbols.map((symbol) => [symbolKey(symbol), symbol]),
  );
  const keys = new Set([...baseSymbols.keys(), ...headSymbols.keys()]);
  const changed: ChangedSymbol[] = [];

  for (const key of keys) {
    const baseSymbol = baseSymbols.get(key);
    const headSymbol = headSymbols.get(key);
    const symbol = headSymbol ?? baseSymbol;
    if (!symbol) continue;
    const spans = spansByPath.get(symbol.source.path) ?? { base: [], head: [] };
    const changedLines = [
      ...new Set([
        ...intersectingLines(baseSymbol, spans.base),
        ...intersectingLines(headSymbol, spans.head),
      ]),
    ].sort((left, right) => left - right);
    const signatureChanged =
      baseSymbol?.signatureDigest !== headSymbol?.signatureDigest;
    if (changedLines.length === 0 && !signatureChanged) continue;

    changed.push({
      id: symbol.id,
      name: symbol.name,
      path: symbol.source.path,
      baseLocation: baseSymbol?.source ?? null,
      headLocation: headSymbol?.source ?? null,
      changedLines,
      signatureChanged,
    });
  }

  changed.sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      (left.headLocation?.startLine ?? left.baseLocation?.startLine ?? 0) -
        (right.headLocation?.startLine ?? right.baseLocation?.startLine ?? 0) ||
      compareText(left.name, right.name),
  );
  return changed;
}
