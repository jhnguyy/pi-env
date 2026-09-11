import type { ESTree } from "@oxlint/plugins";

import { isStringLiteral } from "../../shared/estree.ts";

export { isStringLiteral } from "../../shared/estree.ts";

const equalityOperators = new Set(["==", "===", "!=", "!=="]);

const broadEffectCatchMethods = new Set(["catch", "catchAll", "catchIf"]);

export const isTagMember = (
	node: ESTree.Node | null | undefined,
): node is ESTree.MemberExpression =>
	node?.type === "MemberExpression" &&
	((!node.computed &&
		node.property.type === "Identifier" &&
		node.property.name === "_tag") ||
		(node.computed &&
			isStringLiteral(node.property) &&
			node.property.value === "_tag"));

export const tagMemberFromComparison = (
	node: ESTree.BinaryExpression,
): ESTree.MemberExpression | undefined => {
	if (!equalityOperators.has(node.operator)) return undefined;

	if (isTagMember(node.left) && isStringLiteral(node.right)) return node.left;

	if (isTagMember(node.right) && isStringLiteral(node.left)) return node.right;

	return undefined;
};

const isBroadEffectCatchCall = (
	node: ESTree.Node | null | undefined,
): node is ESTree.CallExpression =>
	node?.type === "CallExpression" &&
	node.callee.type === "MemberExpression" &&
	node.callee.object.type === "Identifier" &&
	node.callee.object.name === "Effect" &&
	!node.callee.computed &&
	node.callee.property.type === "Identifier" &&
	broadEffectCatchMethods.has(node.callee.property.name);

export const isInsideBroadEffectHandler = (node: ESTree.Node): boolean => {
	let current: ESTree.Node | null | undefined = node.parent;

	while (current !== null && current !== undefined) {
		if (
			current.type === "ArrowFunctionExpression" ||
			current.type === "FunctionExpression"
		) {
			return (
				isBroadEffectCatchCall(current.parent) &&
				current.parent.arguments.includes(current)
			);
		}

		current = current.parent;
	}

	return false;
};

export const isReasonTagMember = (node: ESTree.MemberExpression): boolean =>
	node.object.type === "MemberExpression" &&
	((!node.object.computed &&
		node.object.property.type === "Identifier" &&
		node.object.property.name === "reason") ||
		(node.object.computed &&
			isStringLiteral(node.object.property) &&
			node.object.property.value === "reason"));

export const propertyName = (
	property: ESTree.ObjectProperty,
): string | undefined => {
	if (!property.computed && property.key.type === "Identifier") {
		return property.key.name;
	}

	if (isStringLiteral(property.key)) return property.key.value;

	return undefined;
};

const memberName = (node: ESTree.MemberExpression): string | undefined => {
	if (!node.computed && node.property.type === "Identifier") {
		return node.property.name;
	}

	if (node.computed && isStringLiteral(node.property)) {
		return node.property.value;
	}

	return undefined;
};

const patternArgument = (node: ESTree.ObjectExpression): ESTree.Node => {
	let current: ESTree.Node = node;

	while (current.parent !== null && current.parent !== undefined) {
		const parent = current.parent;

		if (
			(parent.type === "Property" && parent.value === current) ||
			(parent.type === "SpreadElement" && parent.argument === current) ||
			(parent.type === "ObjectExpression" && parent.properties.includes(current)) ||
			(parent.type === "ArrayExpression" && parent.elements.includes(current))
		) {
			current = parent;
			continue;
		}

		break;
	}

	return current;
};

const isExpectInvocation = (node: ESTree.Node): boolean =>
	node.type === "CallExpression" &&
	node.callee.type === "Identifier" &&
	node.callee.name === "expect";

const isExpectMatcher = (callee: ESTree.Node, matcherName: string): boolean => {
	if (callee.type !== "MemberExpression" || memberName(callee) !== matcherName) {
		return false;
	}

	let receiver: ESTree.Node = callee.object;

	while (receiver.type === "MemberExpression") {
		const modifier = memberName(receiver);

		if (modifier !== "not" && modifier !== "rejects" && modifier !== "resolves") {
			return false;
		}

		receiver = receiver.object;
	}

	return isExpectInvocation(receiver);
};

export const isTaggedPatternObject = (node: ESTree.ObjectExpression): boolean => {
	const argument = patternArgument(node);
	const call = argument.parent;

	if (
		call?.type !== "CallExpression" ||
		!call.arguments.some((candidate) => candidate === argument)
	) {
		return false;
	}

	const callee = call.callee;

	return (
		(callee.type === "MemberExpression" &&
			callee.object.type === "Identifier" &&
			callee.object.name === "Match" &&
			(memberName(callee) === "when" || memberName(callee) === "not")) ||
		isExpectMatcher(callee, "toMatchObject") ||
		isExpectMatcher(callee, "toEqual") ||
		isExpectMatcher(callee, "toStrictEqual") ||
		isExpectMatcher(callee, "toContainEqual") ||
		(callee.type === "MemberExpression" &&
			callee.object.type === "Identifier" &&
			callee.object.name === "expect" &&
			memberName(callee) === "objectContaining")
	);
};
