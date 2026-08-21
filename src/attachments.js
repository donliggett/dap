import crypto from 'node:crypto';
import { slugForFilename } from '../web/naming.js';

/**
 * What an attached image gets called.
 *
 * Don's design, and it is better than either of the two obvious answers. A pure
 * content hash (`a3f9c2e1.png`) deduplicates and collides never, but turns
 * `attachments/` into a wall of noise — which fights the one thing this app
 * actually claims, that your notes are files you can open and read. Keeping the
 * original name alone is legible and collides constantly, since half of what
 * gets pasted is called `image.png`.
 *
 * So: up to 16 characters of the real name, then 16 hex of the content hash.
 *
 *   whiteboard-a3f9c2e10b4d7e88.png
 *
 * Legible in a file manager, collision-free in practice, and deduplicating for
 * free — the same bytes always produce the same suffix, so pasting one
 * screenshot ten times stores it once.
 */

const HASH_LEN = 16; // 64 bits. Far past enough for a folder of screenshots.
const STEM_MAX = 16;
const FALLBACK_STEM = 'pasted';

/**
 * Type is decided by the bytes, never by what the caller claims.
 *
 * An extension is a suggestion from whoever is uploading, and this file is
 * about to be written into someone's notes folder and served back from the
 * origin that holds every note they own.
 */
const SIGNATURES = [
  { ext: '.png', mime: 'image/png', test: (b) =>
      b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: '.jpg', mime: 'image/jpeg', test: (b) =>
      b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.gif', mime: 'image/gif', test: (b) =>
      b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { ext: '.webp', mime: 'image/webp', test: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** `{ ext, mime }`, or null for anything we will not store. */
export function sniffType(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  for (const sig of SIGNATURES) {
    if (sig.test(buf)) return { ext: sig.ext, mime: sig.mime };
  }
  // Deliberately not here: SVG. It is markup that can carry script, and it
  // would be served from the origin holding every note in the vault. The
  // browser converts it to a png before it ever reaches this point.
  return null;
}

export const contentHash = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex').slice(0, HASH_LEN);

/**
 * The readable half. Never longer than 16 characters, never empty, and safe on
 * a filesystem before it gets anywhere near one.
 */
export function stemFor(originalName) {
  const raw = String(originalName ?? '').trim();
  const withoutExt = raw.replace(/\.[a-z0-9]{1,8}$/i, '');

  // slugForFilename already knows about <>:"|?*, trailing dots and spaces, and
  // Windows reserved device names. Reuse it rather than write a second set of
  // rules that will drift from the first.
  const slug = slugForFilename(withoutExt);
  const trimmed = slug.slice(0, STEM_MAX).replace(/[-\s.]+$/, '').trim();
  return trimmed || FALLBACK_STEM;
}

/**
 * The filename for a set of bytes.
 *
 * Deterministic: same content and same original name always give the same
 * answer, which is what makes deduplication a lookup rather than a decision.
 */
export function nameFor(originalName, bytes) {
  const type = sniffType(bytes);
  if (!type) return null;
  return `${stemFor(originalName)}-${contentHash(bytes)}${type.ext}`;
}

/**
 * Have we already stored these exact bytes?
 *
 * Matched on the hash suffix, not the whole filename, because the readable half
 * comes from whatever the first upload happened to be called. `shot1.png` and
 * `shot2.png` with identical content are one image, and storing it twice under
 * two names would make a liar out of the whole scheme.
 */
export function findDuplicate(existingNames, bytes) {
  const type = sniffType(bytes);
  if (!type) return null;
  const suffix = `-${contentHash(bytes)}${type.ext}`;
  return existingNames.find((name) => name.toLowerCase().endsWith(suffix)) ?? null;
}
