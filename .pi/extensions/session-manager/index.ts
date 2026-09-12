/** Session-manager storage registration (runtime remains intentionally inert). */
export default function sessionManager(): void {}
export {
  SessionCatalog,
  makeSessionCatalog,
  manifestPathForCanonicalCwd,
  nodeStorage,
  sessionCatalogLayer,
} from "./storage.js";
export { SessionManifestSchema, canonicalJson, gcTombstones, validateManifest } from "./schema.js";
export * from "./contracts.js";
export type { StorageAdapter } from "./storage.js";
