import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { BenchmarkError, type BenchmarkResult } from "./model.js";
const execute = promisify(execFile);
export interface BenchmarkConfig { command:string; args:string[]; cwd?:string; timeoutMs?:number; warmups?:number; runs?:number }
export function validateBenchmark(value:unknown):BenchmarkConfig { if(typeof value!=="object"||value===null)throw new BenchmarkError({message:"Benchmark must be an object"});const v=value as Record<string,unknown>;if(typeof v.command!=="string"||!Array.isArray(v.args)||!v.args.every(x=>typeof x==="string"))throw new BenchmarkError({message:"Benchmark requires command and string args"});for(const key of ["timeoutMs","warmups","runs"] as const){
  const minimum = key === "runs" ? 1 : 0;
  if(v[key]!==undefined&&(!Number.isInteger(v[key])||(v[key] as number)<minimum)){
    throw new BenchmarkError({message:`${key} must be an integer >= ${minimum}`});
  }
}return v as unknown as BenchmarkConfig; }
export async function runBenchmark(config:BenchmarkConfig):Promise<BenchmarkResult>{const runs:number[]=[];try{for(let i=0;i<(config.warmups??0);i++)await execute(config.command,config.args,{cwd:config.cwd,timeout:config.timeoutMs??30_000});for(let i=0;i<(config.runs??1);i++){const start=performance.now();await execute(config.command,config.args,{cwd:config.cwd,timeout:config.timeoutMs??30_000});runs.push(performance.now()-start);}return{command:[config.command,...config.args].join(" "),runs,meanMs:runs.reduce((a,b)=>a+b,0)/runs.length};}catch(cause){return{command:[config.command,...config.args].join(" "),runs,failure:cause instanceof Error?cause.message:String(cause)};}}
