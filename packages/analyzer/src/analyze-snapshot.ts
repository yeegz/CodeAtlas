import { createHash } from "node:crypto";

import type {
  EvidenceItem,
  EvidenceType,
  SourceLocation,
} from "@codeatlas/evidence";
import ts from "typescript";

import { readSnapshotFiles } from "./snapshot-digest.js";
import type {
  AnalyzedBranch,
  AnalyzedContract,
  AnalyzedEdge,
  AnalyzedFile,
  AnalyzedSymbol,
  AnalyzedTest,
  SnapshotAnalysis,
} from "./types.js";

const SOURCE_PATTERNS = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"];
const OBSERVED_AT = "1970-01-01T00:00:00.000Z";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(
  snapshotSha: string,
  path: string,
  kind: string,
  qualifiedName: string,
): string {
  return sha256(`${snapshotSha}:${path}:${kind}:${qualifiedName}`);
}

function locationOf(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  snapshotSha: string,
  path: string,
): SourceLocation {
  const startLine =
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;
  const endPosition = Math.max(node.getStart(sourceFile), node.end - 1);
  const endLine =
    sourceFile.getLineAndCharacterOfPosition(endPosition).line + 1;
  return { snapshotSha, path, startLine, endLine };
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
        true
    : false;
}

function declarationName(node: ts.NamedDeclaration): string | null {
  if (!node.name) return null;
  if (
    ts.isIdentifier(node.name) ||
    ts.isStringLiteral(node.name) ||
    ts.isNumericLiteral(node.name)
  ) {
    return node.name.text;
  }
  return node.name.getText();
}

function declarationSignature(
  checker: ts.TypeChecker,
  node: ts.Declaration,
): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    const signature = checker.getSignatureFromDeclaration(node);
    if (signature)
      return checker.signatureToString(
        signature,
        node,
        ts.TypeFormatFlags.NoTruncation,
      );
  }
  const named = node as ts.NamedDeclaration;
  if (named.name) {
    const symbol = checker.getSymbolAtLocation(named.name);
    if (symbol)
      return checker.typeToString(
        checker.getTypeOfSymbolAtLocation(symbol, node),
        node,
        ts.TypeFormatFlags.NoTruncation,
      );
  }
  return node.getText().split("{")[0]?.trim() ?? node.getText().trim();
}

function evidenceFor(
  id: string,
  type: EvidenceType,
  source: SourceLocation,
  fileDigest: string,
): EvidenceItem {
  return {
    id,
    type,
    origin: "@codeatlas/analyzer",
    observedAt: OBSERVED_AT,
    reproducibility: "REPRODUCIBLE",
    source,
    artifactDigest: `sha256:${fileDigest}`,
  };
}

function testName(node: ts.CallExpression): string | null {
  if (
    !ts.isIdentifier(node.expression) ||
    !["it", "test"].includes(node.expression.text)
  )
    return null;
  const firstArgument = node.arguments[0];
  return firstArgument &&
    (ts.isStringLiteral(firstArgument) ||
      ts.isNoSubstitutionTemplateLiteral(firstArgument))
    ? firstArgument.text
    : null;
}

function branchKind(node: ts.Node): AnalyzedBranch["kind"] | null {
  if (ts.isIfStatement(node)) return "if";
  if (ts.isConditionalExpression(node)) return "conditional";
  if (ts.isSwitchStatement(node)) return "switch";
  if (ts.isCatchClause(node)) return "catch";
  return null;
}

