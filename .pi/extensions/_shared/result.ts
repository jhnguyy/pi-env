export function txt(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

export function ok(text: string) {
  return { content: [txt(text)], details: {} };
}

export function err(msg: string) {
  return { content: [txt(msg)], details: { error: msg } };
}
