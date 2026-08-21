import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withApp, editorText, caretToEndOfFirstLine, waitForAttr, openNote } from './helpers.js';

/**
 * Deleting from the browser.
 *
 * trash.test.js covers the file moves. This covers the part that can quietly
 * ruin them: what the tab does in the second afterwards. The autosave timer is
 * the specific hazard — a save scheduled before the delete still holds the old
 * path, and a notes app that resurrects the file you just deleted is worse than
 * one that cannot delete at all.
 */

const SETTLE = 1200;
const exists = (root, rel) =>
  fs.access(path.join(root, rel.split('/').join(path.sep))).then(() => true, () => false);

const listedNotes = (page) =>
  page.$$eval('.note-item .n-title', (els) => els.map((e) => e.textContent));

describe('deleting the open note', () => {
  test('is not offered when there is nothing open', async () => {
    await withApp({}, async ({ page }) => {
      assert.equal(await page.isDisabled('[data-delete-btn]'), true);
    });
  });

  test('takes the note out of the list and off the disk', async () => {
    await withApp({ 'gone.md': '# gone\n', 'keep.md': '# keep\n' }, async ({ page, vault }) => {
      await openNote(page, 'gone');

      await page.click('[data-delete-btn]');
      await page.waitForTimeout(400);

      assert.deepEqual(await listedNotes(page), ['keep']);
      assert.equal(await exists(vault, 'gone.md'), false);
    });
  });

  test('opens whatever is left, rather than sitting on a dead note', async () => {
    await withApp({ 'gone.md': '# gone\n', 'keep.md': '# keep\n' }, async ({ page }) => {
      await openNote(page, 'gone');
      await page.click('[data-delete-btn]');
      await page.waitForTimeout(500);

      assert.match(await editorText(page), /keep/);
      assert.equal(await page.textContent('[data-status-path]'), 'keep.md');
    });
  });

  test('the last note leaves an empty state, not a broken one', async () => {
    await withApp({ 'only.md': '# only\n' }, async ({ page }) => {
      await page.click('[data-delete-btn]');
      await waitForAttr(page, '.shell', 'data-empty', 'true');

      assert.equal(await page.isVisible('[data-empty-state]'), true);
      assert.equal(await page.isDisabled('[data-delete-btn]'), true);
    });
  });

  /**
   * Type so a save is pending, then delete inside the debounce.
   *
   * Read this one for what it is: it pins behaviour, it does not guard the
   * code that looks like it causes the behaviour. I wrote it twice believing
   * otherwise. The first version asserted the file stayed deleted and could not
   * fail, because the hash check turns a late save into a 409 on its own. This
   * version asserts no PUT escapes, and *also* cannot fail by removing the
   * timer cancellation — opening the next note clears the dirty flag first, and
   * with no next note there is no path to save to.
   *
   * So three separate things independently prevent the stray write, and the
   * cancellation in deleteCurrent is the one that is never reached. Worth
   * knowing before someone deletes it, and worth not pretending otherwise:
   * two tests in this repo have already shipped green while testing nothing.
   */
  test('nothing is written after a delete, however it is timed', async () => {
    await withApp({ 'doomed.md': '# doomed\n', 'other.md': '# other\n' }, async ({ page, vault }) => {
      await openNote(page, 'doomed');
      await caretToEndOfFirstLine(page);
      await page.keyboard.type(' edited');
      await page.waitForTimeout(80); // inside the 500ms debounce, deliberately

      let puts = 0;
      page.on('request', (r) => {
        if (r.method() === 'PUT') puts++;
      });

      await page.click('[data-delete-btn]');
      await page.waitForTimeout(SETTLE * 2);

      assert.equal(puts, 0, `a save outlived the delete (${puts} of them)`);
      assert.equal(await exists(vault, 'doomed.md'), false);
    });
  });
});

describe('undo', () => {
  test('is offered, and puts the note back where it was', async () => {
    await withApp({ 'gone.md': '# gone\n', 'keep.md': '# keep\n' }, async ({ page, vault }) => {
      await openNote(page, 'gone');
      await page.click('[data-delete-btn]');
      await page.waitForTimeout(400);

      assert.equal(await page.isVisible('[data-undo]'), true);
      await page.click('[data-undo]');
      await page.waitForTimeout(500);

      assert.equal(await exists(vault, 'gone.md'), true);
      assert.deepEqual((await listedNotes(page)).sort(), ['gone', 'keep']);
      assert.equal(await page.isVisible('[data-undo]'), false);
    });
  });

  test('brings back exactly what was written, not an empty note', async () => {
    await withApp({ 'note.md': '# note\n\nsomething worth keeping\n' }, async ({ page, read }) => {
      await page.click('[data-delete-btn]');
      await page.waitForTimeout(400);
      await page.click('[data-undo]');
      await page.waitForTimeout(500);

      assert.match(await read('note.md'), /something worth keeping/);
      assert.match(await editorText(page), /something worth keeping/);
    });
  });

  test('is not offered before anything has been deleted', async () => {
    await withApp({ 'note.md': '# note\n' }, async ({ page }) => {
      assert.equal(await page.isVisible('[data-undo]'), false);
    });
  });
});
