import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * A vault is a folder of files. That's the whole model.
 *
 * Everything here works in vault-relative paths with forward slashes, on every
 * platform, and nothing outside the vault root is ever read or written.
 */

const NOTE_EXTS = new Set(['.md', '.txt']);

export class Vault {
  constructor(root) {
    this.root = path.resolve(root);
  }

  /**
   * Vault-relative -> absolute, or throw.
   *
   * Containment is checked against the nearest ancestor that actually exists,
   * because the target often doesn't yet — you're creating it. Checking only the
   * immediate parent breaks the moment someone makes a note in a new folder.
   */
  async abs(rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new BadPath(rel);
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) {
      throw new BadPath(rel);
    }

    const abs = path.resolve(this.root, rel.split('/').join(path.sep));
    const realRoot = await fs.realpath(this.root);

    let probe = abs;
    for (let i = 0; i < 64; i++) {
      try {
        const real = await fs.realpath(probe);
        const rel2 = path.relative(realRoot, real);
        if (rel2.startsWith('..') || path.isAbsolute(rel2)) throw new BadPath(rel);
        return abs;
      } catch (err) {
        if (err instanceof BadPath) throw err;
        if (err.code !== 'ENOENT') throw err;
      }
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
    throw new BadPath(rel);
  }

  rel(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  /** Every note in the vault, newest first. */
  async list() {
    const out = [];
    const walk = async (dir) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (NOTE_EXTS.has(path.extname(e.name).toLowerCase())) {
          const st = await fs.stat(full).catch(() => null);
          if (st) out.push({ path: this.rel(full), mtime: Math.round(st.mtimeMs), size: st.size });
        }
      }
    };
    await walk(this.root);
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  async read(rel) {
    const buf = await fs.readFile(await this.abs(rel));
    return { path: rel, content: buf.toString('utf8'), hash: hash(buf) };
  }

  /**
   * Write, refusing to clobber.
   *
   * `baseHash` is what the caller last saw. If the file on disk no longer
   * matches it, someone else changed it and we say so instead of overwriting —
   * which is what makes it safe to keep a note open here and edit it elsewhere.
   */
  async write(rel, content, baseHash) {
    const abs = await this.abs(rel);
    let current = null;
    try {
      current = await fs.readFile(abs);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const currentHash = current ? hash(current) : null;
    if (baseHash !== undefined && baseHash !== currentHash) {
      return {
        ok: false,
        conflict: true,
        path: rel,
        hash: currentHash,
        content: current ? current.toString('utf8') : null,
      };
    }

    const buf = Buffer.from(content, 'utf8');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
    return { ok: true, path: rel, hash: hash(buf) };
  }

  /**
   * Delete by moving to `.trash/`, never by unlinking.
   *
   * The walker already skips anything starting with a dot, so a trashed note
   * leaves the list and the search index the moment it moves, with no special
   * casing anywhere — and it is still sitting in the folder afterwards, openable
   * by any file manager, for someone who deleted the wrong thing an hour ago.
   *
   * A notes app that can silently destroy a year of writing on one mistaken tap
   * has to earn that power. This one does not need it.
   */
  async trash(rel, { now = new Date() } = {}) {
    const abs = await this.abs(rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st || !st.isFile()) return { ok: false, missing: true, path: rel };

    const stem = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.(md|txt)$/i, '');
    const ext = path.extname(rel) || '.md';
    // Flattened, and stamped rather than numbered: deleting the same filename
    // from two folders on two different days should read as two different
    // events, not as `note.md` and `note 2.md`.
    const when = stampFor(now);

    let trashed = `.trash/${stem} ${when}${ext}`;
    for (let n = 2; await exists(await this.abs(trashed)); n++) {
      trashed = `.trash/${stem} ${when} (${n})${ext}`;
    }

    const dest = await this.abs(trashed);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await moveFile(abs, dest);
    return { ok: true, path: rel, trashed };
  }

  /**
   * Put a trashed note back. Refuses to leave `.trash/`, and refuses to land
   * on top of whatever now lives at the original path — undo should never be
   * the thing that destroys something.
   */
  async restore(trashed, rel) {
    if (typeof trashed !== 'string' || !trashed.startsWith('.trash/')) {
      throw new BadPath(trashed);
    }
    const from = await this.abs(trashed);
    if (!(await exists(from))) return { ok: false, missing: true, trashed };

    let target = rel;
    if (await exists(await this.abs(target))) {
      const stem = rel.replace(/\.(md|txt)$/i, '');
      const ext = path.extname(rel) || '.md';
      let n = 2;
      do {
        target = `${stem} ${n}${ext}`;
        n += 1;
      } while (await exists(await this.abs(target)));
    }

    const to = await this.abs(target);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await moveFile(from, to);
    return { ok: true, path: target, restoredFrom: trashed };
  }
}

