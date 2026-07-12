import { ArtifactKind, ArtifactLifecycle, ArtifactSensitivity, type ArtifactEnvelope, ArtifactId, ProviderCapability, ProviderId, type ProviderManifest, type ProviderLocator, type RoutingSettings } from "./contract";

const createdAt = "2025-01-01T00:00:00.000Z";

export const FixtureProviderId = {
  LocalMarkdown: ProviderId("local-markdown"),
  GenericNotes: ProviderId("generic-notes"),
  LinearLike: ProviderId("linear-like"),
  GitIssues: ProviderId("git-issues"),
} as const;

const baseCapabilities = [
  ProviderCapability.Search,
  ProviderCapability.List,
  ProviderCapability.Read,
  ProviderCapability.Create,
  ProviderCapability.Update,
  ProviderCapability.Archive,
  ProviderCapability.Manifest,
] as const;

export const fixtureManifests: readonly ProviderManifest[] = [
  { providerId: FixtureProviderId.LocalMarkdown, displayName: "Local Markdown", artifactKinds: [ArtifactKind.Specification, ArtifactKind.Decision, ArtifactKind.Report], capabilities: [...baseCapabilities], pageSizeLimit: 50 },
  { providerId: FixtureProviderId.GenericNotes, displayName: "Generic Notes", artifactKinds: [ArtifactKind.Question, ArtifactKind.Assumption, ArtifactKind.Finding], capabilities: [...baseCapabilities, ProviderCapability.CommentsAppend, ProviderCapability.ContextInjection], pageSizeLimit: 25 },
  { providerId: FixtureProviderId.LinearLike, displayName: "Linear-like Issues", artifactKinds: [ArtifactKind.Task, ArtifactKind.Hypothesis], capabilities: [...baseCapabilities, ProviderCapability.StatusTransitions, ProviderCapability.NativeRelations, ProviderCapability.DependenciesFrontier, ProviderCapability.Claims], pageSizeLimit: 100 },
  { providerId: FixtureProviderId.GitIssues, displayName: "Git-hosted Issues", artifactKinds: [ArtifactKind.Task, ArtifactKind.Evidence], capabilities: [...baseCapabilities, ProviderCapability.CommentsAppend, ProviderCapability.Attachments, ProviderCapability.IndexInjection], pageSizeLimit: 100 },
];

export const fixtureArtifacts: readonly ArtifactEnvelope[] = [
  { id: ArtifactId("art-local-readme"), kind: ArtifactKind.Specification, title: "README", content: "# Portable markdown", lifecycle: ArtifactLifecycle.Durable, provenance: { providerId: FixtureProviderId.LocalMarkdown, source: "local markdown file" }, timestamps: { createdAt, updatedAt: createdAt }, sensitivity: ArtifactSensitivity.Internal },
  { id: ArtifactId("art-note-context"), kind: ArtifactKind.Question, title: "Context note", content: "A generic notes service item.", lifecycle: ArtifactLifecycle.Scratch, provenance: { providerId: FixtureProviderId.GenericNotes, source: "notes service document" }, timestamps: { createdAt, updatedAt: createdAt }, sensitivity: ArtifactSensitivity.Restricted },
  { id: ArtifactId("art-linear-issue"), kind: ArtifactKind.Task, title: "Linear-like issue", content: "Issue semantics without team/project backend fields.", lifecycle: ArtifactLifecycle.Promoted, provenance: { providerId: FixtureProviderId.LinearLike, source: "issue tracker" }, timestamps: { createdAt, updatedAt: createdAt }, sensitivity: ArtifactSensitivity.Internal },
  { id: ArtifactId("art-git-issue"), kind: ArtifactKind.Task, title: "Git issue", content: "Git-hosted issue semantics without repo/number fields.", lifecycle: ArtifactLifecycle.Durable, provenance: { providerId: FixtureProviderId.GitIssues, source: "git hosted issue" }, timestamps: { createdAt, updatedAt: createdAt }, sensitivity: ArtifactSensitivity.Public },
];

export const providerRepresentationFixtures: readonly { readonly providerId: ProviderId; readonly locator: ProviderLocator; readonly providerNativeKind: string; readonly artifact: ArtifactEnvelope }[] = [
  { providerId: FixtureProviderId.LocalMarkdown, locator: { providerId: FixtureProviderId.LocalMarkdown, nativeId: "README.md", address: "file://README.md" }, providerNativeKind: "markdown-document", artifact: fixtureArtifacts[0] },
  { providerId: FixtureProviderId.GenericNotes, locator: { providerId: FixtureProviderId.GenericNotes, nativeId: "n1", address: "notes://n1" }, providerNativeKind: "note", artifact: fixtureArtifacts[1] },
  { providerId: FixtureProviderId.LinearLike, locator: { providerId: FixtureProviderId.LinearLike, nativeId: "LIN-1", address: "linear://LIN-1" }, providerNativeKind: "issue", artifact: fixtureArtifacts[2] },
  { providerId: FixtureProviderId.GitIssues, locator: { providerId: FixtureProviderId.GitIssues, nativeId: "owner/repo#1", address: "github://owner/repo/issues/1" }, providerNativeKind: "issue", artifact: fixtureArtifacts[3] },
];

export const fixtureRouting: RoutingSettings = {
  rules: [
    { kind: ArtifactKind.Specification, lifecycle: ArtifactLifecycle.Durable, providerId: FixtureProviderId.LocalMarkdown },
    { kind: ArtifactKind.Question, lifecycle: ArtifactLifecycle.Scratch, providerId: FixtureProviderId.GenericNotes },
    { kind: ArtifactKind.Task, lifecycle: ArtifactLifecycle.Promoted, providerId: FixtureProviderId.LinearLike },
    { kind: ArtifactKind.Decision, lifecycle: ArtifactLifecycle.Ephemeral, providerId: FixtureProviderId.LocalMarkdown },
  ],
};
