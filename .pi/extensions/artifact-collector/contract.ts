import { Brand, Context, Data, Effect, Schema } from "effect";

export const ArtifactKind = {
  Goal: "goal",
  Specification: "specification",
  Decision: "decision",
  Question: "question",
  Assumption: "assumption",
  Hypothesis: "hypothesis",
  Evidence: "evidence",
  Task: "task",
  Finding: "finding",
  Handoff: "handoff",
  Report: "report",
} as const;
export type ArtifactKind = typeof ArtifactKind[keyof typeof ArtifactKind];
export const ARTIFACT_KINDS = Object.values(ArtifactKind) as [ArtifactKind, ...ArtifactKind[]];

export const ArtifactLifecycle = {
  Ephemeral: "ephemeral",
  Scratch: "scratch",
  Durable: "durable",
  Promoted: "promoted",
  Archived: "archived",
} as const;
export type ArtifactLifecycle = typeof ArtifactLifecycle[keyof typeof ArtifactLifecycle];
export const ARTIFACT_LIFECYCLES = Object.values(ArtifactLifecycle) as [ArtifactLifecycle, ...ArtifactLifecycle[]];

export const ArtifactSensitivity = {
  Public: "public",
  Internal: "internal",
  Restricted: "restricted",
} as const;
export type ArtifactSensitivity = typeof ArtifactSensitivity[keyof typeof ArtifactSensitivity];
export const ARTIFACT_SENSITIVITIES = Object.values(ArtifactSensitivity) as [ArtifactSensitivity, ...ArtifactSensitivity[]];

export const ProviderCapability = {
  Search: "search",
  List: "list",
  Read: "read",
  Create: "create",
  Update: "update",
  Archive: "archive",
  Manifest: "manifest",
  NativeRelations: "native-relations",
  DependenciesFrontier: "dependencies-frontier",
  Claims: "claims",
  CommentsAppend: "comments-append",
  Attachments: "attachments",
  StatusTransitions: "status-transitions",
  ContextInjection: "context-injection",
  IndexInjection: "index-injection",
} as const;
export type ProviderCapability = typeof ProviderCapability[keyof typeof ProviderCapability];
export const PROVIDER_CAPABILITIES = Object.values(ProviderCapability) as [ProviderCapability, ...ProviderCapability[]];

export const RelationKind = {
  References: "references",
  DependsOn: "depends-on",
  Blocks: "blocks",
  Supersedes: "supersedes",
  Duplicates: "duplicates",
  Claims: "claims",
} as const;
export type RelationKind = typeof RelationKind[keyof typeof RelationKind];
export const RELATION_KINDS = Object.values(RelationKind) as [RelationKind, ...RelationKind[]];

export const CatalogLocationRole = {
  Canonical: "canonical",
  Projection: "projection",
} as const;
export type CatalogLocationRole = typeof CatalogLocationRole[keyof typeof CatalogLocationRole];
export const CATALOG_LOCATION_ROLES = Object.values(CatalogLocationRole) as [CatalogLocationRole, ...CatalogLocationRole[]];

export type ArtifactId = string & Brand.Brand<"ArtifactId">;
export const ArtifactId = Brand.nominal<ArtifactId>();
export type ProviderId = string & Brand.Brand<"ProviderId">;
export const ProviderId = Brand.nominal<ProviderId>();

export const ArtifactIdSchema = Schema.NonEmptyString.pipe(Schema.brand("ArtifactId"));
export const ProviderIdSchema = Schema.NonEmptyString.pipe(Schema.brand("ProviderId"));
const KindSchema = Schema.Literal(...ARTIFACT_KINDS);
const LifecycleSchema = Schema.Literal(...ARTIFACT_LIFECYCLES);
const SensitivitySchema = Schema.Literal(...ARTIFACT_SENSITIVITIES);
const CapabilitySchema = Schema.Literal(...PROVIDER_CAPABILITIES);
const RelationKindSchema = Schema.Literal(...RELATION_KINDS);
export const PositivePageSizeSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0), Schema.lessThanOrEqualTo(1000));
export const CursorTokenSchema = Schema.String.pipe(Schema.pattern(/^(0|[1-9]\d*)$/));