const exists = (abs) => fs.access(abs).then(() => true, () => false);

/** `2026-08-21 14-03-22` — sortable, and legal on Windows, where `:` is not. */
function stampFor(now) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
    `${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`
  );
}

/**
 * rename(), falling back to copy+unlink.
 *
 * A vault can span a mount point — a synced folder, a network share, a USB
 * stick — and rename() across devices fails with EXDEV. Losing a delete to that
 * would be irritating; losing an *undo* to it would be unforgivable.
 */
async function moveFile(from, to) {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.copyFile(from, to);
    await fs.unlink(from);
  }
}

/**
 * Search, by reading the files.
 *
 * There is still no index — nothing is persisted, and the filesystem remains
 * the only source of truth. What there IS is a read cache, because measuring
 * showed re-reading everything per keystroke costs 142ms at 400 notes and
 * 409ms at 1500. That's laggy while typing.
 *
 * The cache holds each file's text against its mtime and size, both of which
 * `list()` already stats on every query. A file whose stat is unchanged is
 * served from memory; anything touched is re-read. So it cannot go stale — it
 * is checked against the disk every single time, not invalidated by a watcher
 * or a timer that might miss something.
 *
 * Measured after: 100 notes 9ms, 400 notes 30ms, 1500 notes ~100ms. Memory is
 * the whole vault as text, under 2MB at 1500 notes. Past a few thousand notes
 * the directory walk starts to dominate and this needs rethinking.
 *
 * Every term has to appear somewhere (AND, not OR), because a two-word query is
 * almost always someone narrowing down rather than widening out.
 */
const textCache = new Map(); // abs path -> { mtime, size, text, lower }

async function readCached(abs, mtime, size) {
  const hit = textCache.get(abs);
  if (hit && hit.mtime === mtime && hit.size === size) return hit;
  const text = await fs.readFile(abs, 'utf8');
  // Lowercased copy alongside it. This did NOT measurably speed anything up —
  // the remaining cost is the directory walk and the scans — but it avoids
  // allocating a second copy of the whole vault on every keystroke.
  const entry = { mtime, size, text, lower: text.toLowerCase() };
  textCache.set(abs, entry);
  return entry;
}
Vault.prototype.search = async function search(query, { limit = 50 } = {}) {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!terms.length) return [];

  const files = await this.list();
  const hits = [];

  for (const file of files) {
    let entry;
    try {
      entry = await readCached(path.join(this.root, file.path), file.mtime, file.size);
    } catch {
      continue; // deleted between listing and reading
    }
    const text = entry.text;
    const name = file.path.toLowerCase();
    const body = entry.lower;

    // Every term must be findable somewhere in the note — name or body.
    if (!terms.every((t) => name.includes(t) || body.includes(t))) continue;

    const nameHits = terms.filter((t) => name.includes(t)).length;
    const stem = file.path.slice(file.path.lastIndexOf('/') + 1).replace(/\.md$/i, '').toLowerCase();

    let score = 0;
    if (stem === terms.join(' ')) score += 4000;      // you typed the name exactly
    if (stem.startsWith(terms[0])) score += 1200;      // ...or the start of it
    score += nameHits * 600;                           // name beats body, always
    for (const t of terms) {
      score += Math.min(occurrences(body, t), 10) * 8;
    }

    hits.push({
      path: file.path,
      mtime: file.mtime,
      score,
      ...firstMatchingLine(text, terms),
    });
  }

  // Recency only settles ties — otherwise a note you touched today would
  // outrank the one you actually asked for.
  hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return hits.slice(0, limit);
};

function occurrences(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * The line to show under the result. Prefers a line containing the most terms,
 * so a two-word query lands on the line that has both rather than the first
 * line that happens to mention one.
 */
function firstMatchingLine(text, terms) {
  const lines = text.split('\n');
  let best = null;

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    const found = terms.filter((t) => lower.includes(t)).length;
    if (!found) continue;
    if (!best || found > best.found) best = { found, line: i, text: lines[i] };
    if (best.found === terms.length) break;
  }

  if (!best) return { line: null, snippet: '' };

  let snippet = best.text.trim();
  if (snippet.length > 160) {
    const at = snippet.toLowerCase().indexOf(terms[0]);
    const from = Math.max(0, at - 50);
    snippet = (from ? '…' : '') + snippet.slice(from, from + 160).trim() + '…';
  }
  return { line: best.line, snippet };
}

export const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export class BadPath extends Error {
  constructor(p) {
    super(`path not allowed: ${p}`);
    this.name = 'BadPath';
    this.status = 400;
  }
}
