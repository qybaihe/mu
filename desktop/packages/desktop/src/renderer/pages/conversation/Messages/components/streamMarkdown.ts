/**
 * A reply is rendered while it is still being written, so its Markdown is regularly half-finished. The one shape that
 * shows is a code fence: between the ``` that opens a block and the ``` that closes it, the reader sees the raw
 * backticks and the code as prose, and then the whole paragraph jumps into a code block when the closing fence
 * arrives. Closing the open fence ourselves keeps the block a block from its first line.
 *
 * Only a fence on a line of its own counts, and only the opener's own run of backticks or tildes can close it, so
 * fences quoted inside another fence are left alone.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function closeOpenFence(text: string): string {
  if (!text.includes('```') && !text.includes('~~~')) return text;

  let open: string | undefined;
  for (const line of text.split('\n')) {
    const match = FENCE.exec(line);
    if (!match) continue;
    const [, marker, rest] = match;
    if (open === undefined) {
      // An opening fence carries the language, never another fence marker.
      if (!rest.includes('`')) open = marker[0].repeat(marker.length);
      continue;
    }
    // A closing fence is the same character, at least as long, and nothing else on the line.
    if (marker[0] === open[0] && marker.length >= open.length && rest.trim() === '') open = undefined;
  }

  if (open === undefined) return text;
  return `${text}${text.endsWith('\n') ? '' : '\n'}${open}`;
}
