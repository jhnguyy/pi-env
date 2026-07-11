import { createHash } from "node:crypto";
import { relative } from "node:path";
import ts from "typescript";
import { AnalyzerName, FindingKind, Severity, type Finding, type Location } from "./model.js";
import type { Project } from "./program.js";
import type { Scope } from "./scope.js";
import { intersectsHunks } from "./scope.js";

type BodyFunction = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };
type DuplicateGroup = { canonical: string; locations: Location[] };

const hasBody = (node: ts.Node): node is BodyFunction =>
  ts.isFunctionLike(node) && "body" in node && node.body !== undefined;

function functions(file: ts.SourceFile): BodyFunction[] {
  const output: BodyFunction[] = [];
  const visit = (node: ts.Node): void => {
    if (hasBody(node)) output.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return output;
}

function location(cwd: string, file: ts.SourceFile, node: ts.Node): Location {
  const start = file.getLineAndCharacterOfPosition(node.getStart(file));
  const end = file.getLineAndCharacterOfPosition(node.getEnd());
  return {
    path: relative(cwd, file.fileName).replaceAll("\\", "/"),
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

const changed = (scope: Scope, value: Location): boolean =>
  scope.mode === "all"
  || scope.files.includes(value.path)
    && intersectsHunks(value.line, value.endLine ?? value.line, scope.hunks.get(value.path));

function canonical(node: ts.Node): string {
  const parts: string[] = [];
  const visit = (child: ts.Node): void => {
    parts.push(String(child.kind));
    if (ts.isIdentifier(child)) parts.push("#id");
    else if (ts.isStringLiteral(child) || ts.isNumericLiteral(child)) parts.push("#literal");
    else if (child.getChildCount() === 0) parts.push(child.getText());
    ts.forEachChild(child, visit);
  };
  visit(node);
  return parts.join("|");
}

function isBranch(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node)) {
    return node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || node.operatorToken.kind === ts.SyntaxKind.BarBarToken;
  }
  return ts.isIfStatement(node)
    || ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
    || ts.isWhileStatement(node)
    || ts.isDoStatement(node)
    || ts.isCaseClause(node)
    || ts.isConditionalExpression(node)
    || ts.isCatchClause(node);
}

function functionComplexity(root: BodyFunction): { cyclomatic: number; cognitive: number } {
  let cyclomatic = 1;
  let cognitive = 0;
  let depth = 0;
  const visit = (node: ts.Node): void => {
    if (node !== root && ts.isFunctionLike(node)) return;
    const branch = isBranch(node);
    if (branch) {
      cyclomatic++;
      cognitive += 1 + depth;
      depth++;
    }
    ts.forEachChild(node, visit);
    if (branch) depth--;
  };
  visit(root);
  return { cyclomatic, cognitive };
}

export function complexity(project: Project, cwd: string, scope: Scope): Finding[] {
  const output: Finding[] = [];
  for (const file of project.files) {
    for (const fn of functions(file)) {
      const loc = location(cwd, file, fn);
      if (!changed(scope, loc)) continue;
      const score = functionComplexity(fn);
      if (score.cyclomatic >= 10) {
        output.push({
          id: "",
          analyzer: AnalyzerName.Complexity,
          kind: FindingKind.Complexity,
          severity: Severity.Warning,
          message: `Function complexity: cyclomatic ${score.cyclomatic}, cognitive ${score.cognitive}`,
          location: loc,
          data: score,
        });
      }
    }
  }
  return output;
}

export const ANALYZER_CAPS = {
  duplicateCandidates: 10_000,
  duplicateFindings: 100,
  typeCandidates: 5_000,
  typeBucketComparisons: 2_000,
  typeFindings: 50,
} as const;

const compareLocations = (left: Location, right: Location): number =>
  left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column;

function collectDuplicateGroups(project: Project, cwd: string): {
  groups: Map<string, DuplicateGroup>;
  truncated: boolean;
} {
  const groups = new Map<string, DuplicateGroup>();
  let candidates = 0;
  for (const file of project.files) {
    for (const fn of functions(file)) {
      if (candidates >= ANALYZER_CAPS.duplicateCandidates) {
        return { groups, truncated: true };
      }
      candidates++;
      const text = canonical(fn.body);
      if (text.length < 80) continue;
      const hash = createHash("sha256").update(text).digest("hex");
      const prior = groups.get(hash);
      if (prior === undefined) {
        groups.set(hash, { canonical: text, locations: [location(cwd, file, fn)] });
      } else if (prior.canonical === text) {
        // Verify the canonical text because hashes are only bucket keys.
        prior.locations.push(location(cwd, file, fn));
      }
    }
  }
  return { groups, truncated: false };
}

function duplicateFinding(group: DuplicateGroup, scope: Scope): Finding | undefined {
  const locations = [...group.locations].sort(compareLocations);
  const primary = locations.find((candidate) => changed(scope, candidate));
  if (primary === undefined || locations.length < 2) return undefined;
  const related = locations.filter((candidate) => candidate !== primary).slice(0, 25);
  return {
    id: "",
    analyzer: AnalyzerName.Duplicates,
    kind: FindingKind.Duplicate,
    severity: Severity.Warning,
    message: "Structurally duplicate function",
    location: primary,
    related,
  };
}

function truncationFinding(analyzer: AnalyzerName): Finding {
  const duplicate = analyzer === AnalyzerName.Duplicates;
  return {
    id: "",
    analyzer,
    kind: duplicate ? FindingKind.Duplicate : FindingKind.TypeSimilarity,
    severity: Severity.Info,
    message: duplicate
      ? "Duplicate analysis truncated at bounded candidate/finding limits"
      : "Type similarity analysis truncated at bounded candidate/comparison/finding limits",
    location: { path: ".", line: 1, column: 1 },
    data: { truncated: true },
  };
}

export function duplicates(project: Project, cwd: string, scope: Scope): Finding[] {
  const collected = collectDuplicateGroups(project, cwd);
  const output: Finding[] = [];
  let truncated = collected.truncated;
  for (const group of collected.groups.values()) {
    const finding = duplicateFinding(group, scope);
    if (finding === undefined) continue;
    if (output.length >= ANALYZER_CAPS.duplicateFindings) {
      truncated = true;
      break;
    }
    output.push(finding);
  }
  if (truncated) {
    if (output.length >= ANALYZER_CAPS.duplicateFindings) output.pop();
    output.push(truncationFinding(AnalyzerName.Duplicates));
  }
  return output;
}
interface TypeShape {
  properties: readonly string[];
  signatures: readonly string[];
  components: readonly string[];
  propertyCount: number;
  signatureCount: number;
  bucket: string;
}

const primitiveType = (type: ts.Type): string | undefined => {
  if (type.flags & ts.TypeFlags.StringLike) return type.isStringLiteral() ? `string:${type.value}` : "string";
  if (type.flags & ts.TypeFlags.NumberLike) return type.isNumberLiteral() ? `number:${type.value}` : "number";
  if (type.flags & ts.TypeFlags.BooleanLike) return type.flags & ts.TypeFlags.BooleanLiteral ? `boolean:${String((type as unknown as { intrinsicName: string }).intrinsicName)}` : "boolean";
  if (type.flags & ts.TypeFlags.BigIntLike) return "bigint";
  if (type.flags & ts.TypeFlags.Null) return "null";
  if (type.flags & ts.TypeFlags.Undefined) return "undefined";
  if (type.flags & ts.TypeFlags.Void) return "void";
  if (type.flags & ts.TypeFlags.Any) return "any";
  if (type.flags & ts.TypeFlags.Unknown) return "unknown";
  if (type.flags & ts.TypeFlags.Never) return "never";
  return undefined;
};

function propertyShapes(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth: number,
): string[] {
  return checker.getPropertiesOfType(type)
    .filter((property) => property.valueDeclaration !== undefined || property.declarations?.length)
    .map((property) => {
      const declaration = property.valueDeclaration ?? property.declarations![0]!;
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
      const readonly = ts.canHaveModifiers(declaration)
        && ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
        ? "r"
        : "";
      return `${property.name}${optional}${readonly}:${structuralType(checker, propertyType, declaration, depth)}`;
    })
    .sort();
}

function signatureShapes(checker: ts.TypeChecker, type: ts.Type, at: ts.Node): string[] {
  return [...type.getCallSignatures(), ...type.getConstructSignatures()]
    .map((signature) => checker.signatureToString(
      signature,
      at,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseStructuralFallback,
    ))
    .sort();
}

const structuralType = (
  checker: ts.TypeChecker,
  type: ts.Type,
  at: ts.Node,
  depth = 0,
): string => {
  const primitive = primitiveType(type);
  if (primitive !== undefined) return primitive;
  if (type.isUnion()) {
    return `union(${type.types.map((part) => structuralType(checker, part, at, depth + 1)).sort().join("|")})`;
  }
  if (type.isIntersection()) {
    return `intersection(${type.types.map((part) => structuralType(checker, part, at, depth + 1)).sort().join("&")})`;
  }
  if (depth >= 3) return `flags:${type.flags}`;

  const arrayElement = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (arrayElement !== undefined && checker.getPropertiesOfType(type).some((property) => property.name === "length")) {
    return `array<${structuralType(checker, arrayElement, at, depth + 1)}>`;
  }

  const properties = propertyShapes(checker, type, depth + 1);
  const signatures = signatureShapes(checker, type, at);
  if (properties.length === 0 && signatures.length === 0) return `flags:${type.flags}`;
  return `{${[...properties, ...signatures.map((signature) => `call:${signature}`)].join(",")}}`;
};

const band = (count: number): string => count <= 1 ? "0-1" : count <= 3 ? "2-3" : count <= 6 ? "4-6" : "7+";

function declaredType(checker: ts.TypeChecker, node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration): ts.Type {
  if (ts.isTypeAliasDeclaration(node)) return checker.getTypeFromTypeNode(node.type);
  const symbol = checker.getSymbolAtLocation(node.name);
  return symbol === undefined ? checker.getTypeAtLocation(node) : checker.getDeclaredTypeOfSymbol(symbol);
}

function typeShape(checker: ts.TypeChecker, node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration): TypeShape | undefined {
  const type = declaredType(checker, node);
  const rawSignatures = [...type.getCallSignatures(), ...type.getConstructSignatures()];
  if ((type.flags & ts.TypeFlags.Object) === 0 && rawSignatures.length === 0 && !type.isIntersection()) return undefined;
  const properties = propertyShapes(checker, type, 0);
  const signatures = signatureShapes(checker, type, node);
  if (properties.length === 0 && signatures.length === 0) return undefined;
  return {
    properties,
    signatures,
    components: [...properties.map((value) => `p:${value}`), ...signatures.map((value) => `s:${value}`)],
    propertyCount: properties.length,
    signatureCount: signatures.length,
    bucket: `${band(properties.length)}:${band(signatures.length)}`,
  };
}

const similarity = (left: TypeShape, right: TypeShape): number => {
  const a = new Set(left.components);
  const b = new Set(right.components);
  const union = new Set([...a, ...b]);
  return union.size === 0 ? 0 : [...a].filter((value) => b.has(value)).length / union.size;
};

const comparableBuckets = (left: TypeShape, right: TypeShape): boolean =>
  left.bucket === right.bucket
  || Math.abs(left.propertyCount - right.propertyCount) <= 1 && Math.abs(left.signatureCount - right.signatureCount) <= 1;

interface TypeCandidate {
  shape: TypeShape;
  loc: Location;
  name: string;
}

function collectTypeCandidates(project: Project, cwd: string): {
  candidates: TypeCandidate[];
  truncated: boolean;
} {
  const candidates: TypeCandidate[] = [];
  let truncated = false;
  for (const file of project.files) {
    for (const statement of file.statements) {
      if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue;
      if (candidates.length >= ANALYZER_CAPS.typeCandidates) {
        truncated = true;
        continue;
      }
      const shape = typeShape(project.checker, statement);
      if (shape !== undefined) {
        candidates.push({
          shape,
          loc: location(cwd, file, statement),
          name: statement.name.text,
        });
      }
    }
  }
  return { candidates, truncated };
}

function bucketTypeCandidates(candidates: readonly TypeCandidate[]): Map<string, TypeCandidate[]> {
  const buckets = new Map<string, TypeCandidate[]>();
  for (const candidate of candidates) {
    const bucket = buckets.get(candidate.shape.bucket);
    if (bucket === undefined) buckets.set(candidate.shape.bucket, [candidate]);
    else bucket.push(candidate);
  }
  return buckets;
}

function typePairKey(left: TypeCandidate, right: TypeCandidate): string {
  return [`${left.loc.path}:${left.loc.line}`, `${right.loc.path}:${right.loc.line}`]
    .sort()
    .join("|");
}

function typeSimilarityFinding(seed: TypeCandidate, peer: TypeCandidate, score: number): Finding {
  return {
    id: "",
    analyzer: AnalyzerName.Types,
    kind: FindingKind.TypeSimilarity,
    severity: Severity.Warning,
    message: `${score === 1 ? "Exact" : "Near"} structural type duplicate: ${seed.name} / ${peer.name}`,
    location: seed.loc,
    related: [peer.loc],
    data: {
      similarity: score,
      propertyCount: seed.shape.propertyCount,
      signatureCount: seed.shape.signatureCount,
    },
  };
}

function emitTypeMatches(
  seed: TypeCandidate,
  buckets: ReadonlyMap<string, TypeCandidate[]>,
  threshold: number,
  seen: Set<string>,
  output: Finding[],
): boolean {
  let comparisons = 0;
  for (const candidates of buckets.values()) {
    for (const peer of candidates) {
      if (!comparableBuckets(seed.shape, peer.shape)) continue;
      if (comparisons++ >= ANALYZER_CAPS.typeBucketComparisons) return true;
      if (seed === peer || seed.name === peer.name) continue;
      const score = similarity(seed.shape, peer.shape);
      if (score < threshold) continue;
      const key = typePairKey(seed, peer);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(typeSimilarityFinding(seed, peer, score));
      if (output.length >= ANALYZER_CAPS.typeFindings) return true;
    }
  }
  return false;
}

export function similarTypes(
  project: Project,
  cwd: string,
  scope: Scope,
  threshold = 0.8,
): Finding[] {
  const collected = collectTypeCandidates(project, cwd);
  const buckets = bucketTypeCandidates(collected.candidates);
  const changedSeeds = collected.candidates.filter((candidate) => changed(scope, candidate.loc));
  const output: Finding[] = [];
  const seen = new Set<string>();
  let truncated = collected.truncated;

  for (const seed of changedSeeds) {
    if (emitTypeMatches(seed, buckets, threshold, seen, output)) {
      truncated = true;
      break;
    }
  }
  if (truncated) {
    if (output.length >= ANALYZER_CAPS.typeFindings) output.pop();
    output.push(truncationFinding(AnalyzerName.Types));
  }
  return output.sort((left, right) => compareLocations(left.location, right.location));
}

function isLoop(node: ts.Node): boolean {
  return ts.isForStatement(node)
    || ts.isForOfStatement(node)
    || ts.isForInStatement(node)
    || ts.isWhileStatement(node)
    || ts.isDoStatement(node);
}

function repeatedScanName(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  const name = node.expression.name.text;
  return ["sort", "find", "filter", "some", "every", "reduce"].includes(name) ? name : undefined;
}

function visitAsyncRisks(
  file: ts.SourceFile,
  cwd: string,
  scope: Scope,
  output: Finding[],
): void {
  let loopDepth = 0;
  const visit = (node: ts.Node): void => {
    const loop = isLoop(node);
    if (loop) loopDepth++;
    if (loopDepth > 0) {
      const loc = location(cwd, file, node);
      if (changed(scope, loc) && ts.isAwaitExpression(node)) {
        output.push({
          id: "",
          analyzer: AnalyzerName.AsyncRisk,
          kind: FindingKind.AsyncRisk,
          severity: Severity.Info,
          message: "Await inside loop may serialize work",
          location: loc,
        });
      }
      const scan = repeatedScanName(node);
      if (changed(scope, loc) && scan !== undefined) {
        output.push({
          id: "",
          analyzer: AnalyzerName.AsyncRisk,
          kind: FindingKind.AsyncRisk,
          severity: Severity.Info,
          message: `${scan} call inside loop may repeat a scan`,
          location: loc,
        });
      }
    }
    ts.forEachChild(node, visit);
    if (loop) loopDepth--;
  };
  visit(file);
}

export function asyncRisks(project: Project, cwd: string, scope: Scope): Finding[] {
  const output: Finding[] = [];
  for (const file of project.files) visitAsyncRisks(file, cwd, scope, output);
  return output;
}
