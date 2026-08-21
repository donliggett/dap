import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hrefFor, resolveHref, isForeign } from '../web/attach-path.js';

/**
 * No browser, no server, no filesystem — and that is the point.
 *
 * This pair is the only thing standing between an embedded image and a note
 * being rewritten every time it is opened. The last build shipped an editor
 * that turned frontmatter into a heading and mangled every file it touched;
 * `web/frontmatter.js` exists because of it. This is the same shape of risk,
 * so it gets the same treatment: exhaustive, fast, and written before there is
 * any UI to distract from it.
 */

describe('writing the href into a note', () => {
  test('a note at the root points straight at the folder', () => {
    assert.equal(hrefFor('note.md', 'attachments/x.png'), 'attachments/x.png');
  });

  test('a note in a folder climbs out first', () => {
    assert.equal(hrefFor('projects/dap.md', 'attachments/x.png'), '../attachments/x.png');
  });

  test('a deeply nested note climbs all the way', () => {
    assert.equal(
      hrefFor('a/b/c/deep.md', 'attachments/x.png'),
      '../../../attachments/x.png',
    );
  });

  test('an attachment beside the note is just its name', () => {
    assert.equal(hrefFor('projects/dap.md', 'projects/shot.png'), 'shot.png');
  });

  test('spaces are encoded, separators are not', () => {
    assert.equal(
      hrefFor('projects/dap.md', 'attachments/whiteboard shot.png'),
      '../attachments/whiteboard%20shot.png',
    );
  });

  test('remote and inline images are handed back untouched', () => {
    for (const href of [
      'https://example.com/x.png',
      'http://example.com/x.png',
      'data:image/png;base64,iVBORw0KGgo=',
      '//cdn.example.com/x.png',
      '/absolute/x.png',
    ]) {
      assert.equal(hrefFor('projects/dap.md', href), href, `mangled ${href}`);
    }
  });
});

describe('reading an href back', () => {
  test('round trips from every depth', () => {
    // The property that actually matters. If this ever fails, notes are being
    // rewritten on open.
    for (const note of ['note.md', 'projects/dap.md', 'a/b/c/deep.md']) {
      for (const file of [
        'attachments/x.png',
        'attachments/whiteboard shot.png',
        'attachments/tricky (1) name.png',
      ]) {
        const href = hrefFor(note, file);
        assert.equal(resolveHref(note, href), file, `${note} → ${href}`);
      }
    }
  });

  test('a bare filename resolves beside its note', () => {
    assert.equal(resolveHref('projects/dap.md', 'shot.png'), 'projects/shot.png');
    assert.equal(resolveHref('note.md', 'shot.png'), 'shot.png');
  });

  test('"./" is noise and is ignored', () => {
    assert.equal(resolveHref('projects/dap.md', './shot.png'), 'projects/shot.png');
  });

  test('encoded spaces come back as spaces', () => {
    assert.equal(
      resolveHref('note.md', 'attachments/whiteboard%20shot.png'),
      'attachments/whiteboard shot.png',
    );
  });

  test('anything foreign resolves to null, not a guess', () => {
    for (const href of [
      'https://example.com/x.png',
      'data:image/png;base64,iVBORw0KGgo=',
      '/absolute/x.png',
      '',
    ]) {
      assert.equal(resolveHref('note.md', href), null, `claimed ${href}`);
    }
  });

  /**
   * Climbing past the root is refused rather than clamped. Quietly resolving
   * `../../../../etc/passwd` to something inside the vault is how a traversal
   * stops looking like one.
   */
  test('climbing out of the vault is refused', () => {
    assert.equal(resolveHref('note.md', '../outside.png'), null);
    assert.equal(resolveHref('projects/dap.md', '../../outside.png'), null);
    assert.equal(resolveHref('a/b/c.md', '../../../../far/away.png'), null);
  });

  test('climbing exactly to the root is fine', () => {
    assert.equal(resolveHref('projects/dap.md', '../attachments/x.png'), 'attachments/x.png');
  });

  test('a malformed escape is treated as a literal name', () => {
    // "100%" in a filename is not an encoding, and decodeURIComponent throws
    // on it. Losing the file would be worse than keeping the odd name.
    assert.equal(resolveHref('note.md', 'attachments/100%.png'), 'attachments/100%.png');
  });
});

describe('telling ours from theirs', () => {
  test('recognises what must never be touched', () => {
    assert.equal(isForeign('https://example.com/x.png'), true);
    assert.equal(isForeign('data:image/png;base64,AAAA'), true);
    assert.equal(isForeign('//cdn.example.com/x.png'), true);
    assert.equal(isForeign('/rooted.png'), true);
    assert.equal(isForeign('mailto:someone@example.com'), true);
  });

  test('and what is ours', () => {
    assert.equal(isForeign('attachments/x.png'), false);
    assert.equal(isForeign('../attachments/x.png'), false);
    assert.equal(isForeign('shot.png'), false);
  });

  /**
   * Windows paths are a real hazard: a person can and will paste
   * `C:\Users\Adonis\shot.png` into a note. It is not a vault path, and it must
   * not be mistaken for one.
   */
  test('a windows path is foreign', () => {
    assert.equal(isForeign('C:/Users/Adonis/shot.png'), true);
    assert.equal(resolveHref('note.md', 'C:/Users/Adonis/shot.png'), null);
  });
});
