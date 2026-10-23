import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { DagDependencyMode, DagExecutorKind } from "../dag/contracts.js";
import { validateDagDefinition } from "../dag/validation.js";

export const TextMaxBytes = 8_192;
const Identifier = Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" });
const Definition = Type.Object(
  {
    name: Identifier,
    version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    presenter: Identifier,
    nodes: Type.Array(
      Type.Object(
        {
          id: Identifier,
          instructions: Type.String({ minLength: 1, maxLength: TextMaxBytes }),
          dependencies: Type.Array(
            Type.Object(
              {
                nodeId: Identifier,
                mode: Type.Union([
                  Type.Literal(DagDependencyMode.Required),
                  Type.Literal(DagDependencyMode.Settled),
                ]),
              },
              { additionalProperties: false },
            ),
            { maxItems: 16 },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 16 },
    ),
  },
  { additionalProperties: false },
);
export type WorkflowDefinition = Static<typeof Definition>;
export type WorkflowNode = WorkflowDefinition["nodes"][number];

export const ThreeStageWorkflow: WorkflowDefinition = {
  name: "three-stage",
  version: 1,
  presenter: "present",
  nodes: [
    {
      id: "triage",
      instructions: "Inspect the supplied text. Return a concise triage artifact.",
      dependencies: [],
    },
    {
      id: "confirm",
      instructions: "Check the direct dependency artifact. Return a concise confirmation artifact.",
      dependencies: [{ nodeId: "triage", mode: DagDependencyMode.Required }],
    },
    {
      id: "present",
      instructions:
        "Present the direct dependency outcome. State failed or blocked coverage explicitly.",
      dependencies: [{ nodeId: "confirm", mode: DagDependencyMode.Settled }],
    },
  ],
};

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function workflowKey(name: string, version: number): string {
  return `${name}@${version}`;
}

export function registerDefinitions(
  values: readonly unknown[],
): ReadonlyMap<string, WorkflowDefinition> {
  if (values.length === 0 || values.length > 32)
    throw new Error("invalid_definition: register between 1 and 32 definitions");
  const registry = new Map<string, WorkflowDefinition>();
  for (const value of values) {
    if (!Check(Definition, value))
      throw new Error("invalid_definition: malformed or oversized definition");
    const definition: WorkflowDefinition = {
      name: value.name,
      version: value.version,
      presenter: value.presenter,
      nodes: value.nodes.map((node) => ({
        id: node.id,
        instructions: node.instructions,
        dependencies: node.dependencies.map((dependency) => ({
          nodeId: dependency.nodeId,
          mode: dependency.mode,
        })),
      })),
    };
    if (definition.nodes.some((node) => Buffer.byteLength(node.instructions) > TextMaxBytes))
      throw new Error("invalid_definition: oversized instructions");
    const validation = validateDagDefinition(
      {
        runId: workflowKey(definition.name, definition.version),
        concurrency: definition.nodes.length,
        nodes: definition.nodes.map((node) => ({
          id: node.id,
          dependencies: node.dependencies,
          executor: { kind: DagExecutorKind.Subagent, key: node.id, payload: null },
        })),
      },
      { maxNodes: 16, maxEdges: 64, maxConcurrency: 16 },
    );
    if (validation._tag === "invalid")
      throw new Error(
        `invalid_definition: ${validation.errors.map((error) => error._tag).join(", ")}`,
      );
    const byId = new Map(definition.nodes.map((node) => [node.id, node]));
    const ancestors = new Set<string>();
    const visit = (id: string): void => {
      if (ancestors.has(id)) return;
      ancestors.add(id);
      for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency.nodeId);
    };
    visit(definition.presenter);
    if (!byId.has(definition.presenter) || ancestors.size !== definition.nodes.length)
      throw new Error("invalid_definition: presenter must cover every node");
    const key = workflowKey(definition.name, definition.version);
    if (registry.has(key)) throw new Error("invalid_definition: duplicate registered version");
    registry.set(key, definition);
  }
  return registry;
}
