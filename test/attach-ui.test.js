import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withApp, editorText } from './helpers.js';

/**
 * Putting an image in, from the three doors.
 *
 * Playwright can hand a real file to a file input, and can synthesise a paste
 * or a drop with a real DataTransfer. So all three routes are exercised with
 * actual bytes rather than mocked away — which matters, because the interesting
 * failures here are about what arrives in the clipboard, not about our code.
 */

const SETTLE = 1400;
const at = (root, rel) => path.join(root, rel.split('/').join(path.sep));

const ONE_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const OTHER_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#F2C744"/></svg>';

/** Hand a file to the hidden input, the way the toolbar button does. */
async function pickFile(page, name, bytes, mime = 'image/png') {
  await page.setInputFiles('[data-image-input]', [{ name, mimeType: mime, buffer: bytes }]);
  await page.waitForTimeout(SETTLE);
}

/**
 * Synthesise a paste carrying a real file.
 *
 * Building the DataTransfer inside the page rather than faking our own event
 * shape, so this exercises `imagesFrom` against the thing a browser actually
 * produces.
 */
async function pasteImage(page, bytes, name = 'pasted.png') {
  await page.evaluate(
    async ({ b64, name }) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bin], name, { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      document
        .querySelector('[data-editor-host]')
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { b64: bytes.toString('base64'), name },
  );
  await page.waitForTimeout(SETTLE);
}

async function dropImage(page, bytes, coords) {
  const box = await page.locator('[data-editor-host]').boundingBox();
  await page.evaluate(
    async ({ b64, x, y }) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bin], 'dropped.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const host = document.querySelector('[data-editor-host]');
      host.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      host.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }),
      );
    },
    { b64: bytes.toString('base64'), x: coords?.x ?? box.x + 20, y: coords?.y ?? box.y + 20 },
  );
  await page.waitForTimeout(SETTLE);
}

const storedFiles = (root) =>
  fs.readdir(at(root, 'attachments')).catch(() => []);

describe('the toolbar button', () => {
  test('stores the file and links it from the note', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page, vault, read }) => {
      await pickFile(page, 'whiteboard.png', ONE_PIXEL);

      const stored = await storedFiles(vault);
      assert.equal(stored.length, 1, 'nothing reached the attachments folder');
      assert.match(stored[0], /^whiteboard-[0-9a-f]{16}\.png$/);

      const note = await read('note.md');
      assert.match(note, /!\[whiteboard\]\(attachments\/whiteboard-[0-9a-f]{16}\.png\)/);
      assert.doesNotMatch(note, /api\/file/, 'a browser URL was written to disk');
    });
  });

  test('the picture actually appears in the editor', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page }) => {
      await pickFile(page, 'whiteboard.png', ONE_PIXEL);

      const width = await page.evaluate(
        () => document.querySelector('[data-editor] img')?.naturalWidth ?? 0,
      );
      assert.equal(width, 1, 'inserted a link to an image that does not load');
    });
  });

  test('the same image twice is stored once and linked twice', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page, vault, read }) => {
      await pickFile(page, 'first.png', ONE_PIXEL);
      await pickFile(page, 'second.png', ONE_PIXEL);

      assert.equal((await storedFiles(vault)).length, 1, 'stored the same bytes twice');
      assert.equal((await read('note.md')).match(/!\[/g)?.length, 2, 'only linked it once');
    });
  });

  test('two different images both land', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page, vault }) => {
      await pickFile(page, 'a.png', ONE_PIXEL);
      await pickFile(page, 'b.png', OTHER_PIXEL);
      assert.equal((await storedFiles(vault)).length, 2);
    });
  });

  test('a note in a subfolder gets a relative link that resolves', async () => {
    await withApp({ 'projects/deep.md': '# deep\n' }, async ({ page, read }) => {
      await pickFile(page, 'shot.png', ONE_PIXEL);

      const note = await read('projects/deep.md');
      assert.match(note, /!\[shot\]\(\.\.\/attachments\//, 'wrote a path that will not resolve');

      const width = await page.evaluate(
        () => document.querySelector('[data-editor] img')?.naturalWidth ?? 0,
      );
      assert.equal(width, 1);
    });
  });
});

describe('pasting', () => {
  test('a pasted image is stored and linked', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page, vault, read }) => {
      await pasteImage(page, ONE_PIXEL);

      assert.equal((await storedFiles(vault)).length, 1);
      assert.match(await read('note.md'), /!\[pasted\]\(attachments\//);
    });
  });

  test('pasting text is still just pasting text', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page, vault }) => {
      await page.locator('[data-editor]').click();
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData('text/plain', 'just words');
        document
          .querySelector('[data-editor-host]')
          .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(600);

      assert.deepEqual(await storedFiles(vault), [], 'a text paste created an attachment');
    });
  });
});

describe('dropping', () => {
  test('a dropped image is stored and linked', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page, vault, read }) => {
      await dropImage(page, ONE_PIXEL);

      assert.equal((await storedFiles(vault)).length, 1);
      assert.match(await read('note.md'), /!\[dropped\]\(attachments\//);
    });
  });

  test('the drop highlight clears afterwards', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page }) => {
      await dropImage(page, ONE_PIXEL);
      assert.equal(await page.getAttribute('.shell', 'data-dropping'), 'false');
    });
  });
});

describe('svg', () => {
  /**
   * The server refuses SVG outright — it is markup that can carry script, and
   * it would be served from the origin holding every note. The browser converts
   * it first, and the conversion is also the defence: an SVG loaded through an
   * <img> is script-disabled by specification.
   */
  test('is converted to a png before it is stored', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page, vault, read }) => {
      await page.setInputFiles('[data-image-input]', [
        { name: 'diagram.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG) },
      ]);
      await page.waitForTimeout(SETTLE);

      const stored = await storedFiles(vault);
      assert.equal(stored.length, 1);
      assert.match(stored[0], /\.png$/, 'stored the svg as-is');
      assert.match(await read('note.md'), /!\[diagram\]\(attachments\/diagram-[0-9a-f]{16}\.png\)/);
    });
  });

  test('says so, rather than silently changing the format', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page }) => {
      await page.setInputFiles('[data-image-input]', [
        { name: 'diagram.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG) },
      ]);
      await page.waitForTimeout(SETTLE);

      assert.equal(await page.isVisible('[data-notice]'), true, 'said nothing at all');
      assert.match(
        await page.textContent('[data-notice]'),
        /converted/i,
        'changed the file format without a word',
      );
    });
  });
});

describe('when it goes wrong', () => {
  test('a file that is not an image is refused with a sentence', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page, vault }) => {
      await page.setInputFiles('[data-image-input]', [
        { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
      ]);
      await page.waitForTimeout(SETTLE);

      assert.deepEqual(await storedFiles(vault), []);
      const said = await page.textContent('[data-notice]');
      assert.match(said, /image/i, `said "${said}"`);
    });
  });

  test('a bad file in a batch does not stop the good ones', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page, vault }) => {
      await page.setInputFiles('[data-image-input]', [
        { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
        { name: 'good.png', mimeType: 'image/png', buffer: ONE_PIXEL },
      ]);
      await page.waitForTimeout(SETTLE * 2);

      assert.equal((await storedFiles(vault)).length, 1, 'one bad file swallowed the batch');
    });
  });
});
