import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { getSubagentRunSupervisor, disposeSubagentRunSupervisor } from "../../subagent/control";
import skillBuilder from "../index";

// Only inference is scripted. SDK loading, the registered public tool, advisory
// evaluation, retained ownership, persistence and shutdown all remain real.
it("evaluates through a native child and closes standalone ownership on parent shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-skill-eval-"));
  const agentDir = join(root,"agent");
  const skillDir = join(root,"skills","test-skill");
  let parent: AgentSession | undefined;
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  try {
    await mkdir(agentDir,{recursive:true});
    await writeFile(join(agentDir,"models.json"),JSON.stringify({providers:{"skill-eval-provider":{apiKey:"fixture-key"}}}));
    await mkdir(skillDir,{recursive:true});
    await writeFile(join(skillDir,"SKILL.md"),"---\nname: test-skill\ndescription: Reviews one local fixture.\n---\n# Test skill\n\nRead the input. Report the result.\n");
    const extension = join(agentDir,"provider.mjs");
    await writeFile(extension,`import {fauxProvider,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function(pi) {
 const p=fauxProvider({provider:'skill-eval-provider'});
 p.setResponses([fauxAssistantMessage(JSON.stringify({verdict:'needs-revision',findings:[{category:'clarity',severity:'warning',message:'Explain the result format.'}]}))]);
 pi.on('input',event=>{if(event.text==='evaluate fixture') p.setResponses([fauxAssistantMessage(fauxToolCall('skill_build',{path:${JSON.stringify(skillDir)},action:'evaluate',goal:'Review one local fixture.'}),{stopReason:'toolUse'}),fauxAssistantMessage('Evaluation completed.')]);});
 pi.registerProvider(p.provider);
}`);
    await writeFile(join(agentDir,"settings.json"),JSON.stringify({extensions:[extension],defaultProvider:"skill-eval-provider",defaultModel:"faux-1"}));
    const services = await createAgentSessionServices({cwd:root,agentDir,resourceLoaderOptions:{extensionFactories:[skillBuilder]}});
    parent = (await createAgentSessionFromServices({services,sessionManager:SessionManager.create(root,join(root,"sessions"))})).session;
    await parent.bindExtensions({mode:"print"});
    await parent.prompt("evaluate fixture");
    const result = parent.messages.find(message=>message.role==='toolResult' && message.toolName==='skill_build');
    expect(result).toMatchObject({isError:false,details:{evaluation:{verdict:"needs-revision",findings:[{message:"Explain the result format."}]}}});
    const supervisor = getSubagentRunSupervisor(parent.sessionManager.getSessionId())!;
    const children = [...supervisor.children.values()];
    expect(children).toHaveLength(1);
    expect(children[0].inspect()).toMatchObject({model:"skill-eval-provider/faux-1",initialResult:{isError:false}});
    expect(children[0].summary().state).toBe("idle");
    await parent.extensionRunner.emit({type:"session_shutdown",reason:"quit"});
    expect(children[0].summary().state).toBe("closed");
    expect(getSubagentRunSupervisor(parent.sessionManager.getSessionId())).toBeUndefined();
  } finally {
    if(parent) {
      await parent.abort();
      await disposeSubagentRunSupervisor(parent.sessionManager.getSessionId());
      parent.dispose();
    }
    vi.unstubAllEnvs();
    await rm(root,{recursive:true,force:true});
  }
});
