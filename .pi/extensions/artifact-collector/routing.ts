import { Effect, Layer } from "effect";
import {
  type ArtifactEnvelope,
  type ArtifactFailure,
  type ArtifactLifecycle,
  type ArtifactKind,
  InvalidInput,
  type NotesDocumentProvider,
  ProviderCapability,
  type ProviderId,
  ProviderProtocolFailure,
  type RoutingPolicy,
  RoutingPolicy as RoutingPolicyTag,
  type RoutingSettings,
  UnsupportedCapability,
} from "./contract";

export function hasCapability(provider: { readonly capabilities: readonly string[] }, capability: string): boolean {
  return provider.capabilities.includes(capability);
}

export function requireCapability(
  manifest: { readonly providerId: ProviderId; readonly capabilities: readonly string[] },
  capability: ProviderCapability,
): Effect.Effect<void, ArtifactFailure> {
  return hasCapability(manifest, capability)
    ? Effect.void
    : Effect.fail(new UnsupportedCapability({ providerId: manifest.providerId, capability }));
}

export function resolveRoute(
  settings: RoutingSettings,
  artifact: Pick<ArtifactEnvelope, "kind" | "lifecycle">,
): ProviderId | undefined {
  return settings.rules.find((rule) => rule.kind === artifact.kind && rule.lifecycle === artifact.lifecycle)?.providerId;
}

export function makeRoutingPolicy(settings: RoutingSettings): RoutingPolicy {
  return {
    resolve: (artifact) => {
      const providerId = resolveRoute(settings, artifact);
      return providerId === undefined
        ? Effect.fail(new InvalidInput({ reason: `no route for ${artifact.kind}/${artifact.lifecycle}` }))
        : Effect.succeed(providerId);
    },
  };
}

export function routingPolicyLayer(settings: RoutingSettings): Layer.Layer<RoutingPolicy> {
  return Layer.succeed(RoutingPolicyTag, makeRoutingPolicy(settings));
}

export const ROUTING_MATRIX_KEYS = ["kind", "lifecycle"] as const satisfies readonly ["kind", "lifecycle"];
export type RouteKey = { readonly kind: ArtifactKind; readonly lifecycle: ArtifactLifecycle };

export function providerSupportsBaseContract(provider: NotesDocumentProvider) {
  return provider.manifest.pipe(
    Effect.flatMap((manifest) =>
      Effect.all([
        requireCapability(manifest, ProviderCapability.Search),
        requireCapability(manifest, ProviderCapability.List),
        requireCapability(manifest, ProviderCapability.Read),
        requireCapability(manifest, ProviderCapability.Create),
        requireCapability(manifest, ProviderCapability.Update),
        requireCapability(manifest, ProviderCapability.Archive),
        requireCapability(manifest, ProviderCapability.Manifest),
      ], { discard: true }),
    ),
  );
}

const OPTIONAL_CAPABILITY_METHODS = {
  [ProviderCapability.NativeRelations]: "nativeRelations",
  [ProviderCapability.DependenciesFrontier]: "dependenciesFrontier",
  [ProviderCapability.Claims]: "claims",
  [ProviderCapability.CommentsAppend]: "appendComment",
  [ProviderCapability.Attachments]: "attach",
  [ProviderCapability.StatusTransitions]: "transitionStatus",
  [ProviderCapability.ContextInjection]: "injectContext",
  [ProviderCapability.IndexInjection]: "injectIndex",
} as const;

export function validateAdvertisedOptionalCapabilities(provider: NotesDocumentProvider): Effect.Effect<void, ArtifactFailure> {
  return provider.manifest.pipe(
    Effect.flatMap((manifest) => Effect.forEach(Object.entries(OPTIONAL_CAPABILITY_METHODS), ([capability, method]) => {
      return manifest.capabilities.includes(capability as ProviderCapability) && typeof provider[method as keyof NotesDocumentProvider] !== "function"
        ? Effect.fail(new ProviderProtocolFailure({ providerId: manifest.providerId, reason: `advertises ${capability} without implementing ${method}` }))
        : Effect.void;
    }, { discard: true })),
  );
}
