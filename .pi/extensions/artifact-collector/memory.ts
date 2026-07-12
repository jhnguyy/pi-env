import { Effect, Layer, Schema } from "effect";
import {
  type ArtifactCatalog,
  ArtifactCatalog as ArtifactCatalogTag,
  ArtifactLifecycle,
  type ArtifactEnvelope,
  type ArtifactFailure,
  type ArtifactId,
  type CatalogRecord,
  type CatalogRelation,
  type CreateArtifactRequest,
  Conflict,
  CursorTokenSchema,
  InvalidInput,
  type ListRequest,
  NotFound,
  type NotesDocumentProvider,
  type PageResult,
  PositivePageSizeSchema,
  type ProviderId,
  type ProviderLocator,
  type ProviderManifest,
  ProviderCapability,
  type ProviderRegistry,
  ProviderRegistry as ProviderRegistryTag,
  RevisionConflict,
  type SearchRequest,
  type UpdateArtifactRequest,
  type WriteResult,
} from "./contract";
import { requireCapability } from "./routing";

export function makeInMemoryProviderRegistry(initial: readonly NotesDocumentProvider[] = []): ProviderRegistry {
  const providers = new Map<string, NotesDocumentProvider>();
  const readManifest = (provider: NotesDocumentProvider) => Effect.map(provider.manifest, (manifest) => manifest.providerId);
  return {
    get: (providerId) => Effect.fromNullable(providers.get(providerId)).pipe(Effect.mapError(() => new NotFound({ id: providerId }))),
    register: (provider) => Effect.flatMap(readManifest(provider), (id) => Effect.sync(() => { providers.set(id, provider); })),
    all: Effect.sync(() => [...providers.values()]),
  };
}

export function providerRegistryLayer(initial: readonly NotesDocumentProvider[] = []): Layer.Layer<ProviderRegistry, ArtifactFailure> {
  const registry = makeInMemoryProviderRegistry();
  return Layer.effect(ProviderRegistryTag, Effect.as(Effect.forEach(initial, registry.register), registry));
}

export interface InMemoryProviderOptions {
  readonly manifest: ProviderManifest;
  readonly artifacts?: readonly WriteResult[];
}

function validatePageRequest(request: ListRequest): Effect.Effect<{ readonly offset: number; readonly limit?: number }, ArtifactFailure> {
  return Effect.try({
    try: () => {
      if (request.pageToken !== undefined) Schema.decodeUnknownSync(CursorTokenSchema)(request.pageToken);
      if (request.pageSize !== undefined) Schema.decodeUnknownSync(PositivePageSizeSchema)(request.pageSize);
      return { offset: Number(request.pageToken ?? 0), ...(request.pageSize === undefined ? {} : { limit: request.pageSize }) };
    },
    catch: (error) => new InvalidInput({ reason: String(error) }),
  });
}