export const TimestampSchema = Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}T/));

export const ArtifactEnvelopeSchema = Schema.Struct({
  id: ArtifactIdSchema,
  kind: KindSchema,
  title: Schema.NonEmptyString,
  content: Schema.String,
  lifecycle: LifecycleSchema,
  provenance: Schema.Struct({ providerId: Schema.optional(ProviderIdSchema), source: Schema.String }),
  timestamps: Schema.Struct({ createdAt: TimestampSchema, updatedAt: TimestampSchema }),
  sensitivity: SensitivitySchema,
});
export type ArtifactEnvelope = Schema.Schema.Type<typeof ArtifactEnvelopeSchema>;

export const ProviderLocatorSchema = Schema.Struct({
  providerId: ProviderIdSchema,
  nativeId: Schema.NonEmptyString,
  address: Schema.String,
});
export type ProviderLocator = Schema.Schema.Type<typeof ProviderLocatorSchema>;

export const CanonicalCatalogLocationSchema = Schema.Struct({
  role: Schema.Literal(CatalogLocationRole.Canonical),
  locator: ProviderLocatorSchema,
  providerRevision: Schema.NonEmptyString,
});
export const ProjectionCatalogLocationSchema = Schema.Struct({
  role: Schema.Literal(CatalogLocationRole.Projection),
  locator: ProviderLocatorSchema,
  providerRevision: Schema.NonEmptyString,
});
export const CatalogLocationSchema = Schema.Union(CanonicalCatalogLocationSchema, ProjectionCatalogLocationSchema);
export type CatalogLocation = Schema.Schema.Type<typeof CatalogLocationSchema>;

export const ProviderManifestSchema = Schema.Struct({
  providerId: ProviderIdSchema,
  displayName: Schema.NonEmptyString,
  artifactKinds: Schema.Array(KindSchema),
  capabilities: Schema.Array(CapabilitySchema),
  pageSizeLimit: Schema.optional(PositivePageSizeSchema),
});
export type ProviderManifest = Schema.Schema.Type<typeof ProviderManifestSchema>;

export const CatalogRelationSchema = Schema.Struct({
  from: ArtifactIdSchema,
  to: ArtifactIdSchema,
  kind: RelationKindSchema,
  authoritative: Schema.Literal(true),
});
export type CatalogRelation = Schema.Schema.Type<typeof CatalogRelationSchema>;

export const CatalogRecordSchema = Schema.Struct({
  id: ArtifactIdSchema,
  kind: KindSchema,
  lifecycle: LifecycleSchema,
  canonical: CanonicalCatalogLocationSchema,
  projections: Schema.Array(ProjectionCatalogLocationSchema),
  catalogRevision: Schema.NonEmptyString,
  migrationState: Schema.optional(Schema.String),
  relations: Schema.Array(CatalogRelationSchema),
});
export type CatalogRecord = Schema.Schema.Type<typeof CatalogRecordSchema>;

export const RoutingRuleSchema = Schema.Struct({
  kind: KindSchema,
  lifecycle: LifecycleSchema,
  providerId: ProviderIdSchema,
});
const RoutingRulesSchema = Schema.Array(RoutingRuleSchema).pipe(
  Schema.filter((rules) => {
    const keys = rules.map((rule) => `${rule.kind}\u0000${rule.lifecycle}`);
    return new Set(keys).size === keys.length || "routing rules must be unique by artifact kind and lifecycle";
  }),
);
export const RoutingSettingsSchema = Schema.Struct({ rules: RoutingRulesSchema });
export type RoutingRule = Schema.Schema.Type<typeof RoutingRuleSchema>;
export type RoutingSettings = Schema.Schema.Type<typeof RoutingSettingsSchema>;

