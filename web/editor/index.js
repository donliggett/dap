import { createPlainEditor } from './plain.js';

/**
 * Picks an engine, and never lets that choice break the app.
 *
 * The rich engine is a bundled file that may be absent (not generated yet),
 * stale, or broken. Any of those must cost you formatting, never your notes —
 * so a failed load falls back to plain text and says so, rather than leaving a
 * blank screen and an app you cannot type in.
 *
 * `?engine=plain` forces the fallback. That is a genuine escape hatch, not just
 * a test hook: if the rich editor ever misbehaves on a note, you can still open
 * and edit it.
 */
export async function createEditor() {
  const requested = new URLSearchParams(location.search).get('engine');

  if (requested === 'plain') {
    return { engine: 'plain', editor: createPlainEditor(), reason: 'requested' };
  }

  try {
    const mod = await import('../vendor/rich.js');
    if (typeof mod.createRichEditor !== 'function') throw new Error('bundle has no createRichEditor');
    return { engine: 'rich', editor: mod.createRichEditor() };
  } catch (err) {
    return {
      engine: 'plain',
      editor: createPlainEditor(),
      reason: 'the rich editor could not load — run `npm install && npm run bundle`',
      error: String(err?.message ?? err),
    };
  }
}
