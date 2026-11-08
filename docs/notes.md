# Notes

The notes tool shares provider-neutral collection and Store actions between the coding-agent CLI and an experimental `pi-durable` entry point. Both use the same argument validation, revision preconditions, provider response bounds, and cancellation contract.

## Coding-agent

The registered notes extension reads the `notes` settings block and resolves its built-in or externally registered provider. Its terminal renderers and provider event bridge remain CLI-specific.

## Durable host

Requires `@earendil-works/pi-durable` **1.5.0**; its experimental API is version-specific. Build the notes bundles before importing `@pi-env/notes/durable`:

```sh
node scripts/build-extensions.mjs notes
```

A host with the notes workspace package available can install it into its registry:

```ts
import type { Registry } from "@earendil-works/pi-durable";
import { createDurableNotesExtension, type NotesProvider } from "@pi-env/notes/durable";

export function installNotes(registry: Registry, provider: NotesProvider) {
  registry.install(createDurableNotesExtension(provider));
}
```

The host owns the provider, its credentials, and its lifetime. The factory also accepts a provider resolver function and an optional `now: () => Date` for dated collection actions. It does not read CLI settings, register provider events, discover local vault paths, or depend on the terminal UI. Conversation cwd does not choose or relocate the supplied provider's storage.

Every notes action is available, including mutations. The tool declares `replay: "unsafe"`: reopening interrupted work reports an error instead of automatically repeating an external mutation. An interrupted mutation may already have happened; inspect the provider's current state before deciding what to do next. This is not an exactly-once guarantee.

Output limits belong to the host: the CLI adapter retains its existing truncation notice, while durable applies its native output limits. Provider validation and metadata bounds stay in the shared contract.

This entry point is not a p2 plugin or an automatic migration of CLI configuration. The existing filesystem provider still uses coding-agent's mutation queue; durable hosts should supply their own provider rather than importing CLI activation to discover one.

## Verification

`extensions/notes/__tests__/durable.integration.test.ts` exercises real durable dispatch with scripted inference: provider reads, argument rejection, revision preconditions, cancellation, and an interrupted mutation followed by a SQLite reopen. It also checks that the durable bundle's runtime imports exclude coding-agent, agent-core, and terminal UI packages. CLI contract and startup tests remain separate.
