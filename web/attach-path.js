/**
 * Turning an attachment's home into a link, and back.
 *
 * Markdown stores a path relative to the note. The browser needs a URL. Those
 * are different things, and the whole feature turns on converting between them
 * without losing a byte — a lossy round trip here quietly rewrites every note
 * that contains an image, the moment it is opened.
 *
 * So this is a pure pair. Strings in, strings out, no filesystem and no fetch,
 * which means the risky part can be tested exhaustively in milliseconds
 * without a browser or a server anywhere near it.
 *
 * Both directions are deliberately conservative: anything that is not plainly a
 * vault-relative path is handed back untouched. A note full of links to the
 * open web must survive being opened here.
 */

/** Left alone, always: the web, inline data, and anything already absolute. */
const FOREIGN = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i;

export const isForeign = (href) => FOREIGN.test(String(href ?? '').trim());

const dirOf = (rel) => {
  const at = rel.lastIndexOf('/');
  return at === -1 ? '' : rel.slice(0, at);
};

/**
 * The href to write into a note.
 *
 * `hrefFor('projects/dap.md', 'attachments/x.png')` → `'../attachments/x.png'`
 *
 * Relative rather than root-relative on purpose. `/attachments/x.png` is
 * simpler and resolves correctly in exactly one place — a web server — which
 * would make every embed break the moment the folder is opened in any other
 * editor. That is the one thing this feature is not allowed to do.
 */
export function hrefFor(notePath, attachmentPath) {
  const target = String(attachmentPath ?? '');
  if (!target || isForeign(target)) return target;

  const from = dirOf(String(notePath ?? '')).split('/').filter(Boolean);
  const to = target.split('/').filter(Boolean);

  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1;

  const up = Array.from({ length: from.length - shared }, () => '..');
  const down = to.slice(shared);
  const parts = [...up, ...down];

  // A note beside its attachment gets a bare filename, which markdown reads as
  // a sibling. "./x.png" would also work and is noise.
  return parts.map(encodeSegment).join('/');
}

/**
 * The vault-relative path an href points at, or null if it points elsewhere.
 *
 * `resolveHref('projects/dap.md', '../attachments/x.png')` → `'attachments/x.png'`
 *
 * Null means "not ours" — a remote image, a data URL, or something that climbs
 * out of the vault entirely. Callers must leave those exactly as they found
 * them rather than trying to be helpful.
 */
export function resolveHref(notePath, href) {
  const raw = String(href ?? '').trim();
  if (!raw || isForeign(raw)) return null;

  const from = dirOf(String(notePath ?? '')).split('/').filter(Boolean);
  const out = [...from];

  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Climbing past the vault root is not a path we own. Refuse rather than
      // clamp: silently resolving it to something inside the vault is how a
      // traversal becomes a feature.
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(decodeSegment(segment));
  }

  return out.length ? out.join('/') : null;
}

/**
 * Spaces and the rest, encoded per path segment.
 *
 * Filenames here are made by `slugForFilename`, so they are already tame, but
 * a file dropped in by hand can be anything. Encoding the whole path at once
 * would eat the separators, so it happens one segment at a time.
 */
function encodeSegment(segment) {
  if (segment === '..' || segment === '.') return segment;
  return encodeURIComponent(segment);
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    // Malformed escapes are somebody's literal filename, not an encoding.
    return segment;
  }
}
