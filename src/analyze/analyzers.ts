import { createHash } from "node:crypto";
import { relative } from "node:path";
import ts from "typescript";
import { Effect } from "effect";
import { AnalyzerName, AnalyzerRunError, FindingKind, Severity, type Finding, type Location } from "./model.js";
import type { SyntaxProject, TypeProject } from "./program.js";
import type { Scope } from "./scope.js";
import { intersectsHunks } from "./scope.js";

type BodyFunction = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };
type DuplicateGroup = { canonical: string; locations: Location[] };
interface CanonicalizationResult {
  canonical: string;
  truncated: boolean;
  nodeCount: number;
  tokenCount: number;
}

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

const DUPLICATE_CANONICAL_CAPS = {
  nodesPerFunction: 10_000,
  bytesPerFunction: 256 * 1024,
  minimumNodeCount: 40,
  minimumTokenCount: 40,
} as const;

export interface DuplicateCanonicalCaps {
  nodesPerFunction: number;
  bytesPerFunction: number;
  minimumNodeCount: number;
  minimumTokenCount: number;
}

export function canonicalizeWithCap(node: ts.Node, caps: DuplicateCanonicalCaps = DUPLICATE_CANONICAL_CAPS): CanonicalizationResult {
  const parts: string[] = [];
  let nodeCount = 0;
  let tokenCount = 0;
  let bytes = 0;
  let truncated = false;
  const push = (value: string): void => {
    if (truncated) return;
    bytes += value.length + 1;
    if (bytes > caps.bytesPerFunction) {
      truncated = true;
      return;
    }
    parts.push(value);
    tokenCount++;
  };
  const visit = (child: ts.Node): void => {
    if (truncated) return;
    nodeCount++;
    if (nodeCount > caps.nodesPerFunction) {
      truncated = true;
      return;
    }
    push(String(child.kind));
    if (truncated) return;
    if (ts.isIdentifier(child)) push("#id");
    else if (ts.isStringLiteral(child) || ts.isNumericLiteral(child)) push("#literal");
    else if (child.getChildCount() === 0) push(child.getText());
    if (truncated) return;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return { canonical: parts.join("|"), truncated, nodeCount, tokenCount };
}

const logicalOperator = (node: ts.Node): ts.SyntaxKind | undefined =>
  ts.isBinaryExpression(node)
    && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ? node.operatorToken.kind
    : undefined;

function isControlBranch(node: ts.Node): boolean {
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
  const visit = (node: ts.Node, controlDepth: number, parentLogical?: ts.SyntaxKind): void => {
    if (node !== root && ts.isFunctionLike(node)) return;
    const logical = logicalOperator(node);
    if (logical !== undefined) {
      cyclomatic++;
      // A flat predicate is one cognitive sequence, even though each operator is
      // still a defensible cyclomatic branch. Mixed operators start a new sequence.
      if (logical !== parentLogical) cognitive++;
      ts.forEachChild(node, (child) => visit(child, controlDepth, logical));
      return;
    }
    const control = isControlBranch(node);
    if (control) {
      cyclomatic++;
      cognitive += 1 + controlDepth;
    }
    ts.forEachChild(node, (child) => visit(child, control ? controlDepth + 1 : controlDepth));
  };
  visit(root, 0);
  return { cyclomatic, cognitive };
}

const COMPLEXITY_ADVISORY = { cyclomatic: 15, cognitive: 20 } as const;

function analyzeComplexityFile(file: ts.SourceFile, cwd: string, scope: Scope, output: Finding[]): void {
  for (const fn of functions(file)) {
    const loc = location(cwd, file, fn);
    if (!changed(scope, loc)) continue;
    const score = functionComplexity(fn);
    if (score.cyclomatic >= COMPLEXITY_ADVISORY.cyclomatic || score.cognitive >= COMPLEXITY_ADVISORY.cognitive) {
      output.push({ id: "", analyzer: AnalyzerName.Complexity, kind: FindingKind.Complexity, severity: Severity.Warning,
        message: `Function complexity: cyclomatic ${score.cyclomatic}, cognitive ${score.cognitive}`, location: loc, data: score });
    }
  }
}

const analyzerFailure = (analyzer: AnalyzerName, cause: unknown): AnalyzerRunError => new AnalyzerRunError({
  analyzer,
  message: cause instanceof Error ? cause.message : String(cause),
});

function cooperativeFileAnalysis(
  analyzer: AnalyzerName,
  files: readonly ts.SourceFile[],
  analyzeFile: (file: ts.SourceFile, output: Finding[]) => void,
): Effect.Effect<Finding[], AnalyzerRunError> {
  return Effect.gen(function* () {
    const output: Finding[] = [];
    for (const file of files) {
      yield* Effect.try({ try: () => analyzeFile(file, output), catch: (cause) => analyzerFailure(analyzer, cause) });
      yield* Effect.yieldNow;
    }
    return output;
  });
}

export function complexityEffect(project: SyntaxProject, cwd: string, scope: Scope): Effect.Effect<Finding[], AnalyzerRunError> {
  return cooperativeFileAnalysis(AnalyzerName.Complexity, project.files, (file, output) => analyzeComplexityFile(file, cwd, scope, output));
}

const ANALYZER_CAPS = {
  duplicateCandidates: 10_000,
  duplicateFindings: 100,
  typeCandidates: 5_000,
  typeBucketComparisons: 2_000,
  typeFindings: 50,
} as const;

const compareLocations = (left: Location, right: Location): number =>
  left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column;

interface DuplicateCollection { groups: Map<string, DuplicateGroup>; candidates: number; truncated: boolean }

function collectDuplicateFile(file: ts.SourceFile, cwd: string, state: DuplicateCollection): void {
  for (const fn of functions(file)) {
    if (state.candidates >= ANALYZER_CAPS.duplicateCandidates) { state.truncated = true; return; }
    state.candidates++;
    const result = canonicalizeWithCap(fn.body);
    if (result.truncated || result.canonical.length < 80 || result.nodeCount < DUPLICATE_CANONICAL_CAPS.minimumNodeCount || result.tokenCount < DUPLICATE_CANONICAL_CAPS.minimumTokenCount) continue;
    const hash = createHash("sha256").update(result.canonical).digest("hex");
    const prior = state.groups.get(hash);
    if (prior === undefined) state.groups.set(hash, { canonical: result.canonical, locations: [location(cwd, file, fn)] });
    else if (prior.canonical === result.canonical) prior.locations.push(location(cwd, file, fn));
  }
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

function duplicateFindings(collected: DuplicateCollection, scope: Scope): Finding[] {
  const output: Finding[] = [];
  let truncated = collected.truncated;
  for (const group of collected.groups.values()) {
    const finding = duplicateFinding(group, scope);
    if (finding === undefined) continue;
    if (output.length >= ANALYZER_CAPS.duplicateFindings) { truncated = true; break; }
    output.push(finding);
  }
  if (truncated) {
    if (output.length >= ANALYZER_CAPS.duplicateFindings) output.pop();
    output.push(truncationFinding(AnalyzerName.Duplicates));
  }
  return output;
}

export function duplicatesEffect(project: SyntaxProject, cwd: string, scope: Scope): Effect.Effect<Finding[], AnalyzerRunError> {
  return Effect.gen(function* () {
    const state: DuplicateCollection = { groups: new Map(), candidates: 0, truncated: false };
    for (const file of project.files) {
      yield* Effect.try({ try: () => collectDuplicateFile(file, cwd, state), catch: (cause) => analyzerFailure(AnalyzerName.Duplicates, cause) });
      if (state.truncated) break;
      yield* Effect.yieldNow;
    }
    return duplicateFindings(state, scope);
  });
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

const TYPE_SHAPE_CAPS = { properties: 256, signatures: 64, unionParts: 128, signatureBytes: 4_096 } as const;

function propertyShapes(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth: number,
): string[] {
  const properties = checker.getPropertiesOfType(type);
  if (properties.length > TYPE_SHAPE_CAPS.properties) return [`#oversized-properties:${properties.length}`];
  return properties
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
  const signatures = [...type.getCallSignatures(), ...type.getConstructSignatures()];
  if (signatures.length > TYPE_SHAPE_CAPS.signatures) return [`#oversized-signatures:${signatures.length}`];
  return signatures
    .map((signature) => checker.signatureToString(signature, at, ts.TypeFormatFlags.UseStructuralFallback).slice(0, TYPE_SHAPE_CAPS.signatureBytes))
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
  if (depth >= 3) return `flags:${type.flags}`;
  if (type.isUnion()) {
    if (type.types.length > TYPE_SHAPE_CAPS.unionParts) return `oversized-union:${type.types.length}`;
    return `union(${type.types.map((part) => structuralType(checker, part, at, depth + 1)).sort().join("|")})`;
  }
  if (type.isIntersection()) {
    if (type.types.length > TYPE_SHAPE_CAPS.unionParts) return `oversized-intersection:${type.types.length}`;
    return `intersection(${type.types.map((part) => structuralType(checker, part, at, depth + 1)).sort().join("&")})`;
  }

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
  extends?: string;
  typeReference?: string;
}

interface TypeCollection { candidates: TypeCandidate[]; truncated: boolean }

function collectTypeFile(project: TypeProject, cwd: string, file: ts.SourceFile, state: TypeCollection): void {
  for (const statement of file.statements) {
    if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue;
    if (state.candidates.length >= ANALYZER_CAPS.typeCandidates) { state.truncated = true; continue; }
    const shape = typeShape(project.checker, statement);
    if (shape === undefined) continue;
    const candidate: TypeCandidate = { shape, loc: location(cwd, file, statement), name: statement.name.text };
    if (ts.isInterfaceDeclaration(statement) && statement.heritageClauses !== undefined) {
      const parent = statement.heritageClauses.flatMap((clause) => clause.types).at(0)?.expression;
      if (parent !== undefined) candidate.extends = parent.getText(file);
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      const typeNode = statement.type;
      if (ts.isTypeReferenceNode(typeNode)) candidate.typeReference = typeNode.getText(file);
    }
    state.candidates.push(candidate);
  }
}

interface TypeCandidateIndex {
  bands: ReadonlyMap<string, readonly TypeCandidate[]>;
  counts: ReadonlyMap<string, readonly TypeCandidate[]>;
}

function indexTypeCandidates(candidates: readonly TypeCandidate[]): TypeCandidateIndex {
  const bands = new Map<string, TypeCandidate[]>();
  const counts = new Map<string, TypeCandidate[]>();
  for (const candidate of candidates) {
    const bandCandidates = bands.get(candidate.shape.bucket);
    if (bandCandidates === undefined) bands.set(candidate.shape.bucket, [candidate]);
    else bandCandidates.push(candidate);
    const countKey = `${candidate.shape.propertyCount}:${candidate.shape.signatureCount}`;
    const countCandidates = counts.get(countKey);
    if (countCandidates === undefined) counts.set(countKey, [candidate]);
    else countCandidates.push(candidate);
  }
  return { bands, counts };
}

function comparableTypeCandidates(seed: TypeCandidate, index: TypeCandidateIndex): TypeCandidate[] {
  const peers = new Set(index.bands.get(seed.shape.bucket) ?? []);
  for (let propertyDelta = -1; propertyDelta <= 1; propertyDelta++) {
    for (let signatureDelta = -1; signatureDelta <= 1; signatureDelta++) {
      const propertyCount = seed.shape.propertyCount + propertyDelta;
      const signatureCount = seed.shape.signatureCount + signatureDelta;
      if (propertyCount < 0 || signatureCount < 0) continue;
      for (const candidate of index.counts.get(`${propertyCount}:${signatureCount}`) ?? []) peers.add(candidate);
    }
  }
  return [...peers];
}

function typePairKey(left: TypeCandidate, right: TypeCandidate): string {
  return [`${left.loc.path}:${left.loc.line}:${left.loc.column}`, `${right.loc.path}:${right.loc.line}:${right.loc.column}`]
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

function isTypeMatchCandidate(seed: TypeCandidate, peer: TypeCandidate): boolean {
  if (seed === peer || seed.name === peer.name) return false;
  if (seed.extends !== undefined && seed.extends === peer.name) return false;
  if (peer.extends !== undefined && peer.extends === seed.name) return false;
  if (seed.typeReference !== undefined && seed.typeReference === peer.name) return false;
  if (peer.typeReference !== undefined && peer.typeReference === seed.name) return false;
  return comparableBuckets(seed.shape, peer.shape);
}

function recordTypePair(seed: TypeCandidate, peer: TypeCandidate, seen: Set<string>): boolean {
  const key = typePairKey(seed, peer);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

function shouldTruncateTypeMatches(output: readonly Finding[]): boolean {
  return output.length >= ANALYZER_CAPS.typeFindings;
}

function emitTypeMatches(
  seed: TypeCandidate,
  index: TypeCandidateIndex,
  threshold: number,
  seen: Set<string>,
  output: Finding[],
): boolean {
  let comparisons = 0;
  for (const peer of comparableTypeCandidates(seed, index)) {
    if (!isTypeMatchCandidate(seed, peer)) continue;
    if (comparisons++ >= ANALYZER_CAPS.typeBucketComparisons) return true;
    const score = similarity(seed.shape, peer.shape);
    if (score < threshold || !recordTypePair(seed, peer, seen)) continue;
    output.push(typeSimilarityFinding(seed, peer, score));
    if (shouldTruncateTypeMatches(output)) return true;
  }
  return false;
}

interface TypeMatchingState { output: Finding[]; seen: Set<string>; truncated: boolean }

function finishTypeMatches(state: TypeMatchingState): Finding[] {
  if (state.truncated) {
    if (state.output.length >= ANALYZER_CAPS.typeFindings) state.output.pop();
    state.output.push(truncationFinding(AnalyzerName.Types));
  }
  return state.output.sort((left, right) => compareLocations(left.location, right.location));
}

export function similarTypesEffect(project: TypeProject, cwd: string, scope: Scope, threshold = 0.8): Effect.Effect<Finding[], AnalyzerRunError> {
  return Effect.gen(function* () {
    const collected: TypeCollection = { candidates: [], truncated: false };
    for (const file of project.files) {
      yield* Effect.try({ try: () => collectTypeFile(project, cwd, file, collected), catch: (cause) => analyzerFailure(AnalyzerName.Types, cause) });
      yield* Effect.yieldNow;
    }
    const index = indexTypeCandidates(collected.candidates);
    const state: TypeMatchingState = { output: [], seen: new Set(), truncated: collected.truncated };
    for (const seed of collected.candidates.filter((candidate) => changed(scope, candidate.loc))) {
      if (emitTypeMatches(seed, index, threshold, state.seen, state.output)) { state.truncated = true; break; }
      yield* Effect.yieldNow;
    }
    return finishTypeMatches(state);
  });
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

function allowsSequential(file: ts.SourceFile, loop: ts.Node): boolean {
  const text = file.getFullText();
  const comments = ts.getLeadingCommentRanges(text, loop.getFullStart()) ?? [];
  const last = comments.at(-1);
  if (last === undefined || text.slice(last.end, loop.getStart(file)).trim() !== "") return false;
  return /^\/\/\s*analyze:\s*allow-sequential\s*$/.test(text.slice(last.pos, last.end));
}

function visitForInOrOfLoop(
  node: ts.ForInOrOfStatement,
  visit: (node: ts.Node, loopDepth: number, suppressed: boolean) => void,
  loopDepth: number,
  suppressed: boolean,
  bodySuppressed: boolean,
): void {
  // For-of/in operands are evaluated once before iteration begins.
  visit(node.initializer, loopDepth, suppressed);
  visit(node.expression, loopDepth, suppressed);
  visit(node.statement, loopDepth + 1, bodySuppressed);
}

function visitForLoop(
  node: ts.ForStatement,
  visit: (node: ts.Node, loopDepth: number, suppressed: boolean) => void,
  loopDepth: number,
  suppressed: boolean,
  bodySuppressed: boolean,
): void {
  if (node.initializer !== undefined) visit(node.initializer, loopDepth, suppressed);
  if (node.condition !== undefined) visit(node.condition, loopDepth + 1, bodySuppressed);
  if (node.incrementor !== undefined) visit(node.incrementor, loopDepth + 1, bodySuppressed);
  visit(node.statement, loopDepth + 1, bodySuppressed);
}

function visitWhileOrDoLoop(
  node: ts.WhileStatement | ts.DoStatement,
  visit: (node: ts.Node, loopDepth: number, suppressed: boolean) => void,
  loopDepth: number,
  bodySuppressed: boolean,
): void {
  visit(node.expression, loopDepth + 1, bodySuppressed);
  visit(node.statement, loopDepth + 1, bodySuppressed);
}

function visitLoop(
  node: ts.Node,
  file: ts.SourceFile,
  visit: (node: ts.Node, loopDepth: number, suppressed: boolean) => void,
  loopDepth: number,
  suppressed: boolean,
): boolean {
  if (!isLoop(node)) return false;
  const bodySuppressed = suppressed || allowsSequential(file, node);
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    visitForInOrOfLoop(node, visit, loopDepth, suppressed, bodySuppressed);
  } else if (ts.isForStatement(node)) {
    visitForLoop(node, visit, loopDepth, suppressed, bodySuppressed);
  } else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    visitWhileOrDoLoop(node, visit, loopDepth, bodySuppressed);
  }
  return true;
}

function visitAsyncRisks(
  file: ts.SourceFile,
  cwd: string,
  scope: Scope,
  output: Finding[],
): void {
  const visit = (node: ts.Node, loopDepth: number, suppressed: boolean): void => {
    if (visitLoop(node, file, visit, loopDepth, suppressed)) return;
    if (loopDepth > 0 && !suppressed) {
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
    ts.forEachChild(node, (child) => visit(child, loopDepth, suppressed));
  };
  visit(file, 0, false);
}

export function asyncRisksEffect(project: SyntaxProject, cwd: string, scope: Scope): Effect.Effect<Finding[], AnalyzerRunError> {
  return cooperativeFileAnalysis(AnalyzerName.AsyncRisk, project.files, (file, output) => visitAsyncRisks(file, cwd, scope, output));
}
