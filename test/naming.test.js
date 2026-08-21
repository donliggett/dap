import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { slugForFilename } from '../web/naming.js';

/**
 * Pure, so it runs without a browser. These are the rules that decide what your
 * files get called — worth pinning precisely rather than discovering later that
 * a note titled "Q1/Q2" quietly created a folder.
 */

describe('slugForFilename', () => {
  test('keeps ordinary titles as they are', () => {
    assert.equal(slugForFilename('grocery list'), 'grocery list');
    assert.equal(slugForFilename('Q3 Planning Notes'), 'Q3 Planning Notes');
  });

  test('a slash would become a folder, so it goes', () => {
    assert.equal(slugForFilename('Q1/Q2 planning'), 'Q1 Q2 planning');
    assert.equal(slugForFilename('back\\slash'), 'back slash');
  });

  test('strips characters Windows rejects', () => {
    assert.equal(slugForFilename('what? "really" <yes>: no|maybe*'), 'what really yes no maybe');
  });

  test('trims trailing dots and spaces, which Windows also rejects', () => {
    assert.equal(slugForFilename('notes...'), 'notes');
    assert.equal(slugForFilename('notes   '), 'notes');
  });

  /** The non-obvious one: these cannot exist as filenames on Windows at all. */
  test('escapes reserved device names', () => {
    assert.equal(slugForFilename('con'), 'con note');
    assert.equal(slugForFilename('CON'), 'CON note');
    assert.equal(slugForFilename('com4'), 'com4 note');
    assert.equal(slugForFilename('nul'), 'nul note');
  });

  test('leaves a reserved word alone when it is only part of the name', () => {
    assert.equal(slugForFilename('con artists'), 'con artists');
  });

  test('truncates at a word boundary', () => {
    const long = 'a'.repeat(50) + ' ' + 'b'.repeat(50);
    const out = slugForFilename(long);
    assert.ok(out.length <= 80);
    assert.equal(out, 'a'.repeat(50));
  });

  test('gives up rather than producing rubbish', () => {
    assert.equal(slugForFilename('///'), '');
    assert.equal(slugForFilename('   '), '');
    assert.equal(slugForFilename(null), '');
  });
});