export const SearchRequestSchema = Schema.Struct({ query: Schema.String, pageToken: Schema.optional(CursorTokenSchema), pageSize: Schema.optional(PositivePageSizeSchema) });
export const ListRequestSchema = Schema.Struct({ pageToken: Schema.optional(CursorTokenSchema), pageSize: Schema.optional(PositivePageSizeSchema) });
export const PageResultSchema = Schema.Struct({ items: Schema.Array(ArtifactEnvelopeSchema), nextPageToken: Schema.optional(CursorTokenSchema) });
export const CreateArtifactRequestSchema = Schema.Struct({ idempotencyKey: Schema.NonEmptyString, artifact: ArtifactEnvelopeSchema });
export const UpdateArtifactRequestSchema = Schema.Struct({ locator: ProviderLocatorSchema, expectedRevision: Schema.String, artifact: ArtifactEnvelopeSchema });
export const WriteResultSchema = Schema.Struct({ locator: ProviderLocatorSchema, revision: Schema.String, artifact: ArtifactEnvelopeSchema });
export type SearchRequest = Schema.Schema.Type<typeof SearchRequestSchema>;
export type ListRequest = Schema.Schema.Type<typeof ListRequestSchema>;
export type PageResult = Schema.Schema.Type<typeof PageResultSchema>;
export type CreateArtifactRequest = Schema.Schema.Type<typeof CreateArtifactRequestSchema>;
export type UpdateArtifactRequest = Schema.Schema.Type<typeof UpdateArtifactRequestSchema>;
export type WriteResult = Schema.Schema.Type<typeof WriteResultSchema>;

export const FailureTag = {
  InvalidInput: "InvalidInput",
  NotFound: "NotFound",
  UnsupportedCapability: "UnsupportedCapability",
  RevisionConflict: "RevisionConflict",
  PermissionDenied: "PermissionDenied",
  ProviderUnavailable: "ProviderUnavailable",
  ProviderProtocolFailure: "ProviderProtocolFailure",
  PartialProjectionFailure: "PartialProjectionFailure",
  Conflict: "Conflict",
} as const;

export class InvalidInput extends Data.TaggedError(FailureTag.InvalidInput)<{ readonly reason: string }> {}
export class NotFound extends Data.TaggedError(FailureTag.NotFound)<{ readonly id: string }> {}
export class UnsupportedCapability extends Data.TaggedError(FailureTag.UnsupportedCapability)<{ readonly providerId: ProviderId; readonly capability: ProviderCapability }> {}
export class RevisionConflict extends Data.TaggedError(FailureTag.RevisionConflict)<{ readonly expected: string; readonly actual: string }> {}
export class PermissionDenied extends Data.TaggedError(FailureTag.PermissionDenied)<{ readonly providerId: ProviderId; readonly operation: string }> {}
export class ProviderUnavailable extends Data.TaggedError(FailureTag.ProviderUnavailable)<{ readonly providerId: ProviderId; readonly reason: string }> {}
export class ProviderProtocolFailure extends Data.TaggedError(FailureTag.ProviderProtocolFailure)<{ readonly providerId: ProviderId; readonly reason: string }> {}
export class PartialProjectionFailure extends Data.TaggedError(FailureTag.PartialProjectionFailure)<{ readonly id: ArtifactId; readonly failedProviderIds: readonly ProviderId[] }> {}
export class Conflict extends Data.TaggedError(FailureTag.Conflict)<{ readonly id: string; readonly reason: string }> {}
export type ArtifactFailure = InvalidInput | NotFound | UnsupportedCapability | RevisionConflict | PermissionDenied | ProviderUnavailable | ProviderProtocolFailure | PartialProjectionFailure | Conflict;

export const decodeStrictUnknown = <A, I>(schema: Schema.Schema<A, I, never>) => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });

