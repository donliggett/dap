import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, caretToEndOfFirstLine } from './helpers.js';

/**
 * Can an image survive being opened?
 *
 * This is written before any of the attachment feature exists, and it is the
 * gate on whether the rest gets built at all. Markdown stores a filesystem
 * path; the editor stores a document model; saving re-serializes. If that round
 * trip is lossy in any of the shapes below, then every note containing an image
 * gets quietly rewritten the moment someone opens it — and the person finds out
 * by seeing a diff in git for a note they only read.
 *
 * The previous build shipped exactly that failure with frontmatter. It is the
 * reason `web/frontmatter.js` exists. This time the guard comes first.
 *
 * Nothing here rewrites anything yet: these paths are relative and meaningless
 * to the browser, so the images will not render. That is fine. The question is
 * only whether the bytes come back unchanged.
 */

const SETTLE = 1200;

/** The shapes that break serializers, one per line of risk. */
const CASES = {
  'plain.md': '# plain\n\n![a whiteboard](attachments/board.png)\n',

  'spaces.md': '# spaces\n\n![shot](attachments/whiteboard%20shot.png)\n',

  'no-alt.md': '# no alt\n\n![](attachments/board.png)\n',

  'titled.md': '# titled\n\n![board](attachments/board.png "the title")\n',

  'remote.md': '# remote\n\n![logo](https://example.com/logo.png)\n',

  'in-a-list.md': '# in a list\n\n- first\n- ![board](attachments/board.png)\n- third\n',

  'beside-text.md': '# beside text\n\nBefore ![board](attachments/board.png) after.\n',

  'two-of-them.md':
    '# two\n\n![one](attachments/one.png)\n\n![two](attachments/two.png)\n',

  'in-a-quote.md': '# quoted\n\n> ![board](attachments/board.png)\n',

  'with-frontmatter.md':
    '---\ntitle: fixture\n---\n\n# front\n\n![board](attachments/board.png)\n',

  /** Not an image at all — a fenced block that merely looks like one. */
  'in-code.md':
    '# code\n\n```md\n![board](attachments/board.png)\n```\n',
};

describe('an image survives being opened', () => {
  for (const [name, content] of Object.entries(CASES)) {
    test(name.replace(/\.md$/, '').replace(/-/g, ' '), async () => {
      await withApp({ [name]: content }, async ({ page, read }) => {
        await page.waitForTimeout(SETTLE);
        assert.equal(await read(name), content, 'opening the note rewrote it');
      });
    });
  }
});

/**
 * Put the caret at the end of the heading, whichever engine is mounted.
 *
 * `caretToEndOfFirstLine` clicks the middle of the editor, which is fine for
 * prose and wrong here: an image is a block node, so the click lands on the
 * picture and the text gets typed beside it. That is a harness bug that looks
 * exactly like a save failure, and it cost me a few minutes of suspecting the
 * serializer.
 */
async function caretAfterHeading(page) {
  const isTextarea = await page.evaluate(
    () => document.querySelector('[data-editor]')?.tagName === 'TEXTAREA',
  );
  if (isTextarea) return caretToEndOfFirstLine(page);
  await page.locator('[data-editor] h1').first().click();
  await page.keyboard.press('End');
}

describe('an image survives being edited', () => {
  test('typing elsewhere leaves the image alone', async () => {
    const start = '# note\n\n![board](attachments/board.png)\n';
    await withApp({ 'note.md': start }, async ({ page, read }) => {
      await caretAfterHeading(page);
      await page.keyboard.type(' edited');
      await page.waitForTimeout(SETTLE);

      const after = await read('note.md');
      assert.match(after, /# note edited/, 'the edit did not save');
      assert.match(
        after,
        /!\[board\]\(attachments\/board\.png\)/,
        'the image link was mangled by an edit somewhere else',
      );
    });
  });

  test('a remote image is never rewritten into a local one', async () => {
    const start = '# note\n\n![logo](https://example.com/logo.png)\n';
    await withApp({ 'note.md': start }, async ({ page, read }) => {
      await caretAfterHeading(page);
      await page.keyboard.type(' edited');
      await page.waitForTimeout(SETTLE);

      assert.match(
        await read('note.md'),
        /!\[logo\]\(https:\/\/example\.com\/logo\.png\)/,
        'a link to the open web was captured as a local path',
      );
    });
  });
});

/**
 * End to end, with real bytes.
 *
 * Everything above proves the markdown survives. This proves the point of the
 * exercise: that the picture actually appears. A rewrite that is perfectly
 * lossless and produces a broken image icon has failed at the only thing the
 * feature is for.
 */
const ONE_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('an image actually renders', () => {
  test('the src is rewritten and the bytes load', async () => {
    const note = '# shot\n\n![a pixel](attachments/pixel.png)\n';
    await withApp(
      { 'shot.md': note, 'attachments/pixel.png': ONE_PIXEL },
      async ({ page, read }) => {
        await page.waitForTimeout(SETTLE);

        const img = await page.evaluate(() => {
          const el = document.querySelector('[data-editor] img');
          return el && { src: el.getAttribute('src'), width: el.naturalWidth };
        });

        assert.ok(img, 'no image element was rendered at all');
        assert.match(img.src, /^\/api\/file\?path=attachments%2Fpixel\.png$/);
        // naturalWidth stays 0 on an image that failed to load, so this is the
        // difference between "rewrote the src" and "the picture is there".
        assert.equal(img.width, 1, 'the src was rewritten but the image did not load');

        assert.equal(await read('shot.md'), note, 'rendering it rewrote the file');
      },
    );
  });

  test('a note in a subfolder resolves its image too', async () => {
    const note = '# deep\n\n![a pixel](../attachments/pixel.png)\n';
    await withApp(
      { 'projects/deep.md': note, 'attachments/pixel.png': ONE_PIXEL },
      async ({ page, read }) => {
        await page.waitForTimeout(SETTLE);

        const width = await page.evaluate(
          () => document.querySelector('[data-editor] img')?.naturalWidth ?? 0,
        );
        assert.equal(width, 1, 'the ../ was not resolved against the note');
        assert.equal(await read('projects/deep.md'), note);
      },
    );
  });

  test('typing beside an image leaves the link on disk unchanged', async () => {
    const note = '# shot\n\n![a pixel](attachments/pixel.png)\n';
    await withApp(
      { 'shot.md': note, 'attachments/pixel.png': ONE_PIXEL },
      async ({ page, read }) => {
        await caretAfterHeading(page);
        await page.keyboard.type(' edited');
        await page.waitForTimeout(SETTLE);

        const after = await read('shot.md');
        assert.match(after, /# shot edited/);
        assert.match(
          after,
          /!\[a pixel\]\(attachments\/pixel\.png\)/,
          'the browser URL leaked onto disk',
        );
        assert.doesNotMatch(after, /api\/file/, 'saved a URL instead of a path');
      },
    );
  });
});
