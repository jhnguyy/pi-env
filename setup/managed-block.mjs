export function reconcileManagedBlock(current, managed, startMarker, endMarker) {
  const body = managed.trim();
  const block = `${startMarker}\n${body}\n${endMarker}`;
  const start = current.indexOf(startMarker);
  const end = current.indexOf(endMarker);

  if (start === -1 && end === -1) {
    if (current.length === 0) return `${block}\n`;
    const separator = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    return `${current}${separator}${block}\n`;
  }
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`invalid managed block markers: ${startMarker}, ${endMarker}`);
  }
  if (current.indexOf(startMarker, start + startMarker.length) !== -1) {
    throw new Error(`duplicate managed block marker: ${startMarker}`);
  }
  if (current.indexOf(endMarker, end + endMarker.length) !== -1) {
    throw new Error(`duplicate managed block marker: ${endMarker}`);
  }

  return `${current.slice(0, start)}${block}${current.slice(end + endMarker.length)}`;
}
