import fs from 'node:fs/promises';
import path from 'node:path';
import { Vault } from './vault.js';

/**
 * dap from a terminal.
 *
 * Two rules shape everything here.
 *
 * First, no server. Every command reads the folder directly, so dap works over
 * ssh, in a script, or while the browser side isn't running. A note-taking tool
 * that needs a daemon to answer "what did I write about X" isn't much of a
 * command-line tool.
 *
 * Second, behave when piped. Output goes plain and one-per-line when stdout
 * isn't a terminal, so `dap find budget | xargs grep` does what you'd expect,
 * and exit codes mean something: 0 found it, 1 didn't, 2 you asked wrong.
 */

export const EXIT = { ok: 0, notFound: 1, usage: 2 };

const isTTY = () => Boolean(process.stdout.isTTY);
const out = (line = '') => process.stdout.write(line + '\n');
const err = (line) => process.stderr.write(line + '\n');

/**
 * Turn what someone typed into one note.
 *
 * Nobody types `daily/2026-08-21.md`. An exact path wins, then a unique
 * filename match, then a unique substring. Two matches is a question, not a
 * guess — printing both and stopping beats opening the wrong note.
 */
export async function resolveNote(vault, query) {
  const q = String(query ?? '').trim();
  if (!q) return { error: 'which note?' };

  const notes = await vault.list();
  const paths = notes.map((n) => n.path);

  const exact = paths.find((p) => p === q || p === `${q}.md`);
  if (exact) return { path: exact };

  const stem = (p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '').toLowerCase();
  const lower = q.toLowerCase().replace(/\.md$/i, '');

  const byName = paths.filter((p) => stem(p) === lower);
  if (byName.length === 1) return { path: byName[0] };
  if (byName.length > 1) return { ambiguous: byName };

  const partial = paths.filter((p) => p.toLowerCase().includes(lower));
  if (partial.length === 1) return { path: partial[0] };
  if (partial.length > 1) return { ambiguous: partial };

  return { error: `no note matching "${q}"` };
}

function reportAmbiguous(matches) {
  err(`"${matches.length}" notes match — be more specific:`);
  for (const m of matches.slice(0, 10)) err(`  ${m}`);
  if (matches.length > 10) err(`  …and ${matches.length - 10} more`);
  return EXIT.usage;
}

// ── commands ───────────────────────────────────────────────────────────

export async function ls(vault) {
  const notes = await vault.list();
  if (!notes.length) {
    if (isTTY()) err('no notes yet');
    return EXIT.notFound;
  }
  // Piped: bare paths, nothing else, so the next command in the pipeline gets
  // something it can use.
  if (!isTTY()) {
    for (const n of notes) out(n.path);
    return EXIT.ok;
  }
  const width = Math.max(...notes.map((n) => n.path.length));
  for (const n of notes) out(`${n.path.padEnd(width)}  ${ago(n.mtime)}`);
  return EXIT.ok;
}

export async function find(vault, query) {
  if (!query) {
    err('usage: dap find <query>');
    return EXIT.usage;
  }
  const hits = await vault.search(query);
  if (!hits.length) {
    if (isTTY()) err(`nothing matching "${query}"`);
    return EXIT.notFound;
  }
  if (!isTTY()) {
    for (const h of hits) out(h.path);
    return EXIT.ok;
  }
  for (const h of hits) {
    out(h.path);
    if (h.snippet) out(`  ${h.snippet}`);
  }
  return EXIT.ok;
}

/** Raw markdown, exactly as it is on disk. The CLI never renders. */
export async function cat(vault, query) {
  const found = await resolveNote(vault, query);
  if (found.ambiguous) return reportAmbiguous(found.ambiguous);
  if (found.error) {
    err(found.error);
    return EXIT.notFound;
  }
  const note = await vault.read(found.path);
  process.stdout.write(note.content);
  return EXIT.ok;
}

/** The absolute path, so `vim $(dap path budget)` works. */
export async function where(vault, query) {
  const found = await resolveNote(vault, query);
  if (found.ambiguous) return reportAmbiguous(found.ambiguous);
  if (found.error) {
    err(found.error);
    return EXIT.notFound;
  }
  out(path.join(vault.root, found.path.split('/').join(path.sep)));
  return EXIT.ok;
}

/**
 * Create a note, taking its body from stdin when something is piped in.
 *
 * That's the shape that makes it useful in a pipeline:
 *   pbpaste | dap new "clipboard"
 *   dap new idea < draft.md
 */
export async function neu(vault, name, { stdin = null } = {}) {
  if (!name) {
    err('usage: dap new <name>');
    return EXIT.usage;
  }
  const { slugForFilename } = await import('../web/naming.js');
  const base = slugForFilename(name) || 'untitled';

  const existing = new Set((await vault.list()).map((n) => n.path.toLowerCase()));
  let rel = `${base}.md`;
  for (let n = 2; existing.has(rel.toLowerCase()); n++) rel = `${base} ${n}.md`;

  const body = stdin ?? '';
  const result = await vault.write(rel, body, null);
  if (!result.ok) {
    err(`could not create ${rel}`);
    return EXIT.usage;
  }
  out(isTTY() ? `created ${rel}` : rel);
  return EXIT.ok;
}

const ago = (ms) => {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/**
 * Read piped stdin, or null if nothing was piped.
 *
 * The obvious version — "not a TTY, so read until EOF" — hangs forever when
 * stdin is a pipe that nobody ever writes to or closes. That is not exotic: it
 * is what happens under cron, in CI, and in any script that inherits a stdin it
 * isn't using. `dap new idea` would simply never return.
 *
 * So the FIRST byte is given a deadline. If nothing arrives, there was nothing
 * coming and the note is created empty. Once bytes are flowing the deadline is
 * dropped entirely, because a large piped file is slow but genuinely arriving.
 */
export async function readStdin({ firstByteMs = 250 } = {}) {
  if (process.stdin.isTTY) return null;

  return new Promise((resolve) => {
    const chunks = [];
    let started = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (started || settled) return;
      settled = true;
      process.stdin.pause();
      resolve(null);
    }, firstByteMs);

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text.length ? text : null);
    };

    process.stdin.on('data', (chunk) => {
      started = true;
      clearTimeout(timer);
      chunks.push(chunk);
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

export async function openVault(folder) {
  const root = path.resolve(folder);
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) return { error: `not a folder: ${root}` };
  } catch {
    return { error: `no such folder: ${root}` };
  }
  return { vault: new Vault(root) };
}
