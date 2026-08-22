# Import conventions

Use a namespace import for a local module API:

```ts
import * as Protocol from "./protocol.js";
import type * as Contracts from "./contracts.js";
```

Qualify each imported symbol with the module name. Use a short PascalCase name that identifies the module. This style keeps symbol ownership visible and avoids long named-import lists.

Use named imports when a public barrel is the intended dependency boundary. Keep default imports when the module defines a default contract. Keep side-effect-only imports explicit. Follow an external package's public API instead of applying the local-module rule to package imports.

Do not create a barrel only to avoid a namespace import. Re-export public contracts explicitly from the barrel that already owns that boundary.

The pattern checker enables this rule one migrated root at a time. Add a root only after its existing local imports use namespace imports.
