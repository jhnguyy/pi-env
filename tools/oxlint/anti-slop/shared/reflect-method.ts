import { defineRule } from "@oxlint/plugins";

import { resolveVariable } from "./scope.ts";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type NoReflectRuleOptions = {
  readonly description: string;
  readonly message: string;
  readonly messageId: string;
  readonly methodName: string;
};

function isGlobalReflect(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  if (expression.type !== "Identifier" || expression.name !== "Reflect") return false;

  if (sourceCode.isGlobalReference(expression)) return true;
  const variable = resolveVariable(sourceCode, expression);

  return variable === null || variable.defs.length === 0;
}

/** Reports whether a call target names one method on the global Reflect object. */
export function isGlobalReflectMethodCall(
  sourceCode: SourceCode,
  callee: ESTree.Expression,
  methodName: string,
): boolean {
  if (!("property" in callee) || !("object" in callee) || !("computed" in callee)) return false;

  if (!isGlobalReflect(sourceCode, callee.object)) return false;
  const property = callee.property;

  return callee.computed
    ? property.type === "Literal" && property.value === methodName
    : property.type === "Identifier" && property.name === methodName;
}

export function createNoReflectRule(options: NoReflectRuleOptions) {
  return defineRule({
    meta: {
      type: "problem",
      docs: { description: options.description },
      messages: { [options.messageId]: options.message },
    },
    createOnce(context) {
      return {
        CallExpression(node) {
          if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") {
            return;
          }

          if (isGlobalReflectMethodCall(context.sourceCode, node.callee, options.methodName)) {
            context.report({ node, messageId: options.messageId });
          }
        },
      };
    },
  });
}
