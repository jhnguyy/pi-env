import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

type TypeAssertionExpression = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

function isTypeAssertionExpression(node: ESTree.Node): node is TypeAssertionExpression {
  return node.type === "TSAsExpression" || node.type === "TSTypeAssertion";
}

function unwrapParenthesizedExpression(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;

  while (current.type === "ParenthesizedExpression") {
    current = current.expression;
  }

  return current;
}

function directlyErasesEvidence(type: ESTree.TSType): boolean {
  let current = type;

  while (current.type === "TSParenthesizedType") current = current.typeAnnotation;

  return (
    current.type === "TSUnknownKeyword" ||
    current.type === "TSAnyKeyword" ||
    current.type === "TSNeverKeyword"
  );
}

function isOutermostAssertionInChain(node: TypeAssertionExpression): boolean {
  let current: ESTree.Expression = node;
  let parent = node.parent;

  while (parent.type === "ParenthesizedExpression" && parent.expression === current) {
    current = parent;
    parent = parent.parent;
  }

  return !isTypeAssertionExpression(parent) || parent.expression !== current;
}

function isForbiddenAssertionChain(node: TypeAssertionExpression): boolean {
  let current: ESTree.Expression = unwrapParenthesizedExpression(node.expression);

  while (isTypeAssertionExpression(current)) {
    if (directlyErasesEvidence(current.typeAnnotation)) return true;
    current = unwrapParenthesizedExpression(current.expression);
  }

  return false;
}

/** Disallow assertion chains whose intermediate targets directly erase type evidence. */
export const noChainedTypeAssertionsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow TypeScript assertion chains with an unknown, any, or never intermediate target, including parenthesized expressions and types.",
    },
    messages: {
      chained:
        "This assertion chain directly erases type evidence through an intermediate unknown, any, or never target. Keep the original precise type, or parse untrusted input at its boundary before narrowing it.",
    },
  },
  createOnce(context) {
    const checkTypeAssertion = (node: TypeAssertionExpression) => {
      if (!isOutermostAssertionInChain(node) || !isForbiddenAssertionChain(node)) return;
      context.report({ node, messageId: "chained" });
    };

    return {
      TSAsExpression: checkTypeAssertion,
      TSTypeAssertion: checkTypeAssertion,
    };
  },
});
