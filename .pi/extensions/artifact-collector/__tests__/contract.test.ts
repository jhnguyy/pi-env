import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ArtifactEnvelopeSchema,
  ArtifactKind,
  ARTIFACT_KINDS,
  ArtifactLifecycle,
  ARTIFACT_LIFECYCLES,
  ArtifactSensitivity,
  ARTIFACT_SENSITIVITIES,
  CatalogLocationRole,
  CATALOG_LOCATION_ROLES,
  CatalogRecordSchema,
  Conflict,
  decodeStrictUnknown,
  FailureTag,
  InvalidInput,
  NotFound,
  PartialProjectionFailure,
  PermissionDenied,
  ProviderCapability,
  PROVIDER_CAPABILITIES,
  ProviderId,
  ProviderProtocolFailure,
  ProviderUnavailable,
  RelationKind,
  RELATION_KINDS,
  RevisionConflict,
  RoutingSettingsSchema,
  UnsupportedCapability,
  type CatalogRecord,
  type NotesDocumentProvider,
} from "../contract";
import { fixtureArtifacts, fixtureManifests, fixtureRouting, FixtureProviderId, providerRepresentationFixtures } from "../fixtures";
import { makeInMemoryArtifactCatalog, makeInMemoryNotesDocumentProvider } from "../memory";
import { providerSupportsBaseContract, resolveRoute, validateAdvertisedOptionalCapabilities } from "../routing";

async function expectFailureTag(effect: Effect.Effect<unknown, unknown>, tag: string) {
  const exit = await Effect.runPromiseExit(effect);
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") expect(String(exit.cause)).toContain(tag);
}

