import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { LinearErrorCode } from "../domain";
import {
  configuredConnectionSelector,
  resolveConnectionReference,
  selectConnection,
} from "../selection";
import type {
  LinearConfigDocument,
  LinearConnectionConfig,
  LinearGrantsDocument,
} from "../storage";

function connection(id: string, urlKey: string, email: string): LinearConnectionConfig {
  return {
    id,
    name: `${urlKey}/${email}`,
    appClientId: "client-1",
    organization: { id: `org-${urlKey}`, name: urlKey, urlKey },
    viewer: { id: `user-${email}`, name: email, displayName: email, email },
    grantedScopes: ["read"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

let root: string;
let originalAgentDir: string | undefined;

beforeEach(async () => {
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  root = await mkdtemp(join(tmpdir(), "linear-selection-test-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describeIfEnabled("linear", "Linear connection selection", () => {
  it("lets trusted project selection override global selection", async () => {
    const project = join(root, "project");
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(
      join(process.env.PI_CODING_AGENT_DIR!, "settings.json"),
      JSON.stringify({
        linear: { connection: "global" },
      }),
    );
    await writeFile(
      join(project, ".pi", "settings.json"),
      JSON.stringify({
        linear: { connection: "project" },
      }),
    );

    await expect(
      configuredConnectionSelector({ cwd: project, isProjectTrusted: () => true }),
    ).resolves.toBe("project");
    await expect(
      configuredConnectionSelector({ cwd: project, isProjectTrusted: () => false }),
    ).resolves.toBe("global");
  });

  it("rejects unknown and ambiguous aliases", () => {
    const first = connection("first-id", "shared", "first@example.com");
    const second = connection("second-id", "shared", "second@example.com");
    const config: LinearConfigDocument = {
      version: 1,
      apps: {},
      connections: { [first.id]: first, [second.id]: second },
    };

    expect(() => resolveConnectionReference("missing", config)).toThrow();
    expect(() => resolveConnectionReference("shared", config)).toThrow();
    try {
      resolveConnectionReference("shared", config);
    } catch (error) {
      expect(error).toMatchObject({ code: LinearErrorCode.ConnectionAmbiguous });
    }
  });

  it("rejects zero or multiple authenticated connections without a selection", async () => {
    const first = connection("first-id", "first", "first@example.com");
    const second = connection("second-id", "second", "second@example.com");
    const config: LinearConfigDocument = {
      version: 1,
      apps: {},
      connections: { [first.id]: first, [second.id]: second },
    };
    const context = { cwd: root, isProjectTrusted: () => true };

    await expect(
      selectConnection(context, config, { version: 1, grants: {} }),
    ).rejects.toMatchObject({
      code: LinearErrorCode.AuthRequired,
    });
    const grant = (connectionId: string) => ({
      connectionId,
      clientId: "client",
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1,
      tokenType: "Bearer",
      scope: "read",
    });
    await expect(
      selectConnection(context, config, {
        version: 1,
        grants: { [first.id]: grant(first.id), [second.id]: grant(second.id) },
      }),
    ).rejects.toMatchObject({ code: LinearErrorCode.ConnectionAmbiguous });
  });

  it("resolves explicit project selection by workspace and user alias", async () => {
    const first = connection("first-id", "first", "first@example.com");
    const second = connection("second-id", "second", "second@example.com");
    const config: LinearConfigDocument = {
      version: 1,
      apps: {},
      connections: { [first.id]: first, [second.id]: second },
      defaultConnection: first.id,
    };
    const grants: LinearGrantsDocument = {
      version: 1,
      grants: {
        [first.id]: {
          connectionId: first.id,
          clientId: "client",
          accessToken: "a",
          refreshToken: "r",
          expiresAt: 1,
          tokenType: "Bearer",
          scope: "read",
        },
        [second.id]: {
          connectionId: second.id,
          clientId: "client",
          accessToken: "a",
          refreshToken: "r",
          expiresAt: 1,
          tokenType: "Bearer",
          scope: "read",
        },
      },
    };

    await expect(
      selectConnection(
        { cwd: root, isProjectTrusted: () => true },
        config,
        grants,
        "second/second@example.com",
      ),
    ).resolves.toMatchObject({ id: second.id });
  });
});
