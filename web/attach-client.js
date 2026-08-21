/**
 * Getting an image from wherever it came from into the vault.
 *
 * Three doors — a button, a paste, a drop — all leading to the same two steps:
 * turn whatever arrived into bytes the server will accept, then hand back where
 * it landed so the caller can put a link in the note.
 */

import { fileUrl } from './attach-rewrite.js';

/** Matches the server's floor. Refusing here saves a pointless 10MB round trip. */
export const MAX_BYTES = 10 * 1024 * 1024;

/** Longest edge of a rasterised SVG. Beyond this is a poster, not a diagram. */
export const SVG_MAX_EDGE = 2048;

/**
 * SVG is converted in the browser, and the conversion is also the defence.
 *
 * An SVG is markup that can carry script, and it would be served back from the
 * origin that holds every note in the vault — so the server refuses it outright.
 * But an SVG loaded through an `<img>` is script-disabled by specification: no
 * scripts run, no external resources are fetched. Drawing that image onto a
 * canvas and reading a png back out therefore never gives the file a chance to
 * do anything, and no dependency is needed to do it.
 *
 * The trade is real and has to be visible to the user: a diagram stops being
 * scalable at whatever size it is frozen at.
 */
export async function svgToPng(file) {
  const text = await file.text();
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));

  try {
    const img = await loadImage(url);

    // An SVG with only a viewBox has no intrinsic size, and browsers land on
    // arbitrary defaults. Take whatever it reports, then scale for legibility.
    const naturalW = img.naturalWidth || 512;
    const naturalH = img.naturalHeight || 512;
    const scale = Math.min(2, SVG_MAX_EDGE / Math.max(naturalW, naturalH));

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(naturalW * scale));
    canvas.height = Math.max(1, Math.round(naturalH * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('the canvas produced nothing');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('the browser could not read that svg'));
    img.src = src;
  });

/**
 * One file in, `{ ok, path, url, converted }` out.
 *
 * Every refusal comes back with a sentence rather than a code, because the only
 * thing the person can do about it is read one.
 */
export async function uploadImage(file, { fetchImpl = fetch } = {}) {
  const isSvg = /svg/i.test(file.type) || /\.svg$/i.test(file.name ?? '');
  let body = file;
  let name = file.name || '';
  let converted = false;

  if (isSvg) {
    try {
      body = await svgToPng(file);
      name = (name.replace(/\.svg$/i, '') || 'drawing') + '.png';
      converted = true;
    } catch {
      return { ok: false, error: 'that svg could not be converted to an image' };
    }
  }

  if (body.size > MAX_BYTES) {
    return { ok: false, error: `that image is larger than ${Math.round(MAX_BYTES / 1024 / 1024)}mb` };
  }

  let res;
  try {
    res = await fetchImpl(`/api/attachment?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      body,
    });
  } catch {
    return { ok: false, error: 'could not reach dap to store that image' };
  }

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    return { ok: false, error: detail.error ?? 'that image could not be stored' };
  }

  const stored = await res.json();
  return { ok: true, path: stored.path, url: fileUrl(stored.path), converted, deduped: stored.deduped };
}

/**
 * The images in a paste or a drop, in order.
 *
 * A paste from a word processor carries the picture *and* an HTML flavour of
 * the same thing; a drop from a file manager carries files. Reading only
 * `files` misses the first case entirely, which is the most common way anyone
 * puts a screenshot into a note.
 */
export function imagesFrom(dataTransfer) {
  if (!dataTransfer) return [];

  const out = [];
  for (const item of dataTransfer.items ?? []) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && looksLikeImage(file)) out.push(file);
  }
  if (out.length) return out;

  return [...(dataTransfer.files ?? [])].filter(looksLikeImage);
}

export const looksLikeImage = (file) =>
  Boolean(file) && (/^image\//i.test(file.type) || /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name ?? ''));

/** A name worth putting in the alt text, or nothing at all. */
export function altFor(file) {
  const name = String(file?.name ?? '').trim();
  if (!name) return '';
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
}
