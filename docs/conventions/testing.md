# Testing

The [testing-practices skill](../../.agents/skills/testing-practices/SKILL.md) owns the portable method: prove the target unit's functional promises through useful input/output seams and rely on collaborators' established contracts. This page adds pi-env's test organization, fixtures, and qualification requirements.

For prerequisites, commands, build sequencing, and execution precautions, see [contribution guidance](../../CONTRIBUTING.md#verification).

## Suite and fixture placement

Keep tests with their owning area under `__tests__`. The [Vitest configuration](../../vitest.config.ts) defines runnable roots and project selection.

Name integration tests `*.integration.test.ts`, or `*.integration.test.mjs` for JavaScript suites. Follow the configuration's specific filenames for E2E and real-workspace canary scenarios. Setup shell tests run separately from Vitest; use their [shared helpers](../../setup/__tests__/README.md).

Keep substantial executable fixture programs in typed source files so repository checks can inspect them. Source snippets that an analyzer parses as input are data, not executable fixture programs.

Place expensive native SDK, real LSP, Docker, and platform qualification in explicitly selected suites. Review actual import and startup costs when adding or reworking coverage; existing unit classification does not establish inexpensive execution.

## Model-facing and durable results

Pi tools expose model-facing `content` separately from structured `details` and UI rendering. Tests of a tool's answer establish its required content. Tests of routing and request translation establish the adapter's own decisions without requalifying the engine in each formatting case. For bounded output, check that promised useful content survives alongside any truncation report.

For persistence across reload, inspect state through a fresh reader or reloaded session. An append call or in-memory result establishes a different promise. For setup or migration idempotency, rerun against the state produced by the first run and check that the promised result remains unchanged.

## Test services and isolated state

Follow [Effect test guidance](effect-guardrails.md#tests) for Effect-native tests, injected services, test clocks, scopes, and interruption. Plain TypeScript and compatibility adapters can use regular Vitest tests.

Setup and native-session fixtures isolate the user state they can reach: homes, agent directories, settings, sessions, repositories, sockets, and shared services as applicable. Set an isolated `PI_CODING_AGENT_DIR` for processes that would otherwise discover personal Pi state; a temporary cwd alone leaves that state exposed.

Validate setup with isolated state rather than resetting personal settings or activating a live host profile. Account for dependency installation's artifact preparation and LSP daemon restart before using installation in a fixture or experiment.

## Runtime qualification

Source imports and loaded extension bundles establish different evidence. Use matching checkout dependencies and built artifacts for workflows that load bundles; see [extension runtime conventions](extensions.md#runtime-shape). Exercise the rebuilt extension in a reloaded or restarted Pi session when the changed behavior depends on native loading.

A deterministic inference provider can accompany real SDK sessions and tools to establish local integration without hosted inference. Hosted-provider compatibility remains a separate qualification.

Keep real-adapter evidence for promises that depend on native cancellation, process termination, persistence, transport compatibility, or shared resource ownership. Reuse that evidence across focused tests relying on the same established contract. Select the canary and Docker suites when the change reaches their real-workspace or tmux boundaries.
