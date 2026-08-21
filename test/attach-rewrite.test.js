import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  toBrowser, toDisk, fileUrl, pathFromFileUrl, splitFences, splitInlineCode,
} from '../web/attach-rewrite.js';

/**
 * The inverse pair, and the tokenizer underneath it.
 *
 * These two functions run on every open and every save of every note that
 * contains an image. If they are not exact inverses, the corruption is silent,
 * automatic, and discovered by the user rather than by anyone here.
 */

const NOTE = 'projects/dap.md';
const ROOT_NOTE = 'note.md';

describe('the tokenizer keeps every byte', () => {
  const CORPUS = [
    '',
    'plain text',
    'no trailing newline',
    'trailing newline\n',
    '\n\n\n',
    '# heading\n\ntext\n',
    '```\ncode\n```\n',
    '```js\nconst x = 1;\n```\n',
    '~~~\ntilde fence\n~~~\n',
    '````\n```\nnested-looking\n```\n````\n',
    'before\n```\ncode\n```\nafter\n',
    '```\nunterminated fence\n',
    'inline `code` here\n',
    'double ``back `tick` span`` here\n',
    '   ```\n   indented fence\n   ```\n',
  ];

  test('fences rejoin to exactly what went in', () => {
    for (const src of CORPUS) {
      assert.equal(splitFences(src).map((s) => s.text).join(''), src, JSON.stringify(src));
    }
  });

  test('inline spans rejoin to exactly what went in', () => {
    for (const src of CORPUS) {
      assert.equal(splitInlineCode(src).map((p) => p.text).join(''), src, JSON.stringify(src));
    }
  });

  test('an unterminated fence is treated as code to the end', () => {
    const segments = splitFences('text\n```\noops\n');
    assert.equal(segments.at(-1).code, true);
  });
});

describe('going in and coming back', () => {
  const CASES = [
    '# plain\n\n![a board](attachments/board.png)\n',
    '# nested\n\n![board](../attachments/board.png)\n',
    '# spaces\n\n![shot](../attachments/whiteboard%20shot.png)\n',
    '# no alt\n\n![](../attachments/board.png)\n',
    '# titled\n\n![board](../attachments/board.png "the title")\n',
    '# remote\n\n![logo](https://example.com/logo.png)\n',
    '# list\n\n- ![board](../attachments/board.png)\n- text\n',
    '# beside\n\nBefore ![b](../attachments/b.png) after.\n',
    '# two\n\n![one](../attachments/one.png)\n\n![two](../attachments/two.png)\n',
    '# none at all\n\njust prose\n',
    '# a plain link is not an image\n\n[not an image](../attachments/board.png)\n',
  ];

  test('round trips exactly', () => {
    for (const src of CASES) {
      assert.equal(toDisk(NOTE, toBrowser(NOTE, src)), src, src.split('\n')[0]);
    }
  });

  test('round trips for a note at the root too', () => {
    for (const src of CASES) {
      assert.equal(toDisk(ROOT_NOTE, toBrowser(ROOT_NOTE, src)), src, src.split('\n')[0]);
    }
  });

  test('the browser actually gets a loadable url', () => {
    const out = toBrowser(NOTE, '![b](../attachments/board.png)\n');
    assert.equal(out, '![b](/api/file?path=attachments%2Fboard.png)\n');
  });

  test('a title survives the trip through', () => {
    const out = toBrowser(NOTE, '![b](../attachments/board.png "hello")\n');
    assert.match(out, /"hello"\)/);
  });

  test('applying it twice changes nothing the second time', () => {
    // Notes get opened, saved, and opened again. A transform that is not
    // idempotent turns that into a slow rewrite.
    const once = toBrowser(NOTE, '![b](../attachments/board.png)\n');
    assert.equal(toBrowser(NOTE, once), once);
  });
});

describe('what must never be touched', () => {
  test('a remote image stays remote in both directions', () => {
    const src = '![logo](https://example.com/logo.png)\n';
    assert.equal(toBrowser(NOTE, src), src);
    assert.equal(toDisk(NOTE, src), src);
  });

  test('a data url is left alone', () => {
    const src = '![tiny](data:image/png;base64,iVBORw0KGgo=)\n';
    assert.equal(toBrowser(NOTE, src), src);
  });

  test('an ordinary link is not an image', () => {
    const src = '[board](../attachments/board.png)\n';
    assert.equal(toBrowser(NOTE, src), src);
  });

  /**
   * The reason the tokenizer exists. Rewriting inside a fence keeps every
   * round-trip test green — the transform is symmetric — while quietly filling
   * someone's documentation with /api/file noise.
   */
  test('a fenced code sample is left as written', () => {
    const src = '# docs\n\n```md\n![board](attachments/board.png)\n```\n';
    assert.equal(toBrowser(NOTE, src), src, 'rewrote a code sample');
  });

  test('an inline code span is left as written', () => {
    const src = 'write `![board](attachments/board.png)` to embed one\n';
    assert.equal(toBrowser(NOTE, src), src);
  });

  test('but a real image beside a code sample still gets rewritten', () => {
    const src = '```\n![a](attachments/a.png)\n```\n\n![b](attachments/b.png)\n';
    const out = toBrowser(ROOT_NOTE, src);

    assert.match(out, /```\n!\[a\]\(attachments\/a\.png\)\n```/, 'touched the sample');
    assert.match(out, /!\[b\]\(\/api\/file\?path=attachments%2Fb\.png\)/, 'missed the real one');
  });

  test('a path climbing out of the vault is not claimed', () => {
    const src = '![escape](../../../../etc/passwd)\n';
    assert.equal(toBrowser('note.md', src), src);
  });
});

describe('the url helpers', () => {
  test('encode and decode as a pair', () => {
    for (const p of ['attachments/x.png', 'attachments/white space.png', 'a/b/c.png']) {
      assert.equal(pathFromFileUrl(fileUrl(p)), p);
    }
  });

  test('anything else is not ours', () => {
    assert.equal(pathFromFileUrl('https://example.com/x.png'), null);
    assert.equal(pathFromFileUrl('/api/notes'), null);
    assert.equal(pathFromFileUrl('/api/file?other=1'), null);
    assert.equal(pathFromFileUrl(''), null);
  });

  test('a malformed escape does not throw', () => {
    assert.equal(pathFromFileUrl('/api/file?path=%E0%A4%A'), null);
  });
});