export interface NativeRelationsCapability { readonly nativeRelations: (locator: ProviderLocator) => Effect.Effect<readonly CatalogRelation[], ArtifactFailure>; }
export interface DependenciesFrontierCapability { readonly dependenciesFrontier: (locator: ProviderLocator) => Effect.Effect<readonly ProviderLocator[], ArtifactFailure>; }
export interface ClaimsCapability { readonly claims: (locator: ProviderLocator) => Effect.Effect<readonly ArtifactEnvelope[], ArtifactFailure>; }
export interface CommentsAppendCapability { readonly appendComment: (locator: ProviderLocator, comment: string) => Effect.Effect<WriteResult, ArtifactFailure>; }
export interface AttachmentsCapability { readonly attach: (locator: ProviderLocator, attachment: { readonly name: string; readonly mediaType: string; readonly bytes: Uint8Array }) => Effect.Effect<WriteResult, ArtifactFailure>; }
export interface StatusTransitionsCapability { readonly transitionStatus: (locator: ProviderLocator, status: string, expectedRevision: string) => Effect.Effect<WriteResult, ArtifactFailure>; }
export interface ContextInjectionCapability { readonly injectContext: (locator: ProviderLocator, context: readonly ArtifactEnvelope[]) => Effect.Effect<WriteResult, ArtifactFailure>; }
export interface IndexInjectionCapability { readonly injectIndex: (locator: ProviderLocator, indexEntries: readonly { readonly key: string; readonly value: string }[]) => Effect.Effect<WriteResult, ArtifactFailure>; }
export type OptionalProviderCapabilities = Partial<NativeRelationsCapability & DependenciesFrontierCapability & ClaimsCapability & CommentsAppendCapability & AttachmentsCapability & StatusTransitionsCapability & ContextInjectionCapability & IndexInjectionCapability>;

export interface NotesDocumentProvider extends OptionalProviderCapabilities {
  readonly manifest: Effect.Effect<ProviderManifest, ArtifactFailure>;
  readonly search: (request: SearchRequest) => Effect.Effect<PageResult, ArtifactFailure>;
  readonly list: (request: ListRequest) => Effect.Effect<PageResult, ArtifactFailure>;
  readonly read: (locator: ProviderLocator) => Effect.Effect<WriteResult, ArtifactFailure>;
  readonly create: (request: CreateArtifactRequest) => Effect.Effect<WriteResult, ArtifactFailure>;
  readonly update: (request: UpdateArtifactRequest) => Effect.Effect<WriteResult, ArtifactFailure>;
  readonly archive: (locator: ProviderLocator, expectedRevision: string) => Effect.Effect<WriteResult, ArtifactFailure>;
}
export const ProviderRegistry = Context.GenericTag<ProviderRegistry>("pi-env/artifact-collector/ProviderRegistry");
export interface ProviderRegistry { readonly get: (providerId: ProviderId) => Effect.Effect<NotesDocumentProvider, ArtifactFailure>; readonly register: (provider: NotesDocumentProvider) => Effect.Effect<void, ArtifactFailure>; readonly all: Effect.Effect<readonly NotesDocumentProvider[], ArtifactFailure>; }

export const RoutingPolicy = Context.GenericTag<RoutingPolicy>("pi-env/artifact-collector/RoutingPolicy");
export interface RoutingPolicy { readonly resolve: (artifact: Pick<ArtifactEnvelope, "kind" | "lifecycle">) => Effect.Effect<ProviderId, ArtifactFailure>; }

export const ArtifactCatalog = Context.GenericTag<ArtifactCatalog>("pi-env/artifact-collector/ArtifactCatalog");
export interface ArtifactCatalog {
  readonly get: (id: ArtifactId) => Effect.Effect<CatalogRecord, ArtifactFailure>;
  readonly put: (record: CatalogRecord, expectedCatalogRevision?: string) => Effect.Effect<CatalogRecord, ArtifactFailure>;
  readonly addRelation: (relation: CatalogRelation, expectedCatalogRevision?: string) => Effect.Effect<CatalogRelation, ArtifactFailure>;
  readonly listRelations: (id: ArtifactId) => Effect.Effect<readonly CatalogRelation[], ArtifactFailure>;
}
