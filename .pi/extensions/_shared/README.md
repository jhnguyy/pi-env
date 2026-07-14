# Shared extension primitives

| Intent | Symbols | Module |
|---|---|---|
| Read and decode global/project settings | `loadSettingsSnapshotEffect()`, `readSettingsBlockEffect()`, `decodeSettingsBlockEffect()` | `settings.ts` |
| Read optional agent model/work-tracker settings | `readOptionalAgentSettings()` | `agent-settings.ts` |
| Register or observe extension tools | `registerAgentTools()`, `registerAgentToolsOnSessionStart()`, `listenForAgentTools()` | `agent-tools.ts` |
| Adapt one domain tool contract to Pi and AgentTool | `ToolContract`, `toPiTool()`, `toAgentTool()` | `tool-contract.ts` |
| Resolve built-in tool factories/capabilities | `BUILT_IN_TOOL_CONTRACTS`, `BUILT_IN_TOOL_NAMES` | `built-in-tools.ts` |
| Resolve Node executables | `findNodeBinaryEffect()`, `findNodeBinary()`, `findNodeBinaryLite()` | `node-bin.ts`, `node-bin-lite.ts` |
| Normalize names and generate IDs | `slugify()`, `generateId()` | `slug.ts`, `id.ts` |
| Format and parse session milestones | `formatTodoSessionMilestone()`, `parseSessionMilestoneLabel()` | `session-milestones.ts` |
| Build tool results and typed errors | `ok()`, `err()`, `txt()`, `BaseExtensionError`, `formatError()` | `result.ts`, `errors.ts` |
| Build code frames and remap stack locations | `buildCodeFrame()`, `mapGeneratedStackToUserLine()` | `code-frame.ts` |
| Query Git state | `gitSync()`, `isGitRepo()`, `getCurrentBranch()`, `getDirtyCount()`, `getMergedBranches()` | `git.ts` |
| Detect headless extension contexts | `isHeadless()` | `context.ts` |
| Update shared TUI slots | `setSlot()`, `clearSlot()`, `batchSlots()`, `flush()`, `resetSlots()` | `ui-render.ts` |
