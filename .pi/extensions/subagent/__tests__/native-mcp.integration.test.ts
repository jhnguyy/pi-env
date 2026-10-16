import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as ChildContext from "../../_shared/child-context";
import * as ChildTypes from "../child-types";
import * as Execute from "../execute";
import * as Control from "../control";

const tool = "mcp__fixture__echo";
afterEach(() => vi.unstubAllEnvs());
// An external process speaking real stdio JSON-RPC, not a mocked MCP loader.
const server = String.raw`import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const [log, marker] = process.argv.slice(2);
function record(value) { appendFileSync(log, JSON.stringify({pid:process.pid,...value})+'\n'); }
record({event:'spawn'});
process.on('exit', code=>record({event:'exit',code}));
for await (const line of createInterface({input:process.stdin})) {
  let m; try {m=JSON.parse(line)} catch {continue}
  record({event:'request',message:m});
  if(m.id===undefined) continue;
  let result;
  switch(m.method) {
    case 'initialize': result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0.0'}};break;
    case 'tools/list': result={tools:[{name:'echo',description:'Local proof echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};break;
    case 'tools/call': appendFileSync(marker,JSON.stringify(m.params)+'\n'); result={content:[{type:'text',text:'native-mcp-dispatch:'+m.params.arguments.text}]};break;
    case 'ping': result={};break;
    default: process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'unsupported fixture method'}})+'\n');continue;
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
}
`;

