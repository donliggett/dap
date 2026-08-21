/**
 * Swapping image links between what is on disk and what a browser can load.
 *
 *   on disk        ![](../attachments/x.png)
 *   in the editor  ![](/api/file?path=attachments%2Fx.png)
 *
 * Both directions have to be exact inverses. If they are not, every note
 * containing an image is rewritten the moment it is opened, and the person
 * finds out from a git diff on a note they only read.
 *
 * ## Why this bothers with code blocks
 *
 * The obvious version is one regex over the whole document, and it is wrong in
 * a way round-trip tests do not catch. A fenced block containing
 * `![board](attachments/board.png)` is *sample text*, not an image — rewriting
 * it keeps every fidelity test green, because the transform is symmetric, while
 * anyone writing documentation about dap in dap watches their code samples fill
 * with `/api/file?path=` noise.
 *
 * Indented code blocks are deliberately *not* detected. Telling four spaces of
 * code from four spaces of lazy list continuation needs a real markdown parser,
 * and guessing wrong there would corrupt a document rather than just uglify a
 * sample. The cost of ignoring them is cosmetic and confined to a rare shape.
 */

import { hrefFor, resolveHref, isForeign } from './attach-path.js';

/** Where the browser can fetch a stored image. */
export const fileUrl = (attachmentPath) =>
  `/api/file?path=${encodeURIComponent(attachmentPath)}`;

/** The attachment a browser URL points at, or null if it is not one of ours. */
export function pathFromFileUrl(href) {
  const raw = String(href ?? '');
  if (!raw.startsWith('/api/file?')) return null;
  for (const pair of raw.slice(raw.indexOf('?') + 1).split('&')) {
    const [key, value = ''] = pair.split('=');
    if (key !== 'path') continue;
    try {
      return decodeURIComponent(value) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** On the way in: disk paths become URLs the editor can actually load. */
export const toBrowser = (notePath, markdown) =>
  mapImageHrefs(markdown, (href) => {
    if (isForeign(href)) return href;
    const target = resolveHref(notePath, href);
    return target ? fileUrl(target) : href;
  });

/** On the way out: URLs become paths that mean something in a folder. */
export const toDisk = (notePath, markdown) =>
  mapImageHrefs(markdown, (href) => {
    const target = pathFromFileUrl(href);
    return target ? hrefFor(notePath, target) : href;
  });

/**
 * `![alt](href)` and `![alt](href "title")`.
 *
 * Refuses hrefs containing whitespace or parentheses rather than trying to
 * handle markdown's `<...>` form and nesting rules. Ours are percent-encoded
 * and contain neither; anything stranger is somebody's hand-written link and is
 * safer left exactly as it is.
 */
const IMAGE = /(!\[[^\]]*\]\()([^()\s]+)((?:\s+"[^"]*")?\))/g;

export function mapImageHrefs(markdown, fn) {
  return splitFences(String(markdown ?? ''))
    .map((segment) => (segment.code ? segment.text : rewriteProse(segment.text, fn)))
    .join('');
}

const rewriteProse = (text, fn) =>
  splitInlineCode(text)
    .map((part) =>
      part.code ? part.text : part.text.replace(IMAGE, (_, open, href, tail) => open + fn(href) + tail),
    )
    .join('');

/**
 * Split on fenced code blocks.
 *
 * The segments must concatenate back to the input exactly — this runs on the
 * way in *and* the way out, so a tokenizer that loses a newline corrupts a note
 * twice per open. Newlines are carried inside the segments rather than
 * reinserted afterwards, because reinserting them is where that bug lives.
 */
export function splitFences(src) {
  const segments = [];
  const lines = src.split('\n');

  let buffer = '';
  let marker = null;

  const flush = (code) => {
    if (buffer) segments.push({ text: buffer, code });
    buffer = '';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const withBreak = i === lines.length - 1 ? line : `${line}\n`;

    if (marker) {
      buffer += withBreak;
      // A closing fence is the same character, at least as long, alone on its
      // line. An info string only ever appears on the opening one.
      if (new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(line)) {
        flush(true);
        marker = null;
      }
      continue;
    }

    const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      flush(false);
      marker = opening[1];
      buffer = withBreak;
      continue;
    }

    buffer += withBreak;
  }

  // An unterminated fence runs to the end of the document, and is still code.
  flush(marker !== null);
  return segments;
}

/**
 * Inline code spans. A run of backticks opens, the next run of the same length
 * closes, and everything between is text — including something shaped exactly
 * like an image link.
 */
export function splitInlineCode(text) {
  const parts = [];
  const spans = /(`+)([\s\S]*?)\1/g;
  let at = 0;
  let match;

  while ((match = spans.exec(text))) {
    if (match.index > at) parts.push({ text: text.slice(at, match.index), code: false });
    parts.push({ text: match[0], code: true });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), code: false });
  return parts;
}
