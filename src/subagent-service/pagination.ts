type PagingOptions = { offset?: number; limit?: number };

/** Page validated offsets and limits in UTF-16 code units, not bytes. */
export function pageText(text: string, options: PagingOptions = {}) {
  const offset = Math.min(options.offset ?? 0, text.length);
  const end = Math.min(text.length, offset + (options.limit ?? 4096));
  return {
    text: text.slice(offset, end),
    offset,
    nextOffset: end < text.length ? end : null,
    total: text.length,
    truncated: offset > 0 || end < text.length,
  };
}
