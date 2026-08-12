import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import { loadSettingsSnapshotEffect, isObject } from "../_shared/settings";
import { LinearErrorCode, linearError } from "./domain";
import { runLinear } from "./effect-runtime";
import type { LinearConfigDocument, LinearConnectionConfig, LinearGrantsDocument } from "./storage";

const LinearSettingsSchema = Schema.Struct({
  connection: Schema.optionalKey(Schema.String),
});

export type LinearSelectionContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

export async function configuredConnectionSelector(
  ctx: LinearSelectionContext,
): Promise<string | undefined> {
  try {
    const snapshot = await runLinear(
      loadSettingsSnapshotEffect(ctx.cwd).pipe(
        Effect.mapError((cause) =>
          linearError(LinearErrorCode.Validation, "The linear settings block is invalid.", {
            cause,
          }),
        ),
      ),
    );
    const globalBlock = isObject(snapshot.global.linear) ? snapshot.global.linear : {};
    const projectBlock =
      ctx.isProjectTrusted() && isObject(snapshot.project.linear) ? snapshot.project.linear : {};
    return Schema.decodeUnknownSync(LinearSettingsSchema)({ ...globalBlock, ...projectBlock })
      .connection;
  } catch (cause) {
    throw linearError(LinearErrorCode.Validation, "The linear settings block is invalid.", {
      recovery: "Set linear.connection to a connection ID, name, workspace key, or user email.",
      cause,
    });
  }
}

export function connectionAliases(connection: LinearConnectionConfig): string[] {
  return [
    connection.id,
    connection.name,
    connection.organization.id,
    connection.organization.urlKey,
    connection.viewer.email,
    `${connection.organization.urlKey}/${connection.viewer.email}`,
  ];
}

export function resolveConnectionReference(
  reference: string,
  config: LinearConfigDocument,
): LinearConnectionConfig {
  const normalized = reference.trim().toLowerCase();
  const matches = Object.values(config.connections).filter((connection) =>
    connectionAliases(connection).some((alias) => alias.toLowerCase() === normalized),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw linearError(
      LinearErrorCode.ConnectionNotFound,
      `Unknown Linear connection: ${reference}.`,
      {
        recovery: "Run /linear-auth list, then select a listed connection.",
      },
    );
  }
  throw linearError(
    LinearErrorCode.ConnectionAmbiguous,
    `Linear connection is ambiguous: ${reference}.`,
    {
      recovery: "Use the full connection ID from /linear-auth list.",
      details: { candidates: matches.map((connection) => connection.id) },
    },
  );
}

export async function selectConnection(
  ctx: LinearSelectionContext,
  config: LinearConfigDocument,
  grants: LinearGrantsDocument,
  explicitReference?: string,
): Promise<LinearConnectionConfig> {
  const reference =
    explicitReference ?? (await configuredConnectionSelector(ctx)) ?? config.defaultConnection;
  if (reference) return resolveConnectionReference(reference, config);

  const authenticated = Object.keys(grants.grants)
    .map((id) => config.connections[id])
    .filter((connection): connection is LinearConnectionConfig => Boolean(connection));
  if (authenticated.length === 1) return authenticated[0]!;
  if (authenticated.length === 0) {
    throw linearError(LinearErrorCode.AuthRequired, "Linear is not authenticated.", {
      recovery: "Run /linear-auth login.",
    });
  }
  throw linearError(
    LinearErrorCode.ConnectionAmbiguous,
    "More than one Linear connection is authenticated.",
    {
      recovery: "Run /linear-auth use <connection>, or set linear.connection in project settings.",
      details: { candidates: authenticated.map((connection) => connection.id) },
    },
  );
}