export async function analyzeSnapshot(input: {
  root: string;
  snapshotSha: string;
}): Promise<SnapshotAnalysis> {
  if (!/^[0-9a-f]{40}$/.test(input.snapshotSha)) {
    throw new Error(
      "snapshotSha must be a 40-character lowercase hexadecimal value",
    );
  }

  const snapshot = await readSnapshotFiles(input.root, SOURCE_PATTERNS);
  const pathByAbsolutePath = new Map(
    snapshot.files.map((file) => [file.absolutePath, file.path]),
  );
  const fileByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const program = ts.createProgram({
    rootNames: snapshot.files.map((file) => file.absolutePath),
    options: {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      noEmit: true,
      noLib: true,
      noResolve: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2023,
    },
  });
  const checker = program.getTypeChecker();
  const files: AnalyzedFile[] = snapshot.files.map((file) => ({
    id: stableId(input.snapshotSha, file.path, "file", file.path),
    path: file.path,
    digest: `sha256:${file.digest}`,
    text: file.text,
  }));
  const symbols: AnalyzedSymbol[] = [];
  const edges: AnalyzedEdge[] = [];
  const tests: AnalyzedTest[] = [];
  const contracts: AnalyzedContract[] = [];
  const branches: AnalyzedBranch[] = [];
  const evidence: EvidenceItem[] = [];
  const symbolByDeclaration = new Map<ts.Declaration, AnalyzedSymbol>();

  function addEvidence(
    path: string,
    kind: string,
    qualifiedName: string,
    type: EvidenceType,
    source: SourceLocation,
  ): string {
    const id = stableId(
      input.snapshotSha,
      path,
      `evidence:${kind}`,
      qualifiedName,
    );
    const file = fileByPath.get(path);
    if (!file) throw new Error(`Missing source file for evidence: ${path}`);
    evidence.push(evidenceFor(id, type, source, file.digest));
    return id;
  }

  function addSymbol(
    sourceFile: ts.SourceFile,
    path: string,
    node: ts.Declaration & ts.NamedDeclaration,
    kind: string,
    qualifiedName: string,
  ): void {
    const name = declarationName(node);
    if (!name) return;
    const source = locationOf(sourceFile, node, input.snapshotSha, path);
    const signature = declarationSignature(checker, node);
    const evidenceId = addEvidence(
      path,
      kind,
      qualifiedName,
      "STATIC_AST",
      source,
    );
    const symbol: AnalyzedSymbol = {
      id: stableId(input.snapshotSha, path, kind, qualifiedName),
      kind,
      label: name,
      name,
      qualifiedName,
      snapshotSha: input.snapshotSha,
      source,
      evidenceIds: [evidenceId],
      signature,
      signatureDigest: `sha256:${sha256(signature)}`,
    };
    symbols.push(symbol);
    symbolByDeclaration.set(node, symbol);

    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      contracts.push({
        id: stableId(input.snapshotSha, path, "contract", qualifiedName),
        symbolId: symbol.id,
        name,
        signature,
        signatureDigest: symbol.signatureDigest,
        source,
        evidenceIds: [evidenceId],
      });
    }
  }

  for (const sourceFile of program.getSourceFiles()) {
    const path = pathByAbsolutePath.get(sourceFile.fileName);
    if (!path) continue;
    const fileId = stableId(input.snapshotSha, path, "file", path);

    for (const statement of sourceFile.statements) {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name &&
        hasExportModifier(statement)
      ) {
        addSymbol(sourceFile, path, statement, "function", statement.name.text);
      } else if (
        ts.isClassDeclaration(statement) &&
        statement.name &&
        hasExportModifier(statement)
      ) {
        addSymbol(sourceFile, path, statement, "class", statement.name.text);
        for (const member of statement.members) {
          if (ts.isMethodDeclaration(member) && member.name) {
            addSymbol(
              sourceFile,
              path,
              member,
              "method",
              `${statement.name.text}.${declarationName(member) ?? "method"}`,
            );
          }
        }
      } else if (
        ts.isInterfaceDeclaration(statement) &&
        hasExportModifier(statement)
      ) {
        addSymbol(
          sourceFile,
          path,
          statement,
          "interface",
          statement.name.text,
        );
      }

      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const source = locationOf(
          sourceFile,
          statement,
          input.snapshotSha,
          path,
        );
        const evidenceId = addEvidence(
          path,
          "import",
          statement.moduleSpecifier.text,
          "STATIC_AST",
          source,
        );
        const target = stableId(
          input.snapshotSha,
          path,
          "module",
          statement.moduleSpecifier.text,
        );
        edges.push({
          id: stableId(
            input.snapshotSha,
            path,
            "edge:IMPORTS",
            `${path}:${statement.moduleSpecifier.text}`,
          ),
          from: fileId,
          to: target,
          fromName: path,
          toName: statement.moduleSpecifier.text,
          relation: "IMPORTS",
          evidenceIds: [evidenceId],
          evidenceType: "STATIC_AST",
          snapshotSha: input.snapshotSha,
        });
      }
    }
  }

  for (const symbol of symbols) {
    edges.push({
      id: stableId(
        input.snapshotSha,
        symbol.source.path,
        "edge:EXPORTS",
        symbol.qualifiedName,
      ),
      from: stableId(
        input.snapshotSha,
        symbol.source.path,
        "file",
        symbol.source.path,
      ),
      to: symbol.id,
      fromName: symbol.source.path,
      toName: symbol.name,
      relation: "EXPORTS",
      evidenceIds: [...symbol.evidenceIds],
      evidenceType: "STATIC_AST",
      snapshotSha: input.snapshotSha,
    });
  }

  function analyzedSymbolFor(
    symbol: ts.Symbol | undefined,
  ): AnalyzedSymbol | undefined {
    if (!symbol) return undefined;
    const resolved =
      (symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    for (const declaration of resolved.declarations ?? []) {
      const analyzed = symbolByDeclaration.get(declaration);
      if (analyzed) return analyzed;
    }
    return undefined;
  }

  for (const sourceFile of program.getSourceFiles()) {
    const path = pathByAbsolutePath.get(sourceFile.fileName);
    if (!path) continue;
    let currentSymbol: AnalyzedSymbol | undefined;

    const visit = (node: ts.Node): void => {
      const previousSymbol = currentSymbol;
      const nodeSymbol = symbolByDeclaration.get(node as ts.Declaration);
      if (nodeSymbol) currentSymbol = nodeSymbol;

      const kind = branchKind(node);
      if (kind) {
        const source = locationOf(sourceFile, node, input.snapshotSha, path);
        const qualifiedName = `${kind}:${source.startLine}:${source.endLine}`;
        const evidenceId = addEvidence(
          path,
          "branch",
          qualifiedName,
          "STATIC_AST",
          source,
        );
        branches.push({
          id: stableId(input.snapshotSha, path, "branch", qualifiedName),
          kind,
          source,
          evidenceIds: [evidenceId],
        });
      }

      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) {
        if (ts.isCallExpression(node)) {
          const name = testName(node);
          if (name) {
            const source = locationOf(
              sourceFile,
              node,
              input.snapshotSha,
              path,
            );
            const qualifiedName = `${name}:${source.startLine}`;
            const evidenceId = addEvidence(
              path,
              "test",
              qualifiedName,
              "STATIC_AST",
              source,
            );
            tests.push({
              id: stableId(input.snapshotSha, path, "test", qualifiedName),
              name,
              path,
              source,
              evidenceIds: [evidenceId],
            });
          }
        }
      }

      if (currentSymbol && ts.isCallExpression(node)) {
        const target = analyzedSymbolFor(
          checker.getSymbolAtLocation(node.expression),
        );
        if (target) {
          const source = locationOf(sourceFile, node, input.snapshotSha, path);
          const qualifiedName = `${currentSymbol.qualifiedName}:${target.qualifiedName}:${source.startLine}`;
          const evidenceId = addEvidence(
            path,
            "call",
            qualifiedName,
            "STATIC_CALLGRAPH",
            source,
          );
          edges.push({
            id: stableId(input.snapshotSha, path, "edge:CALLS", qualifiedName),
            from: currentSymbol.id,
            to: target.id,
            fromName: currentSymbol.name,
            toName: target.name,
            relation: "CALLS",
            evidenceIds: [evidenceId],
            evidenceType: "STATIC_CALLGRAPH",
            snapshotSha: input.snapshotSha,
          });
        }
      }

      ts.forEachChild(node, visit);
      currentSymbol = previousSymbol;
    };
    visit(sourceFile);
  }

  const compareSource = <T extends { source: SourceLocation }>(
    left: T,
    right: T,
  ): number =>
    compareText(left.source.path, right.source.path) ||
    left.source.startLine - right.source.startLine ||
    left.source.endLine - right.source.endLine;
  symbols.sort(compareSource);
  tests.sort(compareSource);
  contracts.sort(compareSource);
  branches.sort(compareSource);
  evidence.sort((left, right) => compareText(left.id, right.id));
  edges.sort((left, right) => compareText(left.id, right.id));

  return {
    snapshotSha: input.snapshotSha,
    files,
    symbols,
    edges,
    tests,
    contracts,
    branches,
    evidence,
  };
}
