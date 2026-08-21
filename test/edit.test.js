import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, editorText, caretToEndOfFirstLine, waitForAttr } from './helpers.js';

/**
 * These tests wait.
 *
 * Every one of them types, then sits still for longer than the autosave debounce
 * before asserting. That gap is not padding — the previous build shipped an
 * editor that accepted a keystroke, autosaved 400ms later, and then threw the
 * character away when the save completed. Every check written at the speed of
 * the keystroke passed. The bug lived entirely in the second after.
 */

const SETTLE = 1200; // comfortably past the 500ms debounce and the round trip

describe('typing', () => {
  test('a typed character is still there a second later', async () => {
    await withApp({ 'note.md': '# hello\n' }, async ({ page }) => {
      await caretToEndOfFirstLine(page);
      await page.keyboard.type('X');

      await page.waitForTimeout(SETTLE);

      assert.match(
        await editorText(page),
        /X/,
        'the character vanished from the editor after the save cycle',
      );
    });
  });

  test('what you typed reaches the file on disk', async () => {
    await withApp({ 'note.md': '# hello\n' }, async ({ page, read }) => {
      await caretToEndOfFirstLine(page);
      await page.keyboard.type(' world');

      await page.waitForTimeout(SETTLE);

      const onDisk = await read('note.md');
      assert.match(onDisk, /hello world/, `file says: ${JSON.stringify(onDisk)}`);
    });
  });

  test('the caret does not get thrown to the start mid-sentence', async () => {
    // Rebuilding the editor loses the selection, so text lands reversed or
    // scrambled. Typing several characters catches what typing one does not.
    await withApp({ 'note.md': 'abc\n' }, async ({ page, read }) => {
      await caretToEndOfFirstLine(page);
      for (const ch of 'defg') {
        await page.keyboard.type(ch);
        await page.waitForTimeout(180); // straddle the debounce deliberately
      }
      await page.waitForTimeout(SETTLE);

      const onDisk = await read('note.md');
      assert.match(onDisk, /abcdefg/, `characters arrived out of order: ${JSON.stringify(onDisk)}`);
    });
  });

  test('typing keeps focus in the editor', async () => {
    await withApp({ 'note.md': 'text\n' }, async ({ page }) => {
      await page.locator('[data-editor]').click();
      await page.keyboard.type('more');
      await page.waitForTimeout(SETTLE);

      const focused = await page.evaluate(
        () => document.activeElement?.hasAttribute('data-editor') ?? false,
      );
      assert.equal(focused, true, 'focus left the editor after saving');
    });
  });

  test('the editor element survives a save', async () => {
    // If the node identity changes, something rebuilt the editor. That is the
    // shape of the v0 failure regardless of whether text happened to survive.
    await withApp({ 'note.md': 'text\n' }, async ({ page }) => {
      // Hold an actual reference. Tagging with an attribute is not enough —
      // a cloned replacement carries the attribute across and the check passes
      // while the node underneath has in fact been swapped.
      await page.evaluate(() => {
        window.__probe = document.querySelector('[data-editor]');
      });
      await page.locator('[data-editor]').click();
      await page.keyboard.type('!');
      await page.waitForTimeout(SETTLE);

      const same = await page.evaluate(
        () => window.__probe === document.querySelector('[data-editor]'),
      );
      assert.equal(same, true, 'the editor was destroyed and rebuilt');
    });
  });
});

describe('saving', () => {
  test('status reaches "saved" on its own', async () => {
    await withApp({ 'note.md': 'x\n' }, async ({ page }) => {
      await page.locator('[data-editor]').click();
      await page.keyboard.type('y');
      await page.waitForTimeout(SETTLE);

      const status = await page.locator('[data-save-text]').textContent();
      assert.equal(status, 'saved');
    });
  });

  test('an untouched note is never rewritten', async () => {
    // Opening a note must not dirty it. This is the guard that will matter most
    // once a markdown serializer is in the loop and could reflow on write.
    await withApp({ 'note.md': '# keep me exactly\n\nline two\n' }, async ({ page, read }) => {
      const before = await read('note.md');
      await page.locator('[data-editor]').click();
      await page.waitForTimeout(SETTLE);
      const after = await read('note.md');
      assert.equal(after, before, 'opening a note modified it');
    });
  });

  test('a second note can be opened and edited', async () => {
    await withApp(
      { 'one.md': 'first\n', 'two.md': 'second\n' },
      async ({ page, read }) => {
        await page.locator('[data-drawer-toggle]').click();
        await page.locator('.note-item', { hasText: 'two' }).click();
        await page.waitForTimeout(400);

        await caretToEndOfFirstLine(page);
        await page.keyboard.type(' edited');
        await page.waitForTimeout(SETTLE);

        assert.match(await read('two.md'), /second edited/);
        assert.equal(await read('one.md'), 'first\n', 'editing one note touched another');
      },
    );
  });
});

describe('the shell', () => {
  test('boots and lists notes', async () => {
    await withApp({ 'a.md': 'a\n', 'b.md': 'b\n' }, async ({ page }) => {
      await page.waitForSelector('body[data-ready="true"]');
      assert.equal(await page.locator('[data-note-count]').textContent(), '2');
    });
  });

  test('the panel opens and closes', async () => {
    await withApp({ 'a.md': 'a\n' }, async ({ page }) => {
      await waitForAttr(page, '.shell', 'data-drawer', 'closed');
      await page.locator('[data-drawer-toggle]').click();
      await waitForAttr(page, '.shell', 'data-drawer', 'open');
      await page.keyboard.press('Escape');
      await waitForAttr(page, '.shell', 'data-drawer', 'closed');
    });
  });

  test('source view shows the markdown', async () => {
    await withApp({ 'a.md': '# title\n\nbody\n' }, async ({ page }) => {
      await page.locator('[data-mode-btn="source"]').click();
      const src = await page.locator('[data-source]').textContent();
      assert.match(src, /# title/);
    });
  });
});

describe('first run', () => {
  test('an empty folder explains itself instead of showing a blank page', async () => {
    await withApp({}, async ({ page }) => {
      await page.waitForSelector('body[data-ready="true"]');
      await page.locator('[data-empty-state]').waitFor({ state: 'visible', timeout: 2000 });
      assert.match(await page.locator('.empty-title').textContent(), /nothing here yet/);
    });
  });

  test('the first note can be made from the empty state', async () => {
    await withApp({}, async ({ page, read }) => {
      await page.waitForSelector('body[data-ready="true"]');
      await page.locator('.empty-btn').click();
      await page.waitForTimeout(600);

      await page.locator('[data-editor]').click();
      await page.keyboard.type('first thought');
      await page.waitForTimeout(1200);

      assert.match(await read('untitled.md'), /first thought/);
    });
  });
});