export function makeInMemoryNotesDocumentProvider(options: InMemoryProviderOptions): NotesDocumentProvider {
  const manifest = options.manifest;
  const byAddress = new Map<string, WriteResult>();
  const idempotency = new Map<string, WriteResult>();
  let revisionCounter = 1;
  for (const result of options.artifacts ?? []) byAddress.set(result.locator.address, result);

  const ensure = (capability: ProviderCapability) => requireCapability(manifest, capability);
  const page = (items: ArtifactEnvelope[], request: ListRequest): Effect.Effect<PageResult, ArtifactFailure> => validatePageRequest(request).pipe(Effect.map(({ offset, limit }) => {
    const boundedLimit = Math.min(limit ?? manifest.pageSizeLimit ?? items.length, manifest.pageSizeLimit ?? 1000);
    const selected = items.slice(offset, offset + boundedLimit);
    const next = offset + boundedLimit < items.length ? String(offset + boundedLimit) : undefined;
    return { items: selected, ...(next === undefined ? {} : { nextPageToken: next }) };
  }));
  const nextRevision = () => `r${revisionCounter++}`;
  const locatorFor = (artifact: ArtifactEnvelope): ProviderLocator => ({ providerId: manifest.providerId, nativeId: artifact.id, address: `${manifest.providerId}:${artifact.id}` });
  const ensureArtifactKind = (artifact: ArtifactEnvelope): Effect.Effect<void, ArtifactFailure> =>
    manifest.artifactKinds.includes(artifact.kind)
      ? Effect.void
      : Effect.fail(new InvalidInput({ reason: `provider ${manifest.providerId} does not support artifact kind ${artifact.kind}` }));
  const readLocated = (locator: ProviderLocator): Effect.Effect<WriteResult, ArtifactFailure> => {
    if (locator.providerId !== manifest.providerId) {
      return Effect.fail(new InvalidInput({ reason: `locator provider ${locator.providerId} does not match ${manifest.providerId}` }));
    }
    const current = byAddress.get(locator.address);
    if (!current) return Effect.fail(new NotFound({ id: locator.address }));
    if (current.locator.nativeId !== locator.nativeId || current.locator.providerId !== locator.providerId) {
      return Effect.fail(new InvalidInput({ reason: `locator identity does not match stored artifact at ${locator.address}` }));
    }
    return Effect.succeed(current);
  };

  return {
    manifest: Effect.succeed(manifest),
    search: (request: SearchRequest) => ensure(ProviderCapability.Search).pipe(Effect.flatMap(() => page([...byAddress.values()].map((r) => r.artifact).filter((a) => `${a.title}\n${a.content}`.includes(request.query)), request))),
    list: (request) => ensure(ProviderCapability.List).pipe(Effect.flatMap(() => page([...byAddress.values()].map((r) => r.artifact), request))),
    read: (locator) => ensure(ProviderCapability.Read).pipe(Effect.flatMap(() => readLocated(locator))),
    create: (request: CreateArtifactRequest) => ensure(ProviderCapability.Create).pipe(
      Effect.flatMap(() => ensureArtifactKind(request.artifact)),
      Effect.flatMap(() => {
        const existing = idempotency.get(request.idempotencyKey);
        if (existing) {
          return existing.artifact.id === request.artifact.id && existing.artifact.kind === request.artifact.kind &&
              existing.artifact.title === request.artifact.title && existing.artifact.content === request.artifact.content
            ? Effect.succeed(existing)
            : Effect.fail(new Conflict({ id: request.idempotencyKey, reason: "idempotency key was already used for a different artifact" }));
        }
        const locator = locatorFor(request.artifact);
        const addressOwner = byAddress.get(locator.address);
        if (addressOwner) return Effect.fail(new Conflict({ id: locator.address, reason: "native address already exists for a different idempotency key" }));
        const result = { locator, revision: nextRevision(), artifact: request.artifact };
        byAddress.set(result.locator.address, result);
        idempotency.set(request.idempotencyKey, result);
        return Effect.succeed(result);
      }),
    ),
    update: (request: UpdateArtifactRequest) => ensure(ProviderCapability.Update).pipe(
      Effect.flatMap(() => ensureArtifactKind(request.artifact)),
      Effect.flatMap(() => readLocated(request.locator)),
      Effect.flatMap((current): Effect.Effect<WriteResult, ArtifactFailure> => {
        if (current.artifact.id !== request.artifact.id) return Effect.fail(new InvalidInput({ reason: "updated artifact id must match the stored artifact" }));
        if (current.revision !== request.expectedRevision) return Effect.fail(new RevisionConflict({ expected: request.expectedRevision, actual: current.revision }));
        const updated: WriteResult = { locator: current.locator, revision: nextRevision(), artifact: request.artifact };
        byAddress.set(current.locator.address, updated);
        return Effect.succeed(updated);
      }),
    ),
    archive: (locator, expectedRevision) => ensure(ProviderCapability.Archive).pipe(
      Effect.flatMap(() => readLocated(locator)),
      Effect.flatMap((current): Effect.Effect<WriteResult, ArtifactFailure> => {
        if (current.revision !== expectedRevision) return Effect.fail(new RevisionConflict({ expected: expectedRevision, actual: current.revision }));
        const archived: ArtifactEnvelope = { ...current.artifact, lifecycle: ArtifactLifecycle.Archived };
        const result: WriteResult = { locator: current.locator, revision: nextRevision(), artifact: archived };
        byAddress.set(current.locator.address, result);
        return Effect.succeed(result);
      }),
    ),
  };
}

const relationKey = (relation: CatalogRelation) => `${relation.from}\u0000${relation.kind}\u0000${relation.to}\u0000${relation.authoritative}`;
const bumpRevision = (revision: string) => `${revision}+1`;

export function makeInMemoryArtifactCatalog(initial: readonly CatalogRecord[] = []): ArtifactCatalog {
  const records = new Map<string, CatalogRecord>(initial.map((record) => [record.id, record]));
  return {
    get: (id: ArtifactId) => Effect.fromNullable(records.get(id)).pipe(Effect.mapError(() => new NotFound({ id }))),
    put: (record, expectedCatalogRevision) => Effect.flatMap(Effect.sync(() => records.get(record.id)), (current) => {
      if (expectedCatalogRevision !== undefined && current?.catalogRevision !== expectedCatalogRevision) {
        return Effect.fail(new RevisionConflict({ expected: expectedCatalogRevision, actual: current?.catalogRevision ?? "<missing>" }));
      }
      return Effect.sync(() => { records.set(record.id, record); return record; });
    }),
    addRelation: (relation: CatalogRelation, expectedCatalogRevision?: string) => Effect.flatMap(Effect.sync(() => ({ from: records.get(relation.from), to: records.get(relation.to) })), ({ from, to }): Effect.Effect<CatalogRelation, ArtifactFailure> => {
      if (!from) return Effect.fail(new NotFound({ id: relation.from }));
      if (!to) return Effect.fail(new NotFound({ id: relation.to }));
      if (expectedCatalogRevision !== undefined && from.catalogRevision !== expectedCatalogRevision) return Effect.fail(new RevisionConflict({ expected: expectedCatalogRevision, actual: from.catalogRevision }));
      if (from.relations.some((existing) => relationKey(existing) === relationKey(relation))) return Effect.succeed(relation);
      return Effect.sync(() => {
        records.set(from.id, { ...from, catalogRevision: bumpRevision(from.catalogRevision), relations: [...from.relations, relation] });
        return relation;
      });
    }),
    listRelations: (id) => Effect.flatMap(Effect.sync(() => records.get(id)), (record) => record ? Effect.succeed(record.relations) : Effect.fail(new NotFound({ id }))),
  };
}

export function artifactCatalogLayer(initial: readonly CatalogRecord[] = []): Layer.Layer<ArtifactCatalog> {
  return Layer.succeed(ArtifactCatalogTag, makeInMemoryArtifactCatalog(initial));
}
