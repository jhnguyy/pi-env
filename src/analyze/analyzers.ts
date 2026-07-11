import { createHash } from "node:crypto";
import { relative } from "node:path";
import ts from "typescript";
import { AnalyzerName, FindingKind, Severity, type Finding, type Location } from "./model.js";
import type { Project } from "./program.js";
import type { Scope } from "./scope.js";
import { intersectsHunks } from "./scope.js";

type BodyFunction = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };
const hasBody = (n: ts.Node): n is BodyFunction => ts.isFunctionLike(n) && "body" in n && n.body !== undefined;
const functions = (file: ts.SourceFile): BodyFunction[] => { const out: BodyFunction[]=[]; const visit=(n:ts.Node):void=>{ if(hasBody(n)) out.push(n); ts.forEachChild(n, child => { visit(child); }); }; visit(file); return out; };
const location = (cwd:string, file:ts.SourceFile, node:ts.Node):Location => { const a=file.getLineAndCharacterOfPosition(node.getStart(file)); const b=file.getLineAndCharacterOfPosition(node.getEnd()); return {path:relative(cwd,file.fileName).replaceAll("\\","/"),line:a.line+1,column:a.character+1,endLine:b.line+1,endColumn:b.character+1}; };
const changed=(scope:Scope,l:Location):boolean => scope.mode === "all" || scope.files.includes(l.path) && intersectsHunks(l.line,l.endLine??l.line,scope.hunks.get(l.path));
const canonical=(node:ts.Node):string => { const parts:string[]=[]; const visit=(n:ts.Node):void=>{ parts.push(String(n.kind)); if(ts.isIdentifier(n)) parts.push("#id"); else if(ts.isStringLiteral(n)||ts.isNumericLiteral(n)) parts.push("#literal"); else if(n.getChildCount()===0) parts.push(n.getText()); ts.forEachChild(n, child => { visit(child); }); }; visit(node); return parts.join("|"); };
export function complexity(project:Project,cwd:string,scope:Scope):Finding[]{ const out:Finding[]=[]; for(const file of project.files) for(const fn of functions(file)){ const loc=location(cwd,file,fn); if(!changed(scope,loc))continue; let cyclomatic=1,cognitive=0,depth=0; const visit=(n:ts.Node):void=>{ if(n!==fn&&ts.isFunctionLike(n))return; const branch=ts.isIfStatement(n)||ts.isForStatement(n)||ts.isForInStatement(n)||ts.isForOfStatement(n)||ts.isWhileStatement(n)||ts.isDoStatement(n)||ts.isCaseClause(n)||ts.isConditionalExpression(n)||ts.isCatchClause(n)||ts.isBinaryExpression(n)&&(n.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken||n.operatorToken.kind===ts.SyntaxKind.BarBarToken); if(branch){cyclomatic++;cognitive+=1+depth;depth++;} ts.forEachChild(n, child=>{visit(child);}); if(branch)depth--;}; visit(fn); if(cyclomatic>=10)out.push({id:"",analyzer:AnalyzerName.Complexity,kind:FindingKind.Complexity,severity:Severity.Warning,message:`Function complexity: cyclomatic ${cyclomatic}, cognitive ${cognitive}`,location:loc,data:{cyclomatic,cognitive}}); } return out; }
export const ANALYZER_CAPS = { duplicateCandidates: 10_000, duplicateFindings: 100, typeCandidates: 5_000, typeBucketComparisons: 2_000, typeFindings: 50 } as const;
export function duplicates(project:Project,cwd:string,scope:Scope):Finding[]{ const buckets=new Map<string,{canonical:string;locations:Location[]}>();let candidates=0,truncated=false; for(const file of project.files)for(const fn of functions(file)){if(!fn.body)continue;if(candidates++>=ANALYZER_CAPS.duplicateCandidates){truncated=true;break;}const text=canonical(fn.body);if(text.length<80)continue;const hash=createHash("sha256").update(text).digest("hex");const prior=buckets.get(hash);if(prior){if(prior.canonical===text)prior.locations.push(location(cwd,file,fn));}else buckets.set(hash,{canonical:text,locations:[location(cwd,file,fn)]});} const out:Finding[]=[];for(const group of buckets.values()){if(group.locations.length<2)continue;for(const seed of group.locations.filter(x=>changed(scope,x)).slice(0,25)){const peer=group.locations.find(x=>x!==seed);if(peer)out.push({id:"",analyzer:AnalyzerName.Duplicates,kind:FindingKind.Duplicate,severity:Severity.Warning,message:"Structurally duplicate function",location:seed,related:[peer]});if(out.length>=ANALYZER_CAPS.duplicateFindings){truncated=true;break;}}if(truncated&&out.length>=ANALYZER_CAPS.duplicateFindings)break;}if(truncated){if(out.length>=ANALYZER_CAPS.duplicateFindings)out.pop();out.push({id:"",analyzer:AnalyzerName.Duplicates,kind:FindingKind.Duplicate,severity:Severity.Info,message:"Duplicate analysis truncated at bounded candidate/finding limits",location:{path:".",line:1,column:1},data:{truncated:true}});}return out; }
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

  const properties = checker.getPropertiesOfType(type)
    .filter((property) => property.valueDeclaration !== undefined || property.declarations?.length)
    .map((property) => {
      const declaration = property.valueDeclaration ?? property.declarations![0]!;
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
      const readonly = ts.canHaveModifiers(declaration) && ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ? "r" : "";
      return `${property.name}${optional}${readonly}:${structuralType(checker, propertyType, declaration, depth + 1)}`;
    })
    .sort();
  const signatures = [...type.getCallSignatures(), ...type.getConstructSignatures()]
    .map((signature) => checker.signatureToString(signature, at, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseStructuralFallback))
    .sort();
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
  const properties = checker.getPropertiesOfType(type)
    .filter((property) => property.valueDeclaration !== undefined || property.declarations?.length)
    .map((property) => {
      const declaration = property.valueDeclaration ?? property.declarations![0]!;
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
      const readonly = ts.canHaveModifiers(declaration) && ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ? "r" : "";
      return `${property.name}${optional}${readonly}:${structuralType(checker, propertyType, declaration)}`;
    })
    .sort();
  const signatures = rawSignatures
    .map((signature) => checker.signatureToString(signature, node, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseStructuralFallback))
    .sort();
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

