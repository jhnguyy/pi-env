const SPDX_OPERATOR = new Set(["AND", "OR", "WITH"]);

export function licenseIdentifiers(expression) {
  return expression
    .replaceAll(/[()]/g, " ")
    .split(/\s+/)
    .filter((token) => token !== "" && !SPDX_OPERATOR.has(token));
}
