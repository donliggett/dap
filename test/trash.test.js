import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Vault } from '../src/vault.js';
import { serve } from '../src/server.js';
import { makeVault } from './helpers.js';

/**
 * Deleting a note.
 *
 * The whole design is one decision: delete moves the file to `.trash/` and
 * never unlinks it. That buys the two properties that matter without any
 * machinery — a trashed note leaves the list and the search results instantly,
 * because the walker already skips dotfolders, and it is still on disk
 * afterwards for anyone who deleted the wrong thing and noticed later.
 */

const at = (root, rel) => path.join(root, rel.split('/').join(path.sep));
const exists = (abs) => fs.access(abs).then(() => true, () => false);
const FIXED = new Date(2026, 7, 21, 14, 3, 22); // months are 0-based

describe('trashing a note', () => {
  test('the file leaves its old home and lands in .trash', async () => {
    const root = await makeVault({ 'note.md': 'body\n' });
    const vault = new Vault(root);

    const res = await vault.trash('note.md', { now: FIXED });

    assert.equal(res.ok, true);
    assert.equal(res.trashed, '.trash/note 2026-08-21 14-03-22.md');
    assert.equal(await exists(at(root, 'note.md')), false);
    assert.equal(await fs.readFile(at(root, res.trashed), 'utf8'), 'body\n');
    await fs.rm(root, { recursive: true, force: true });
  });

  test('it disappears from the note list and from search', async () => {
    const root = await makeVault({ 'keep.md': 'budget\n', 'gone.md': 'budget\n' });
    const vault = new Vault(root);

    await vault.trash('gone.md', { now: FIXED });

    const listed = (await vault.list()).map((n) => n.path);
    assert.deepEqual(listed, ['keep.md']);

    const found = (await vault.search('budget')).map((h) => h.path);
    assert.deepEqual(found, ['keep.md'], 'a trashed note still turns up in search');
    await fs.rm(root, { recursive: true, force: true });
  });

  test('two notes with the same name from different folders both survive', async () => {
    const root = await makeVault({ 'a/note.md': 'from a\n', 'b/note.md': 'from b\n' });
    const vault = new Vault(root);

    const first = await vault.trash('a/note.md', { now: FIXED });
    const second = await vault.trash('b/note.md', { now: FIXED });

    assert.notEqual(first.trashed, second.trashed, 'the second delete overwrote the first');
    assert.equal(await fs.readFile(at(root, first.trashed), 'utf8'), 'from a\n');
    assert.equal(await fs.readFile(at(root, second.trashed), 'utf8'), 'from b\n');
    await fs.rm(root, { recursive: true, force: true });
  });

  test('the stamp is a legal Windows filename', async () => {
    const root = await makeVault({ 'note.md': 'x\n' });
    const { trashed } = await new Vault(root).trash('note.md', { now: FIXED });

    // ':' is the one that bites — it is legal on POSIX and reserved on NTFS,
    // so a colon here would work everywhere I test and nowhere Don runs it.
    assert.doesNotMatch(trashed.slice('.trash/'.length), /[<>:"|?*\\]/);
    await fs.rm(root, { recursive: true, force: true });
  });

  test('deleting something that is not there is not a crash', async () => {
    const root = await makeVault({});
    const res = await new Vault(root).trash('ghost.md');
    assert.equal(res.missing, true);
    await fs.rm(root, { recursive: true, force: true });
  });

  test('it will not reach outside the vault', async () => {
    const root = await makeVault({ 'note.md': 'x\n' });
    await assert.rejects(() => new Vault(root).trash('../escape.md'));
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('putting it back', () => {
  test('undo returns the note exactly as it was', async () => {
    const root = await makeVault({ 'note.md': '# careful\n\nwork\n' });
    const vault = new Vault(root);

    const { trashed, path: original } = await vault.trash('note.md', { now: FIXED });
    const back = await vault.restore(trashed, original);

    assert.equal(back.path, 'note.md');
    assert.equal(await fs.readFile(at(root, 'note.md'), 'utf8'), '# careful\n\nwork\n');
    assert.equal(await exists(at(root, trashed)), false, 'left a copy behind in the trash');
    await fs.rm(root, { recursive: true, force: true });
  });

  /**
   * The nasty one. Delete `note.md`, make a new `note.md`, then undo. Landing
   * on the original path would destroy the new note — an undo that deletes
   * something is worse than no undo at all.
   */
  test('undo never lands on top of a note that took the name back', async () => {
    const root = await makeVault({ 'note.md': 'the old one\n' });
    const vault = new Vault(root);

    const { trashed, path: original } = await vault.trash('note.md', { now: FIXED });
    await vault.write('note.md', 'the new one\n', null);

    const back = await vault.restore(trashed, original);

    assert.notEqual(back.path, 'note.md');
    assert.equal(await fs.readFile(at(root, 'note.md'), 'utf8'), 'the new one\n');
    assert.equal(await fs.readFile(at(root, back.path), 'utf8'), 'the old one\n');
    await fs.rm(root, { recursive: true, force: true });
  });

  test('restore refuses any path outside the trash', async () => {
    const root = await makeVault({ 'secret.md': 'x\n', 'note.md': 'y\n' });
    const vault = new Vault(root);

    await assert.rejects(() => vault.restore('secret.md', 'stolen.md'));
    await assert.rejects(() => vault.restore('../outside.md', 'stolen.md'));
    await fs.rm(root, { recursive: true, force: true });
  });

  test('restoring something already gone says so', async () => {
    const root = await makeVault({});
    const res = await new Vault(root).restore('.trash/ghost.md', 'ghost.md');
    assert.equal(res.missing, true);
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('over http', () => {
  async function withServer(files, fn) {
    const vault = await makeVault(files);
    const app = await serve({ vault, port: 0 });
    try {
      return await fn({ url: app.url, vault });
    } finally {
      await app.close();
      await fs.rm(vault, { recursive: true, force: true });
    }
  }

  test('DELETE trashes and reports where it went', async () => {
    await withServer({ 'note.md': 'x\n' }, async ({ url, vault }) => {
      const res = await fetch(`${url}/api/note?path=note.md`, { method: 'DELETE' });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.match(body.trashed, /^\.trash\//);
      assert.equal(await exists(at(vault, 'note.md')), false);
      assert.equal(await exists(at(vault, body.trashed)), true);
    });
  });

  test('the round trip works end to end', async () => {
    await withServer({ 'note.md': 'x\n' }, async ({ url, vault }) => {
      const gone = await (
        await fetch(`${url}/api/note?path=note.md`, { method: 'DELETE' })
      ).json();

      const res = await fetch(`${url}/api/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: gone.trashed, path: gone.path }),
      });

      assert.equal(res.status, 200);
      assert.equal(await fs.readFile(at(vault, 'note.md'), 'utf8'), 'x\n');
    });
  });

  test('deleting a note that is not there is a 404, not a 500', async () => {
    await withServer({}, async ({ url }) => {
      const res = await fetch(`${url}/api/note?path=ghost.md`, { method: 'DELETE' });
      assert.equal(res.status, 404);
    });
  });

  test('a traversal attempt is refused', async () => {
    await withServer({ 'note.md': 'x\n' }, async ({ url }) => {
      const res = await fetch(`${url}/api/note?path=${encodeURIComponent('../escape.md')}`, {
        method: 'DELETE',
      });
      assert.equal(res.status, 400);
    });
  });
});
