/**
 * What counts as a link, and what a person meant when they typed one.
 *
 * Two jobs, and the second is the one with teeth. Nobody types `https://`, so
 * `example.com` has to become a real URL or the feature is a chore. But an href
 * ends up as a live anchor inside a page holding a handle on every note in the
 * vault, so `javascript:` and friends have to be refused — and refused for
 * notes that arrive from elsewhere too, not just for what gets typed here.
 *
 * Pure on purpose: no DOM, no editor. This is the part where being wrong is
 * expensive and being sure is cheap.
 */

/** The only schemes that reach an anchor. Everything else is refused. */
const ALLOWED = new Set(['http:', 'https:', 'mailto:']);

/**
 * Explicitly dangerous, listed so the refusal is obvious rather than incidental.
 * `javascript:` runs script on click. `data:` and `blob:` can carry a whole
 * document. `file:` reaches the filesystem of whoever opens the note.
 */
const NEVER = /^\s*(javascript|data|vbscript|file|blob)\s*:/i;

/** Does this href reach an anchor? Used on notes from disk, not just on input. */
export function isSafeHref(href) {
  const raw = String(href ?? '').trim();
  if (!raw || NEVER.test(raw)) return false;

  // No scheme at all is a relative link, which is fine and stays as it is.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) return true;

  try {
    return ALLOWED.has(new URL(raw).protocol);
  } catch {
    return false;
  }
}

/**
 * Turn what somebody typed into an href, or say why not.
 *
 * The bare-domain case is the whole reason this exists. `example.com` parses as
 * a *relative path* by every correct URL parser on earth, so being technically
 * right here would mean linking to a file called "example.com" sitting next to
 * the note. Guessing `https://` is what was meant.
 */
export function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'nothing to link to' };

  if (NEVER.test(raw)) {
    return { ok: false, error: 'dap only links to http, https and mailto addresses' };
  }

  // Already carries a scheme: take it or leave it, do not repair it.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, error: 'that does not look like an address' };
    }
    if (!ALLOWED.has(parsed.protocol)) {
      return { ok: false, error: 'dap only links to http, https and mailto addresses' };
    }
    return { ok: true, href: raw };
  }

  // An email address with no scheme is a mailto, which is what anyone typing
  // one into a link field meant.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return { ok: true, href: `mailto:${raw}` };

  // Anything that starts with a plausible hostname gets https. A bare word, a
  // path, or a fragment does not — those are relative links to other notes.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+([/:?#]|$)/i.test(raw)) {
    return { ok: true, href: `https://${raw}` };
  }

  if (raw.startsWith('/') || raw.startsWith('#') || raw.startsWith('.')) {
    return { ok: true, href: raw };
  }

  return { ok: false, error: 'that does not look like an address' };
}

/**
 * How an href should read in a field.
 *
 * `mailto:someone@example.com` is the correct thing to store and a strange
 * thing to show someone who typed an email address.
 */
export const displayUrl = (href) =>
  String(href ?? '').replace(/^mailto:/i, '');