async function fixture(options: { broken?: boolean; timeout?: boolean; handled?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "native-mcp-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  // Native MCP reads its global directory through this documented environment setting.
  // Isolate it too; passing agentDir to model services alone does not isolate MCP.
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  await mkdir(join(root, ".pi"));
  const serverPath = join(root, "server.mjs");
  await writeFile(serverPath, options.broken ? "process.exit(1);" : options.timeout ? server.replace("let result;", "if (m.method === 'initialize') continue; let result;") : server);
  await writeFile(join(root, ".pi", "mcp.json"), JSON.stringify({
    mcpServers: { fixture: {
      command: process.execPath,
      args: [serverPath, join(root, "protocol.jsonl"), join(root, "dispatch.jsonl")],
      exposure: "direct", timeout: 1,
    } },
  }));
  const provider = join(agentDir, "provider.mjs");
  await writeFile(provider, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { appendFileSync } from 'node:fs';
export default function(pi) {
 const p = fauxProvider({provider:'mcp-integration'});
 p.setResponses([
   fauxAssistantMessage(fauxToolCall('${tool}',{text:'initial'}),{stopReason:'toolUse'}),
   fauxAssistantMessage('initial complete'),
   fauxAssistantMessage(fauxToolCall('${tool}',{text:'human'}),{stopReason:'toolUse'}),
   fauxAssistantMessage('human complete'),
 ].map(message => () => { appendFileSync(${JSON.stringify(join(root, "inference"))},'invoked\\n'); return message; }));
 pi.registerProvider(p.provider);
 ${options.handled ? "pi.on('input',()=>({action:'handled'}));" : ""}
}`);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    extensions: [provider], defaultProvider: "mcp-integration", defaultModel: "faux-1", retry: { enabled: false },
  }));
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({
    "mcp-integration": { type: "api_key", key: "synthetic-local-only" },
  }));
  const parent = SessionManager.create(root, join(root, "sessions"));
  let child: ChildTypes.NativeChildSession | undefined;
  return {
    root,
    child: () => child!,
    execute: (toolNames?: string[]) => ChildContext.withChildContext({ cwd: root, agentDir }, () =>
      Effect.runPromise(Execute.runResolvedSubagentEffect({
        name: "mcp", task: "run echo", cwd: root, modelOverride: "mcp-integration/faux-1", toolNames,
      }, { cwd: root, sessionManager: parent, isProjectTrusted: () => true }, {
        onChild: (value) => { child = value; },
      })),
    ),
    async dispose() {
      // Native shutdown must complete while the server and logs still exist.
      await Control.disposeSubagentRunSupervisor(parent.getSessionId());
      await rm(root, { recursive: true, force: true });
    },
  };
}

it.each(["exact", "omitted", "empty"])("native MCP %s selection dispatches only when allowed and retains a real human prompt", async (selection) => {
  const f = await fixture();
  try {
    const result = await f.execute(selection === "exact" ? [tool] : selection === "empty" ? [] : undefined);
    expect(result.details.isError).toBe(false);
    expect(result.details.finalOutput).toContain("initial complete");
    const initial = f.child().inspect().initialResult;
    expect(await f.child().input("human echo", ChildTypes.NativeInputMode.Prompt)).toEqual({ outcome: "started" });
    expect(f.child().inspect().initialResult).toEqual(initial);
    const messages = f.child().inspect().messages;
    expect(messages).toContainEqual(expect.objectContaining({ role: "assistant", content: expect.arrayContaining([expect.objectContaining({ text: "human complete" })]) }));
    if (selection === "empty") {
      expect(result.details.toolNames).toEqual([]);
      expect(existsSync(join(f.root, "dispatch.jsonl"))).toBe(false);
      expect(f.child().inspect().activeTools).toEqual([]);
      // The provider did attempt the tool: denial is native, not model compliance.
      expect(messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: tool, isError: true }));
    } else {
      expect(result.details.toolNames).toContain(tool);
      const calls = (await readFile(join(f.root, "dispatch.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(calls).toEqual([
        expect.objectContaining({ name: "echo", arguments: { text: "initial" } }),
        expect.objectContaining({ name: "echo", arguments: { text: "human" } }),
      ]);
      expect(messages).toContainEqual(expect.objectContaining({ role: "toolResult", content: expect.arrayContaining([expect.objectContaining({ text: "native-mcp-dispatch:human" })]) }));
    }
    const file = f.child().inspect().sessionFile!;
    expect(SessionManager.open(file).buildSessionContext().messages).toEqual(messages);
    await f.child().close();
    expect(f.child().inspect().state).toBe("closed");
    const protocol = await readFile(join(f.root, "protocol.jsonl"), "utf8");
    expect(protocol).toContain('"method":"initialize"');
    expect(protocol).toContain('"method":"tools/list"');
    expect(protocol).toContain('"event":"exit"');
  } finally {
    await f.dispose();
  }
}, 30000);

it.each(["missing", "connection failure", "timeout"])("unavailable exact selection rejects without inference: %s", async (mode) => {
  const f = await fixture({ broken: mode === "connection failure", timeout: mode === "timeout" });
  try {
    await expect(f.execute([mode === "missing" ? "mcp__fixture__nonexistent" : tool])).rejects.toThrow(/Child tools unavailable:.*native preflight.*bounded/);
    expect(existsSync(join(f.root, "inference"))).toBe(false);
    expect(existsSync(join(f.root, "dispatch.jsonl"))).toBe(false);
    expect(f.child().inspect().state).toBe("closed");
    expect(f.child().inspect().initialResult).toBeUndefined();
  } finally {
    await f.dispose();
  }
}, 30000);

it.each([{ tools: ["read"] }, { tools: [tool] }])("handled initial input checks the known catalog without dummy inference: %j", async ({ tools }) => {
  // An unanswered initialize makes the handled-input catalog deterministically
  // incomplete; a healthy fast server could finish discovery before the check.
  const f = await fixture({ handled: true, timeout: tools[0] !== "read" });
  try {
    if (tools[0] === "read") {
      expect((await f.execute(tools)).details.isError).toBe(false);
    } else {
      // No native preflight means no direct MCP readiness guarantee, even though configured.
      await expect(f.execute(tools)).rejects.toThrow("Child tools unavailable:");
    }
    expect(existsSync(join(f.root, "inference"))).toBe(false);
    expect(existsSync(join(f.root, "dispatch.jsonl"))).toBe(false);
  } finally {
    await f.dispose();
  }
}, 30000);
