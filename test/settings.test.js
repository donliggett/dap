import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withApp, editorText, waitForAttr, openNote } from './helpers.js';

/**
 * Settings.
 *
 * It exists because delete left a loop open, not because the app needed a
 * preferences screen. The inventory that preceded it found exactly one
 * persisted preference in the whole of dap — the theme — and it already has a
 * one-tap control in the status bar. What was actually missing was any way to
 * see or recover what `.trash/` had swallowed once the 12-second undo expired.
 *
 * So these tests are mostly about the trash, and the about box is checked for
 * being true rather than for being pretty.
 */

const exists = (root, rel) =>
  fs.access(path.join(root, rel.split('/').join(path.sep))).then(() => true, () => false);

const openSettings = async (page) => {
  if ((await page.getAttribute('.shell', 'data-drawer')) !== 'open') {
    await page.click('[data-drawer-toggle]');
  }
  await page.click('[data-open-settings]');
  await page.waitForSelector('[data-settings][open]');
  await page.waitForFunction(() => document.querySelector('[data-about-version]').textContent !== '—');
};

const deleteOpenNote = async (page) => {
  await page.click('[data-delete-btn]');
  await page.waitForSelector('[data-confirm-delete][open]');
  await page.click('[data-confirm-ok]');
  await page.waitForTimeout(400);
};

describe('opening settings', () => {
  test('the nav item actually opens something now', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page }) => {
      await openSettings(page);
      assert.equal(await page.isVisible('[data-settings]'), true);
    });
  });

  test('escape and the close button both dismiss it', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page }) => {
      await openSettings(page);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      assert.equal(await page.isVisible('[data-settings]'), false);

      await openSettings(page);
      await page.click('[data-settings-close]');
      await page.waitForTimeout(200);
      assert.equal(await page.isVisible('[data-settings]'), false);
    });
  });

  test('about reports the real folder and a real count', async () => {
    await withApp({ 'a.md': '1\n', 'b.md': '2\n', 'sub/c.md': '3\n' }, async ({ page, vault }) => {
      await openSettings(page);

      assert.equal(await page.textContent('[data-about-notes]'), '3');
      assert.equal(await page.textContent('[data-about-vault]'), vault);
      // Read from package.json by the server, so it cannot drift from the page.
      assert.match(await page.textContent('[data-about-version]'), /^\d+\.\d+\.\d+$/);
    });
  });

  test('the numbers are re-read each time it opens, not cached', async () => {
    await withApp({ 'a.md': '1\n', 'b.md': '2\n' }, async ({ page }) => {
      await openSettings(page);
      assert.equal(await page.textContent('[data-about-notes]'), '2');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);

      await openNote(page, 'a');
      await deleteOpenNote(page);
      await openSettings(page);

      assert.equal(await page.textContent('[data-about-notes]'), '1', 'showed a stale count');
    });
  });
});

describe('the trash controls', () => {
  test('restore is offered only when there is something to restore', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page }) => {
      await openSettings(page);
      assert.equal(await page.isDisabled('[data-trash-restore]'), true);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);

      await deleteOpenNote(page);
      await openSettings(page);

      assert.equal(await page.isDisabled('[data-trash-restore]'), false);
    });
  });

  test('empty trash is present but inert', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page }) => {
      await deleteOpenNote(page);
      await openSettings(page);

      // Deliberately a stub: emptying is the one place dap would truly destroy
      // a file, and that decision has not been taken yet.
      assert.equal(await page.isDisabled('[data-trash-empty]'), true);
    });
  });

  test('restoring brings the notes back into the list', async () => {
    await withApp({ 'gone.md': '# gone\n', 'keep.md': '# keep\n' }, async ({ page, vault }) => {
      await openNote(page, 'gone');
      await deleteOpenNote(page);
      assert.equal(await exists(vault, 'gone.md'), false);

      await openSettings(page);
      await page.click('[data-trash-restore]');
      await page.waitForFunction(
        () => /restored/.test(document.querySelector('[data-trash-summary]').textContent),
      );

      assert.equal(await exists(vault, 'gone.md'), true);
      assert.equal(await page.textContent('[data-about-notes]'), '2');
      assert.equal(await page.isDisabled('[data-trash-restore]'), true, 'still offering an empty trash');
    });
  });

  /**
   * The case Don flagged: something has taken the name back. Restore must walk
   * to a free one — the same rule that turns a second untitled note into
   * "untitled 2" — rather than overwriting whatever is there now.
   */
  test('restoring never overwrites a note that took the name', async () => {
    await withApp({ 'note.md': 'the old one\n' }, async ({ page, vault, read }) => {
      await deleteOpenNote(page);

      // Make a new note that claims the freed name.
      await page.evaluate(() =>
        fetch('/api/note?path=note.md', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'the new one\n', baseHash: null }),
        }),
      );
      await page.waitForTimeout(200);

      await openSettings(page);
      await page.click('[data-trash-restore]');
      await page.waitForFunction(
        () => /restored/.test(document.querySelector('[data-trash-summary]').textContent),
      );

      assert.equal(await read('note.md'), 'the new one\n', 'the restore clobbered the new note');
      assert.equal(await read('note 2.md'), 'the old one\n', 'the old one did not come back');
      assert.equal(await exists(vault, 'note 2.md'), true);
    });
  });

  test('a note deleted from a subfolder goes back to that subfolder', async () => {
    await withApp({ 'projects/deep.md': '# deep\n' }, async ({ page, vault }) => {
      await deleteOpenNote(page);
      await openSettings(page);
      await page.click('[data-trash-restore]');
      await page.waitForFunction(
        () => /restored/.test(document.querySelector('[data-trash-summary]').textContent),
      );

      assert.equal(
        await exists(vault, 'projects/deep.md'),
        true,
        'came back to the root instead of its folder',
      );
    });
  });

  test('restoring into an empty vault opens what came back', async () => {
    await withApp({ 'only.md': '# only\n' }, async ({ page }) => {
      await deleteOpenNote(page);
      await waitForAttr(page, '.shell', 'data-empty', 'true');

      await openSettings(page);
      await page.click('[data-trash-restore]');
      await page.waitForFunction(
        () => /restored/.test(document.querySelector('[data-trash-summary]').textContent),
      );
      await page.click('[data-settings-close]');
      await page.waitForTimeout(300);

      assert.match(await editorText(page), /only/, 'restored the note but left the editor blank');
    });
  });
});
