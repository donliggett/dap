import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sniffType, contentHash, stemFor, nameFor, findDuplicate } from '../src/attachments.js';

/**
 * Naming an attached image.
 *
 * Sixteen characters of the real name, sixteen hex of the content hash. The
 * readable half keeps `attachments/` worth opening in a file manager; the hash
 * half makes collisions impossible and deduplication free.
 */

// Real magic bytes. Faking these with a plain string would test nothing, since
// sniffing the bytes is the entire security posture here.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 2, 3])]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'), Buffer.from([1, 2]),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('deciding what a file is', () => {
  test('reads the bytes, not the extension', () => {
    assert.deepEqual(sniffType(PNG), { ext: '.png', mime: 'image/png' });
    assert.deepEqual(sniffType(JPEG), { ext: '.jpg', mime: 'image/jpeg' });
    assert.deepEqual(sniffType(GIF), { ext: '.gif', mime: 'image/gif' });
    assert.deepEqual(sniffType(WEBP), { ext: '.webp', mime: 'image/webp' });
  });

  /**
   * The one that matters. A caller claiming `.png` while handing over markup
   * gets nothing stored — this file would be served from the origin that holds
   * every note in the vault.
   */
  test('an svg wearing a png name is still refused', () => {
    assert.equal(sniffType(SVG), null);
    assert.equal(nameFor('innocent.png', SVG), null);
  });

  test('refuses anything it does not recognise', () => {
    assert.equal(sniffType(Buffer.from('just some text')), null);
    assert.equal(sniffType(Buffer.alloc(0)), null);
    assert.equal(sniffType(null), null);
    // A truncated PNG header must not squeak through on a short read.
    assert.equal(sniffType(Buffer.from([0x89, 0x50])), null);
  });
});

describe('the readable half', () => {
  test('keeps a real name, shortened', () => {
    assert.equal(stemFor('whiteboard.png'), 'whiteboard');
    assert.equal(stemFor('Screenshot 2026-08-21 at 14.03.22.png').length <= 16, true);
  });

  test('falls back when there is no name to keep', () => {
    // Clipboard pastes arrive with nothing at all.
    assert.equal(stemFor(''), 'pasted');
    assert.equal(stemFor(undefined), 'pasted');
    assert.equal(stemFor('   '), 'pasted');
  });

  test('never ends in a dash, dot or space', () => {
    // Truncating at sixteen lands mid-word often enough to matter, and
    // "my-diagram-.png" looks like a bug.
    for (const name of ['my diagram of the thing.png', 'a-b-c-d-e-f-g-h-i-j.png', 'trailing   .png']) {
      assert.doesNotMatch(stemFor(name), /[-\s.]$/, name);
    }
  });

  test('survives characters a filesystem will not take', () => {
    const stem = stemFor('re: budget <draft>|v2?.png');
    assert.doesNotMatch(stem, /[<>:"|?*\\/]/);
    assert.ok(stem.length > 0);
  });

  /**
   * `con.png` is unwritable on Windows — reserved device names apply with an
   * extension too. The hash suffix defuses it for free, but only if the stem
   * does not stand alone, so this pins the behaviour rather than assuming it.
   */
  test('a windows device name cannot end up standing alone', () => {
    const name = nameFor('con.png', PNG);
    assert.notEqual(name, 'con.png');
    assert.match(name, /-[0-9a-f]{16}\.png$/);
  });
});

describe('the whole name', () => {
  test('is a readable stem, a hash, and the real extension', () => {
    assert.match(nameFor('whiteboard.png', PNG), /^whiteboard-[0-9a-f]{16}\.png$/);
  });

  test('is deterministic', () => {
    assert.equal(nameFor('x.png', PNG), nameFor('x.png', PNG));
  });

  test('different bytes give a different name', () => {
    const other = Buffer.concat([PNG, Buffer.from([9])]);
    assert.notEqual(nameFor('x.png', PNG), nameFor('x.png', other));
  });

  test('the extension follows the bytes, not the claim', () => {
    assert.match(nameFor('mislabelled.png', JPEG), /\.jpg$/);
  });
});

describe('storing the same image twice', () => {
  test('finds the one already there', () => {
    const stored = nameFor('whiteboard.png', PNG);
    assert.equal(findDuplicate([stored, 'unrelated-0000000000000000.png'], PNG), stored);
  });

  /**
   * The reason the lookup is on the suffix rather than the whole name: the
   * readable half is whatever the *first* upload happened to be called. Two
   * names, identical bytes, one image.
   */
  test('matches on content even when the names differ', () => {
    const first = nameFor('shot1.png', PNG);
    const second = nameFor('shot2.png', PNG);
    assert.notEqual(first, second, 'fixture is wrong — these should differ by stem');
    assert.equal(findDuplicate([first], PNG), first, 'stored the same bytes twice');
  });

  test('says nothing when it is genuinely new', () => {
    assert.equal(findDuplicate([nameFor('a.png', PNG)], JPEG), null);
    assert.equal(findDuplicate([], PNG), null);
  });

  test('a hash collision across formats is not a match', () => {
    // Suffix includes the extension, so a png and a webp can never be
    // mistaken for one another however the hashes land.
    const png = nameFor('x.png', PNG);
    assert.equal(findDuplicate([png], WEBP), null);
  });

  test('the hash is the length it claims to be', () => {
    assert.match(contentHash(PNG), /^[0-9a-f]{16}$/);
  });
});
