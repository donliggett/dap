/**
 * Frontmatter never reaches the editor.
 *
 * A document-model editor parses what you give it, and `---` at the top of a
 * file is a horizontal rule or a setext heading as far as markdown is
 * concerned. Handed a note with YAML frontmatter, Tiptap turns
 *
 *     ---
 *     title: fixture
 *     tags: [a, b]
 *     ---
 *
 * into `## title: fixture tags: \[a, b\]` — the metadata is gone and what
 * replaces it is wrong. That is not a formatting quirk, it is losing the user's
 * data on open.
 *
 * So it's split off before the editor sees anything and re-attached byte for
 * byte on the way back out. dap doesn't parse it, interpret it, or reformat it;
 * it carries it. Anything dap doesn't understand survives untouched, which is
 * the only defensible position for a tool whose whole promise is that your
 * notes are just files.
 */

const OPENS = /^---[ \t]*\r?\n/;

/**
 * @returns {{ front: string, body: string }} `front` includes its own fences
 *          and trailing newline, so `front + body` is exactly the original.
 */
export function splitFrontmatter(text) {
  const src = String(text ?? '');
  if (!OPENS.test(src)) return { front: '', body: src };

  const firstBreak = src.indexOf('\n');
  let lineStart = firstBreak + 1;

  while (lineStart <= src.length) {
    const lineEnd = src.indexOf('\n', lineStart);
    const line = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);

    if (/^(---|\.\.\.)[ \t]*\r?$/.test(line)) {
      const end = lineEnd === -1 ? src.length : lineEnd + 1;
      return { front: src.slice(0, end), body: src.slice(end) };
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  // An opening fence with no closer is a horizontal rule, or a truncated file.
  // Treating it as frontmatter would swallow the entire note.
  return { front: '', body: src };
}

/** Put it back. Kept as its own function so the pairing is obvious at call sites. */
export function joinFrontmatter(front, body) {
  if (!front) return body;
  return front + body;
}