export function similarTypes(project: Project, cwd: string, scope: Scope, threshold = 0.8): Finding[] {
  const all: { shape: TypeShape; loc: Location; name: string }[] = [];
  let truncated = false;
  for (const file of project.files) {
    for (const statement of file.statements) {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        if (all.length >= ANALYZER_CAPS.typeCandidates) { truncated = true; continue; }
        const shape = typeShape(project.checker, statement);
        if (shape !== undefined) all.push({ shape, loc: location(cwd, file, statement), name: statement.name.text });
      }
    }
  }
  const out: Finding[] = [];
  const seen = new Set<string>();
  const buckets = new Map<string, typeof all>();
  for (const candidate of all) buckets.set(candidate.shape.bucket, [...(buckets.get(candidate.shape.bucket) ?? []), candidate]);
  for (const seed of all.filter((candidate) => changed(scope, candidate.loc))) {
    let comparisons = 0;
    for (const peer of [...(buckets.get(seed.shape.bucket) ?? []), ...all.filter(candidate => candidate.shape.bucket !== seed.shape.bucket && comparableBuckets(seed.shape, candidate.shape))]) {
      if (comparisons++ >= ANALYZER_CAPS.typeBucketComparisons) { truncated = true; break; }
      if (seed === peer || seed.name === peer.name || !comparableBuckets(seed.shape, peer.shape)) continue;
      const score = similarity(seed.shape, peer.shape);
      if (score < threshold) continue;
      const key = [`${seed.loc.path}:${seed.loc.line}`, `${peer.loc.path}:${peer.loc.line}`].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const exact = score === 1;
      out.push({
        id: "",
        analyzer: AnalyzerName.Types,
        kind: FindingKind.TypeSimilarity,
        severity: Severity.Warning,
        message: `${exact ? "Exact" : "Near"} structural type duplicate: ${seed.name} / ${peer.name}`,
        location: seed.loc,
        related: [peer.loc],
        data: { similarity: score, propertyCount: seed.shape.propertyCount, signatureCount: seed.shape.signatureCount },
      });
      if (out.length >= ANALYZER_CAPS.typeFindings) { truncated = true; break; }
    }
    if (out.length >= ANALYZER_CAPS.typeFindings) break;
  }
  if (truncated) { if (out.length >= ANALYZER_CAPS.typeFindings) out.pop(); out.push({ id:"", analyzer:AnalyzerName.Types, kind:FindingKind.TypeSimilarity, severity:Severity.Info, message:"Type similarity analysis truncated at bounded candidate/comparison/finding limits", location:{path:".",line:1,column:1}, data:{truncated:true} }); }
  return out.sort((a, b) => a.location.path.localeCompare(b.location.path) || a.location.line - b.location.line);
}
export function asyncRisks(project:Project,cwd:string,scope:Scope):Finding[]{const out:Finding[]=[];for(const file of project.files){const loops:ts.Node[]=[];const visit=(n:ts.Node):void=>{const loop=ts.isForStatement(n)||ts.isForOfStatement(n)||ts.isForInStatement(n)||ts.isWhileStatement(n)||ts.isDoStatement(n);if(loop)loops.push(n);if(loops.length){const loc=location(cwd,file,n);if(changed(scope,loc)&&ts.isAwaitExpression(n))out.push({id:"",analyzer:AnalyzerName.AsyncRisk,kind:FindingKind.AsyncRisk,severity:Severity.Info,message:"Await inside loop may serialize work",location:loc});if(changed(scope,loc)&&ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&["sort","find","filter","some","every","reduce"].includes(n.expression.name.text))out.push({id:"",analyzer:AnalyzerName.AsyncRisk,kind:FindingKind.AsyncRisk,severity:Severity.Info,message:`${n.expression.name.text} call inside loop may repeat a scan`,location:loc});}ts.forEachChild(n,child=>{visit(child);});if(loop)loops.pop();};visit(file);}return out;}
