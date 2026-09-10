import type { ESTree } from "@oxlint/plugins";

import { childValues, isEstreeNode, type VisitorKeys } from "./estree.ts";

function collectInferTypeParameterNames(
	node: ESTree.Node,
	visitorKeys: VisitorKeys,
	names: Set<string>,
): void {
	if (node.type === "TSInferType") names.add(node.typeParameter.name.name);

	for (const value of childValues(node, visitorKeys)) {
		if (isEstreeNode(value)) {
			collectInferTypeParameterNames(value, visitorKeys, names);
			continue;
		}

		if (!Array.isArray(value)) continue;

		for (const child of value) {
			if (isEstreeNode(child)) collectInferTypeParameterNames(child, visitorKeys, names);
		}
	}
}

/** Collect type binders that are in scope at a node and can shadow module aliases. */
export function lexicalTypeParameterNames(
	node: ESTree.Node,
	visitorKeys: VisitorKeys,
): ReadonlySet<string> {
	const names = new Set<string>();
	let descendant: ESTree.Node = node;
	let current: ESTree.Node | null = node;

	while (current !== null && current.type !== "Program") {
		if ("typeParameters" in current) {
			for (const parameter of current.typeParameters?.params ?? []) {
				names.add(parameter.name.name);
			}
		}

		if (
			current.type === "TSMappedType" &&
			(descendant === current.nameType || descendant === current.typeAnnotation)
		) {
			names.add(current.key.name);
		}

		if (current.type === "TSConditionalType" && descendant === current.trueType) {
			collectInferTypeParameterNames(current.extendsType, visitorKeys, names);
		}

		descendant = current;
		current = current.parent;
	}

	return names;
}
