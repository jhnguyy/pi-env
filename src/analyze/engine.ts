import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { asyncRisks, complexity, duplicates, similarTypes } from "./analyzers.js";
import { runBenchmark, type BenchmarkConfig } from "./benchmark.js";
import { bundleAnalyzer, dependencyAnalyzer, eslintAnalyzer, knipAnalyzer } from "./external.js";
import { AnalyzerName, ConfigError, type AnalysisResult, type AnalyzerFailure, type Finding, type MemorySnapshot, type ScopeMode } from "./model.js";
import { createProject, type Project } from "./program.js";
import { resolveScope, type Scope } from "./scope.js";

export interface AnalyzeOptions { cwd:string; scope:ScopeMode; paths?:readonly string[]; ref?:string; checks?:readonly string[]; bundle?:boolean; typeSimilarityThreshold?:number; profile?:boolean; benchmarks?:readonly BenchmarkConfig[]; maxMemoryMb?:number }
export interface EngineSeams { createProject?: typeof createProject }
const INTERNAL = new Set<AnalyzerName>([AnalyzerName.Complexity, AnalyzerName.Duplicates, AnalyzerName.Types, AnalyzerName.AsyncRisk]);
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export const findingId=(finding:Finding):string=>createHash("sha256").update(stable({analyzer:finding.analyzer,kind:finding.kind,message:finding.message,location:finding.location,related:finding.related??[]})).digest("hex").slice(0,20);
const defaultChecks=Object.values(AnalyzerName).filter(name=>name!==AnalyzerName.Bundle);
export const isMemoryBudgetExceeded=(rssBytes:number,maxMemoryMb:number):boolean=>rssBytes>maxMemoryMb*1024*1024;
export const needsInternalProgram=(checks:readonly AnalyzerName[]):boolean=>checks.some(check=>INTERNAL.has(check));
function selectedChecks(options:AnalyzeOptions):AnalyzerName[]{
 if(options.typeSimilarityThreshold!==undefined&&(!Number.isFinite(options.typeSimilarityThreshold)||options.typeSimilarityThreshold<0||options.typeSimilarityThreshold>1))throw new ConfigError({message:"Type similarity threshold must be between 0 and 1"});
 const budget=options.maxMemoryMb??3072;if(!Number.isInteger(budget)||budget<=0)throw new ConfigError({message:"maxMemoryMb must be a positive integer"});
 const requested=options.checks??defaultChecks;const valid=new Set<string>(Object.values(AnalyzerName));const unknown=requested.filter(x=>!valid.has(x));if(unknown.length)throw new ConfigError({message:`Unknown checks: ${unknown.join(", ")}. Valid checks: ${Object.values(AnalyzerName).join(", ")}`});
 const selected=[...requested] as AnalyzerName[];if(options.bundle&&!selected.includes(AnalyzerName.Bundle))selected.push(AnalyzerName.Bundle);return selected;
}
const snapshot=():MemorySnapshot=>{const m=process.memoryUsage();return {rssBytes:m.rss,heapUsedBytes:m.heapUsed,externalBytes:m.external};};
export function analyze(options:AnalyzeOptions,seams:EngineSeams={}):Effect.Effect<AnalysisResult,never>{
 return Effect.promise(async()=>{const start=performance.now();const findings:Finding[]=[];const failures:AnalyzerFailure[]=[];const timings:Record<string,number>={};const memory:Record<string,MemorySnapshot>={};let peak:MemorySnapshot={rssBytes:0,heapUsedBytes:0,externalBytes:0};
 const snap=(name:string):MemorySnapshot=>{const value=snapshot();if(options.profile){memory[name]=value;peak={rssBytes:Math.max(peak.rssBytes,value.rssBytes),heapUsedBytes:Math.max(peak.heapUsedBytes,value.heapUsedBytes),externalBytes:Math.max(peak.externalBytes,value.externalBytes)};}return value;};
 const budget=options.maxMemoryMb??3072;let stopped=false;const guard=(name:AnalyzerName):boolean=>{const value=snap(`before:${name}`);if(!isMemoryBudgetExceeded(value.rssBytes,budget))return true;if(!stopped)failures.push({analyzer:name,message:`Memory budget exceeded: RSS ${value.rssBytes} bytes > ${budget} MiB guard; remaining expensive stages skipped`});stopped=true;return false;};
 try {const checks=selectedChecks(options);const scope=resolveScope(options.cwd,options.scope,options.paths??[],options.ref);let project:Project|undefined;
  if(needsInternalProgram(checks)){if(!guard(checks.find(x=>INTERNAL.has(x))!))project=undefined;else project=(seams.createProject??createProject)(options.cwd);}
  const ordered=[...checks.filter(x=>INTERNAL.has(x)),...checks.filter(x=>!INTERNAL.has(x))];
  for(const name of ordered){if(!INTERNAL.has(name))project=undefined;if(stopped||!guard(name))break;const at=performance.now();try{let output:Finding[];switch(name){
   case AnalyzerName.Complexity:output=complexity(project!,options.cwd,scope);break;case AnalyzerName.Duplicates:output=duplicates(project!,options.cwd,scope);break;case AnalyzerName.Types:output=similarTypes(project!,options.cwd,scope,options.typeSimilarityThreshold);break;case AnalyzerName.AsyncRisk:output=asyncRisks(project!,options.cwd,scope);break;
   case AnalyzerName.Eslint:project=undefined;output=await eslintAnalyzer(options.cwd,scope);break;case AnalyzerName.Dependencies:project=undefined;output=await dependencyAnalyzer(options.cwd,scope);break;case AnalyzerName.Knip:project=undefined;output=await knipAnalyzer(options.cwd);break;case AnalyzerName.Bundle:project=undefined;output=await bundleAnalyzer(options.cwd,scope,{beforeEntry:()=>guard(name)});break;
  }findings.push(...output);}catch(cause){failures.push({analyzer:name,message:cause instanceof Error?cause.message:String(cause)});}timings[name]=performance.now()-at;snap(`after:${name}`);if(isMemoryBudgetExceeded(process.memoryUsage().rss,budget)){if(!stopped)failures.push({analyzer:name,message:`Memory budget exceeded after analyzer; remaining expensive stages skipped`});stopped=true;}}
  const benchmarks=[];if(!stopped)for(const config of options.benchmarks??[]){const value=await runBenchmark(config);benchmarks.push(value);if(value.failure)failures.push({analyzer:"benchmark",message:value.failure});}
  const orderedFindings=findings.map(f=>({...f,id:findingId(f)})).sort((a,b)=>a.location.path.localeCompare(b.location.path)||a.location.line-b.location.line||a.id.localeCompare(b.id));timings.totalMs=performance.now()-start;snap("complete");
  return {version:1,summary:{info:orderedFindings.filter(f=>f.severity==="info").length,warning:orderedFindings.filter(f=>f.severity==="warning").length,error:orderedFindings.filter(f=>f.severity==="error").length,failures:failures.length},findings:orderedFindings,analyzerFailures:failures,benchmarks,...(options.profile?{profile:{timings,memory,peak}}:{})};
 }catch(cause){const tag=(cause as {_tag?:string})._tag;const failure:AnalyzerFailure={analyzer:tag==="ConfigError"?"configuration":tag==="ScopeError"?"scope":"program",message:cause instanceof Error?cause.message:String(cause)};timings.totalMs=performance.now()-start;snap("complete");return {version:1,summary:{info:0,warning:0,error:0,failures:1},findings:[],analyzerFailures:[failure],benchmarks:[],...(options.profile?{profile:{timings,memory,peak}}:{})};}
 });
}
