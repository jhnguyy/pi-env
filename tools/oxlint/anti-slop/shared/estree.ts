import type { ESTree } from "@oxlint/plugins";

export type VisitorKeys = Readonly<Record<string, readonly string[]>>;

export function isEstreeNode(value: unknown): value is ESTree.Node {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

export function isStringLiteral(node: ESTree.Node): node is ESTree.StringLiteral {
	return node.type === "Literal" && typeof node.value === "string";
}

export function childValues(
	node: ESTree.Node,
	visitorKeys: VisitorKeys,
): readonly unknown[] {
	return (visitorKeys[node.type] ?? []).map(
		(key) => Object.getOwnPropertyDescriptor(node, key)?.value,
	);
}
