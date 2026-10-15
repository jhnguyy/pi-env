# Shared extension primitives

| Intent | Symbols | Module |
|---|---|---|
| Read and decode global/project settings | `loadSettingsSnapshotEffect()`, `readSettingsBlockEffect()`, `decodeSettingsBlockEffect()` | `settings.ts` |
| Read optional agent model/work-tracker settings | `readOptionalAgentSettings()` | `agent-settings.ts` |
| Native tool registration with domain context and UI metadata | `registerContractTool()`, `ToolContract`, `toPiTool()` | `register-contract-tool.ts`, `tool-contract.ts` |
| Native lifecycle event and action-capability names | `PiEvent`, `ToolCapability` | `agent-tools.ts` |
| Async-local target cwd/agentDir during native child loading and execution | `getChildContext()`, `withChildContext()` | `child-context.ts` |
| Resolve Node executables | `findNodeBinaryLite()` | `node-bin-lite.ts` |
| Normalize names and generate IDs | `slugify()`, `generateId()` | `slug.ts`, `id.ts` |
| Format and parse session milestones | `formatTodoSessionMilestone()`, `parseSessionMilestoneLabel()` | `session-milestones.ts` |
| Build tool results and typed errors | `ok()`, `err()`, `txt()`, `BaseExtensionError`, `formatError()` | `result.ts`, `errors.ts` |
| Build code frames and remap stack locations | `buildCodeFrame()`, `mapGeneratedStackToUserLine()` | `code-frame.ts` |
| Query Git state | `gitSync()`, `isGitRepo()`, `getCurrentBranch()`, `getDirtyCount()`, `getMergedBranches()` | `git.ts` |
| Detect headless extension contexts | `isHeadless()` | `context.ts` |
| Render the configured tool-output expansion hint with a `ctrl+o` fallback | `toolExpandKeyHint()`, `toolExpandHint()` | `tool-render.ts` |
