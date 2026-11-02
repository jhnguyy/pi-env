# Testing

Use the [testing-practices skill](../../.agents/skills/testing-practices/SKILL.md) for the portable method: prove the target unit's functional promises through useful input/output seams and rely on established collaborator contracts. The conventions here apply that method to pi-env's suites, fixtures, and runtime boundaries. [Contribution guidance](../../CONTRIBUTING.md#verification) owns commands, build sequencing, and execution precautions.

## Choose the suite and runtime

Keep tests with their owning area under `__tests__`. The [Vitest configuration](../../vitest.config.ts) defines runnable roots and project selection: integration suites use `*.integration.test.ts` or `*.integration.test.mjs`, while E2E and real-workspace canary scenarios follow their configured filenames. Setup shell tests run separately using their [shared helpers](../../setup/__tests__/README.md).

Place expensive native SDK, real LSP, Docker, and platform qualification in explicitly selected suites. Review import and startup costs when adding or reworking coverage; a unit label alone does not establish inexpensive execution. Choose the canary when the promise depends on the real workspace and Docker when it depends on session-manager's tmux environment.

For native loading, use matching checkout dependencies and built artifacts, then exercise the rebuilt extension in a reloaded or restarted Pi session. Source imports establish a different claim from loaded bundles; [extension runtime conventions](extensions.md#runtime-shape) describe that boundary. A deterministic inference provider can accompany real SDK sessions and tools to establish local integration, leaving hosted-provider compatibility as a separate qualification.

## Build an isolated fixture

Use [Effect test guidance](effect-guardrails.md#tests) for Effect-native tests, injected services, test clocks, scopes, and interruption. Plain TypeScript and compatibility adapters can use regular Vitest tests. Keep substantial executable fixture programs in typed source files so repository checks can inspect them; source snippets an analyzer parses as input are data rather than executable fixture programs.

Isolate the user state a setup or native-session fixture can reach: homes, agent directories, settings, sessions, repositories, sockets, and shared services as applicable. A temporary cwd leaves personal Pi state exposed, so set an isolated `PI_CODING_AGENT_DIR` for processes that would otherwise discover it. Validate setup in that isolated state rather than resetting personal settings or activating a live host profile. Account for artifact preparation and LSP daemon restart before using dependency installation in a fixture or experiment.

## Establish the result at its consumer

Pi tools expose model-facing `content`, structured `details`, and UI rendering as different results. A test of the tool's answer establishes its required content, including useful information promised to survive bounded output. A routing or translation test instead establishes its adapter's decisions; formatting cases can rely on the engine's contract rather than requalifying its execution.

Likewise, durability across reload is established through a fresh reader or reloaded session, not merely an append call or in-memory result. For setup or migration idempotency, rerun against the state produced by the first run and check that the promised result remains unchanged.

Keep real-adapter evidence where a promise depends on native cancellation, process termination, persistence, transport compatibility, or shared resource ownership. Focused tests relying on the same established contract can reuse that evidence while concentrating on their own target's behavior.