describe("artifact collector contract spike", () => {
  it("keeps const vocabularies aligned with schemas", () => {
    expect(new Set(ARTIFACT_KINDS)).toEqual(new Set(Object.values(ArtifactKind)));
    expect(new Set(ARTIFACT_LIFECYCLES)).toEqual(new Set(Object.values(ArtifactLifecycle)));
    expect(new Set(ARTIFACT_SENSITIVITIES)).toEqual(new Set(Object.values(ArtifactSensitivity)));
    expect(new Set(PROVIDER_CAPABILITIES)).toEqual(new Set(Object.values(ProviderCapability)));
    expect(new Set(RELATION_KINDS)).toEqual(new Set(Object.values(RelationKind)));
    expect(new Set(CATALOG_LOCATION_ROLES)).toEqual(new Set(Object.values(CatalogLocationRole)));
    expect(ARTIFACT_KINDS).not.toContain("markdown-document");
    expect(ARTIFACT_KINDS).not.toContain("note");
    expect(ARTIFACT_KINDS).not.toContain("issue");
    expect(ARTIFACT_KINDS).not.toContain("claim");
    expect(ARTIFACT_LIFECYCLES).not.toContain("draft");
    expect(ARTIFACT_LIFECYCLES).not.toContain("active");
    expect(ARTIFACT_LIFECYCLES).not.toContain("superseded");
    expect(ARTIFACT_SENSITIVITIES).not.toContain("secret");
  });

  it("decodes portable artifact envelopes and explicitly rejects provider-specific excess fields at the boundary", () => {
    const fixture = fixtureArtifacts[2];
    expect(decodeStrictUnknown(ArtifactEnvelopeSchema)(fixture)).toEqual(fixture);
    expect(() => decodeStrictUnknown(ArtifactEnvelopeSchema)({ ...fixture, linearTeamKey: "ENG" })).toThrow();
    expect(() => Schema.decodeUnknownSync(ArtifactEnvelopeSchema)({ ...fixture, lifecycle: "triaged" })).toThrow();
  });

  it("fits markdown, notes, Linear-like, and Git issue provider representations without backend kinds in the envelope", () => {
    for (const representation of providerRepresentationFixtures) {
      expect(["markdown-document", "note", "issue", "claim"]).toContain(representation.providerNativeKind);
      expect(["markdown-document", "note", "issue", "claim"]).not.toContain(representation.artifact.kind);
      const keys = Object.keys(Schema.encodeSync(ArtifactEnvelopeSchema)(representation.artifact));
      expect(keys).toEqual(["id", "kind", "title", "content", "lifecycle", "provenance", "timestamps", "sensitivity"]);
    }
  });

  it("resolves routes explicitly and rejects ambiguous route configuration", () => {
    expect(resolveRoute(fixtureRouting, { kind: ArtifactKind.Task, lifecycle: ArtifactLifecycle.Promoted })).toBe(FixtureProviderId.LinearLike);
    expect(resolveRoute(fixtureRouting, { kind: ArtifactKind.Task, lifecycle: ArtifactLifecycle.Ephemeral })).toBeUndefined();
    expect(() => decodeStrictUnknown(RoutingSettingsSchema)({
      rules: [fixtureRouting.rules[0], { ...fixtureRouting.rules[0], providerId: FixtureProviderId.GenericNotes }],
    })).toThrow();
  });

  it("stores catalog locations with role, locator, provider revision, control-plane revision, and authoritative relations", async () => {
    const [artifact, target] = fixtureArtifacts;
    const record: CatalogRecord = {
      id: artifact.id,
      kind: artifact.kind,
      lifecycle: artifact.lifecycle,
      canonical: { role: CatalogLocationRole.Canonical, locator: { providerId: FixtureProviderId.LocalMarkdown, nativeId: "README.md", address: "file://README.md" }, providerRevision: "md-r1" },
      projections: [{ role: CatalogLocationRole.Projection, locator: { providerId: FixtureProviderId.GenericNotes, nativeId: "n1", address: "notes://n1" }, providerRevision: "notes-r7" }],
      catalogRevision: "c1",
      relations: [],
    };
    const targetRecord: CatalogRecord = {
      ...record,
      id: target.id,
      canonical: { role: CatalogLocationRole.Canonical, locator: { providerId: FixtureProviderId.GenericNotes, nativeId: "n2", address: "notes://n2" }, providerRevision: "notes-r1" },
      projections: [],
    };
    const catalog = makeInMemoryArtifactCatalog([record, targetRecord]);
    const relation = { from: artifact.id, to: target.id, kind: RelationKind.References, authoritative: true } as const;
    await Effect.runPromise(catalog.addRelation(relation, "c1"));
    await Effect.runPromise(catalog.addRelation(relation));
    const stored = await Effect.runPromise(catalog.get(artifact.id));
    expect(decodeStrictUnknown(CatalogRecordSchema)(stored).projections).toHaveLength(1);
    expect(stored.catalogRevision).toBe("c1+1");
    expect(await Effect.runPromise(catalog.listRelations(artifact.id))).toEqual([relation]);
  });

  it("validates optional capability advertisements against implemented optional interfaces", async () => {
    const bad = makeInMemoryNotesDocumentProvider({ manifest: fixtureManifests[1] });
    await expectFailureTag(validateAdvertisedOptionalCapabilities(bad), FailureTag.ProviderProtocolFailure);

    const good: NotesDocumentProvider = {
      ...makeInMemoryNotesDocumentProvider({ manifest: fixtureManifests[1] }),
      appendComment: (_locator, _comment) => Effect.fail(new PermissionDenied({ providerId: FixtureProviderId.GenericNotes, operation: "appendComment" })),
      injectContext: (_locator, _context) => Effect.fail(new ProviderUnavailable({ providerId: FixtureProviderId.GenericNotes, reason: "offline" })),
    };
    await Effect.runPromise(validateAdvertisedOptionalCapabilities(good));
  });

  it("enforces base provider capabilities as typed failures", async () => {
    const manifest = { ...fixtureManifests[0], capabilities: [ProviderCapability.Read] };
    const provider = makeInMemoryNotesDocumentProvider({ manifest });
    await expectFailureTag(providerSupportsBaseContract(provider), UnsupportedCapability.name);
  });

  it("accepts only bounded positive page sizes and non-negative cursor tokens", async () => {
    const provider = makeInMemoryNotesDocumentProvider({ manifest: fixtureManifests[0], artifacts: fixtureArtifacts.slice(0, 1).map((artifact) => ({ artifact, locator: { providerId: FixtureProviderId.LocalMarkdown, nativeId: artifact.id, address: `${FixtureProviderId.LocalMarkdown}:${artifact.id}` }, revision: "r0" })) });
    expect((await Effect.runPromise(provider.list({ pageSize: 1, pageToken: "0" }))).items).toHaveLength(1);
    await expectFailureTag(provider.list({ pageSize: 0 }), InvalidInput.name);
    await expectFailureTag(provider.list({ pageSize: -1 }), InvalidInput.name);
    await expectFailureTag(provider.list({ pageSize: Number.NaN }), InvalidInput.name);
    await expectFailureTag(provider.list({ pageToken: "-1" }), InvalidInput.name);
    await expectFailureTag(provider.list({ pageToken: "1.5" }), InvalidInput.name);
  });

  it("enforces provider identity, supported kinds, idempotent create, revision checked update, and archive", async () => {
    const provider = makeInMemoryNotesDocumentProvider({ manifest: fixtureManifests[0] });
    const artifact = fixtureArtifacts[0];
    const first = await Effect.runPromise(provider.create({ idempotencyKey: "same", artifact }));
    expect(await Effect.runPromise(provider.create({ idempotencyKey: "same", artifact }))).toEqual(first);
    await expectFailureTag(provider.create({ idempotencyKey: "same", artifact: { ...artifact, title: "different request" } }), Conflict.name);
    await expectFailureTag(provider.create({ idempotencyKey: "different", artifact: { ...artifact, title: "must not overwrite" } }), Conflict.name);
    await expectFailureTag(provider.create({ idempotencyKey: "unsupported", artifact: { ...artifact, kind: ArtifactKind.Evidence } }), InvalidInput.name);

    await expectFailureTag(provider.read({ ...first.locator, providerId: FixtureProviderId.GenericNotes }), InvalidInput.name);
    await expectFailureTag(provider.read({ ...first.locator, nativeId: "wrong-native-id" }), InvalidInput.name);
    await expectFailureTag(provider.update({ locator: first.locator, expectedRevision: "stale", artifact }), RevisionConflict.name);

    const updated = await Effect.runPromise(provider.update({ locator: first.locator, expectedRevision: first.revision, artifact: { ...artifact, title: "updated" } }));
    expect(updated.revision).not.toBe(first.revision);
    const archived = await Effect.runPromise(provider.archive(first.locator, updated.revision));
    expect(archived.artifact.lifecycle).toBe(ArtifactLifecycle.Archived);
  });

  it("catalog schema and mutation enforce canonical location, revisions, endpoints, and list existence", async () => {
    const [artifact, target] = fixtureArtifacts;
    const canonicalLocation = {
      role: CatalogLocationRole.Canonical,
      locator: { providerId: FixtureProviderId.LocalMarkdown, nativeId: "artifact", address: "file://artifact" },
      providerRevision: "r1",
    } as const;
    const base: CatalogRecord = { id: artifact.id, kind: artifact.kind, lifecycle: artifact.lifecycle, canonical: canonicalLocation, projections: [], catalogRevision: "c1", relations: [] };
    const targetRecord: CatalogRecord = {
      id: target.id,
      kind: target.kind,
      lifecycle: target.lifecycle,
      canonical: { ...canonicalLocation, locator: { ...canonicalLocation.locator, nativeId: "target", address: "file://target" } },
      projections: [],
      catalogRevision: "c1",
      relations: [],
    };
    const { canonical: _canonical, ...withoutCanonical } = base;
    expect(() => decodeStrictUnknown(CatalogRecordSchema)(withoutCanonical)).toThrow();
    expect(() => decodeStrictUnknown(CatalogRecordSchema)({ ...base, canonical: { ...canonicalLocation, role: CatalogLocationRole.Projection } })).toThrow();
    const catalog = makeInMemoryArtifactCatalog([base, targetRecord]);
    await expectFailureTag(catalog.put({ ...base, catalogRevision: "c2" }, "stale"), RevisionConflict.name);
    await expectFailureTag(catalog.addRelation({ from: artifact.id, to: fixtureArtifacts[2].id, kind: RelationKind.Blocks, authoritative: true }), NotFound.name);
    await expectFailureTag(catalog.listRelations(fixtureArtifacts[2].id), NotFound.name);
  });

  it("covers every required typed failure tag via construction or propagation", async () => {
    expect(new InvalidInput({ reason: "bad" })._tag).toBe(FailureTag.InvalidInput);
    expect(new NotFound({ id: "missing" })._tag).toBe(FailureTag.NotFound);
    expect(new UnsupportedCapability({ providerId: FixtureProviderId.LocalMarkdown, capability: ProviderCapability.Claims })._tag).toBe(FailureTag.UnsupportedCapability);
    expect(new RevisionConflict({ expected: "a", actual: "b" })._tag).toBe(FailureTag.RevisionConflict);
    expect(new PermissionDenied({ providerId: FixtureProviderId.LocalMarkdown, operation: "write" })._tag).toBe(FailureTag.PermissionDenied);
    expect(new ProviderUnavailable({ providerId: FixtureProviderId.LocalMarkdown, reason: "down" })._tag).toBe(FailureTag.ProviderUnavailable);
    expect(new ProviderProtocolFailure({ providerId: FixtureProviderId.LocalMarkdown, reason: "bad shape" })._tag).toBe(FailureTag.ProviderProtocolFailure);
    expect(new PartialProjectionFailure({ id: fixtureArtifacts[0].id, failedProviderIds: [FixtureProviderId.GenericNotes] })._tag).toBe(FailureTag.PartialProjectionFailure);

    const fakeProvider: NotesDocumentProvider = {
      manifest: Effect.succeed(fixtureManifests[0]),
      search: () => Effect.fail(new ProviderUnavailable({ providerId: FixtureProviderId.LocalMarkdown, reason: "offline" })),
      list: () => Effect.fail(new ProviderProtocolFailure({ providerId: FixtureProviderId.LocalMarkdown, reason: "bad cursor" })),
      read: () => Effect.fail(new PermissionDenied({ providerId: FixtureProviderId.LocalMarkdown, operation: "read" })),
      create: () => Effect.fail(new PartialProjectionFailure({ id: fixtureArtifacts[0].id, failedProviderIds: [FixtureProviderId.GenericNotes] })),
      update: () => Effect.fail(new RevisionConflict({ expected: "x", actual: "y" })),
      archive: () => Effect.fail(new NotFound({ id: "x" })),
    };
    await expectFailureTag(fakeProvider.search({ query: "x" }), FailureTag.ProviderUnavailable);
    await expectFailureTag(fakeProvider.list({}), FailureTag.ProviderProtocolFailure);
    await expectFailureTag(fakeProvider.read({ providerId: ProviderId("p"), nativeId: "n", address: "a" }), FailureTag.PermissionDenied);
    await expectFailureTag(fakeProvider.create({ idempotencyKey: "k", artifact: fixtureArtifacts[0] }), FailureTag.PartialProjectionFailure);
  });
});
