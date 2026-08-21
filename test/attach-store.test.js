import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Vault } from '../src/vault.js';
import { serve } from '../src/server.js';
import { makeVault } from './helpers.js';

/**
 * Storing an image and getting it back.
 *
 * No browser needed for any of this, which is the point of doing it before the
 * UI — the security-shaped questions (what will we store, what will we serve,
 * how much will we accept) all get answered here where they are cheap to test
 * exhaustively.
 */

const at = (root, rel) => path.join(root, rel.split('/').join(path.sep));
const exists = (abs) => fs.access(abs).then(() => true, () => false);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><script>alert(document.cookie)</script>');

describe('storing', () => {
  test('lands in attachments/ under a readable name', async () => {
    const root = await makeVault({});
    const res = await new Vault(root).attach('whiteboard.png', PNG);

    assert.equal(res.ok, true);
    assert.match(res.path, /^attachments\/whiteboard-[0-9a-f]{16}\.png$/);
    assert.equal(await exists(at(root, res.path)), true);
    await fs.rm(root, { recursive: true, force: true });
  });

  test('the folder is visible, not hidden', async () => {
    // Hiding the pictures from the person who took them would be the wrong
    // kind of tidy for an app whose pitch is that your notes are files.
    const root = await makeVault({});
    const res = await new Vault(root).attach('x.png', PNG);
    assert.doesNotMatch(res.path, /^\./);
    await fs.rm(root, { recursive: true, force: true });
  });

  test('images never show up as notes', async () => {
    const root = await makeVault({ 'note.md': 'x\n' });
    const vault = new Vault(root);
    await vault.attach('x.png', PNG);

    assert.deepEqual((await vault.list()).map((n) => n.path), ['note.md']);
    await fs.rm(root, { recursive: true, force: true });
  });

  test('the same bytes are stored once, however they arrive', async () => {
    const root = await makeVault({});
    const vault = new Vault(root);

    const first = await vault.attach('shot1.png', PNG);
    const second = await vault.attach('shot2.png', PNG);

    assert.equal(second.path, first.path, 'stored the same image twice');
    assert.equal(second.deduped, true);
    assert.deepEqual(await fs.readdir(at(root, 'attachments')), [path.basename(first.path)]);
    await fs.rm(root, { recursive: true, force: true });
  });

  test('different images both survive', async () => {
    const root = await makeVault({});
    const vault = new Vault(root);
    const a = await vault.attach('a.png', PNG);
    const b = await vault.attach('b.jpg', JPEG);

    assert.notEqual(a.path, b.path);
    assert.equal((await fs.readdir(at(root, 'attachments'))).length, 2);
    await fs.rm(root, { recursive: true, force: true });
  });

  test('refuses anything that is not an image it knows', async () => {
    const root = await makeVault({});
    const vault = new Vault(root);

    for (const [what, bytes] of [['svg', SVG], ['html', HTML], ['text', Buffer.from('hello')]]) {
      const res = await vault.attach(`thing.png`, bytes);
      assert.equal(res.ok, false, `stored a ${what}`);
    }
    assert.equal(await exists(at(root, 'attachments')), false, 'made the folder anyway');
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('serving it back', () => {
  test('returns the bytes with the type the bytes say', async () => {
    const root = await makeVault({});
    const vault = new Vault(root);
    const { path: rel } = await vault.attach('x.png', PNG);

    const file = await vault.readImage(rel);
    assert.equal(file.mime, 'image/png');
    assert.deepEqual(file.bytes, PNG);
    await fs.rm(root, { recursive: true, force: true });
  });

  /**
   * The one that would hurt. A vault is a folder of arbitrary files someone
   * syncs around; an .html file served as markup from this origin would be
   * script running next to a handle on every note they own.
   */
  test('will not serve a note, or markup, or anything else', async () => {
    const root = await makeVault({ 'note.md': '# secrets\n', 'page.html': HTML.toString() });
    const vault = new Vault(root);

    assert.equal(await vault.readImage('note.md'), null);
    assert.equal(await vault.readImage('page.html'), null);
    await fs.rm(root, { recursive: true, force: true });
  });

  test('a missing file is null, not a throw', async () => {
    const root = await makeVault({});
    assert.equal(await new Vault(root).readImage('attachments/ghost.png'), null);
    await fs.rm(root, { recursive: true, force: true });
  });

  test('will not reach outside the vault', async () => {
    const root = await makeVault({});
    await assert.rejects(() => new Vault(root).readImage('../../etc/passwd'));
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

  const upload = (url, name, bytes) =>
    fetch(`${url}/api/attachment?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      body: bytes,
    });

  test('uploading returns where it went', async () => {
    await withServer({}, async ({ url, vault }) => {
      const res = await upload(url, 'whiteboard.png', PNG);
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.match(body.path, /^attachments\/whiteboard-[0-9a-f]{16}\.png$/);
      assert.equal(await exists(at(vault, body.path)), true);
    });
  });

  test('and fetching it back gives the right headers', async () => {
    await withServer({}, async ({ url }) => {
      const { path: rel } = await (await upload(url, 'x.png', PNG)).json();
      const res = await fetch(`${url}/api/file?path=${encodeURIComponent(rel)}`);

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
      // Without nosniff a browser is free to second-guess the type, which is
      // the whole hole this is closing.
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
    });
  });

  test('a content-hashed name is cached forever, a hand-dropped one is not', async () => {
    await withServer({}, async ({ url, vault }) => {
      const { path: rel } = await (await upload(url, 'x.png', PNG)).json();
      const ours = await fetch(`${url}/api/file?path=${encodeURIComponent(rel)}`);
      assert.match(ours.headers.get('cache-control'), /immutable/);

      // Dragged into the folder by hand: the name promises nothing about the
      // content, so it must be revalidated.
      await fs.mkdir(at(vault, 'attachments'), { recursive: true });
      await fs.writeFile(at(vault, 'attachments/by-hand.png'), PNG);
      const theirs = await fetch(`${url}/api/file?path=attachments%2Fby-hand.png`);
      assert.equal(theirs.headers.get('cache-control'), 'no-cache');
    });
  });

  test('an svg is refused with a reason, not a 500', async () => {
    await withServer({}, async ({ url }) => {
      const res = await upload(url, 'diagram.svg', SVG);
      assert.equal(res.status, 415);
      assert.match((await res.json()).hint, /svg/i);
    });
  });

  test('an oversized upload is refused', async () => {
    await withServer({}, async ({ url }) => {
      // Just past the 10MB floor, and a valid PNG header so the refusal can
      // only be about size.
      const huge = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
      const res = await upload(url, 'huge.png', huge);
      assert.equal(res.status, 413);
    });
  });

  test('asking for a note through the image route is a 404', async () => {
    await withServer({ 'note.md': '# secrets\n' }, async ({ url }) => {
      const res = await fetch(`${url}/api/file?path=note.md`);
      assert.equal(res.status, 404);
    });
  });

  test('a traversal attempt is refused', async () => {
    await withServer({}, async ({ url }) => {
      const res = await fetch(
        `${url}/api/file?path=${encodeURIComponent('../../etc/passwd')}`,
      );
      assert.equal(res.status, 400);
    });
  });
});
