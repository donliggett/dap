import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withApp, editorText, caretToEndOfFirstLine, waitForAttr, openNote } from './helpers.js';

/**
 * What happens when the file moves under you.
 *
 * The server already refuses to clobber: a PUT whose baseHash no longer matches
 * disk comes back 409 with the current contents attached. That half was right
 * from the start. The half that was missing was what the person typing is
 * supposed to *do* about it — the status line said "changed on disk" and then
 * nothing, forever, while every keystroke kept 409ing into the void.
 *
 * This stopped being a corner case the day dap grew a command line. `dap new`,
 * `vim $(dap path x)`, a sync client touching the folder, the same note open on
 * a phone — all of them are now ordinary, and all of them land here.
 */

const SETTLE = 1200; // past the 500ms debounce and the round trip
const CONFLICT_BAR = '[data-conflict-bar]';

/** Change the file behind the app's back, the way another program would. */
const changeOnDisk = (vault, rel, text) => fs.writeFile(path.join(vault, rel), text);

/** Type into the open note and let the save attempt complete. */
async function typeAndSettle(page, text) {
  await caretToEndOfFirstLine(page);
  await page.keyboard.type(text);
  await page.waitForTimeout(SETTLE);
}

/** Drive a note into the conflicted state and hand back the app. */
async function provokeConflict(ctx, rel = 'note.md', theirs = '# their version\n') {
  const { page, vault } = ctx;
  await changeOnDisk(vault, rel, theirs);
  await typeAndSettle(page, ' mine');
}

describe('a file that changed underneath you', () => {
  test('is never silently overwritten', async () => {
    await withApp({ 'note.md': '# hello\n' }, async (ctx) => {
      await provokeConflict(ctx);

      assert.match(
        await ctx.read('note.md'),
        /their version/,
        'the browser clobbered a file it had not seen',
      );
    });
  });

  test('says so, and offers a way out', async () => {
    await withApp({ 'note.md': '# hello\n' }, async (ctx) => {
      await provokeConflict(ctx);

      await waitForAttr(ctx.page, '.shell', 'data-conflict', 'true');
      assert.ok(
        await ctx.page.isVisible(CONFLICT_BAR),
        'the note is stuck in conflict with nothing offered to resolve it',
      );
    });
  });

  /**
   * The one that actually cost work. Every keystroke rescheduled a save, every
   * save 409'd, and the edit lived only in the tab — so switching notes ran
   * save() one more futile time and then loaded over the top of it.
   */
  test('does not throw away my edit when I switch notes', async () => {
    await withApp(
      { 'note.md': '# hello\n', 'other.md': '# other\n' },
      async (ctx) => {
        await openNote(ctx.page, 'note');
        await provokeConflict(ctx);
        await openNote(ctx.page, 'other');

        const kept = await ctx.page.evaluate(() =>
          document.querySelector('.shell').dataset.conflict,
        );
        assert.equal(kept, 'true', 'the conflict was dropped on the floor by switching notes');
      },
    );
  });

  test('stops hammering the server once it knows', async () => {
    await withApp({ 'note.md': '# hello\n' }, async (ctx) => {
      await provokeConflict(ctx);

      let puts = 0;
      ctx.page.on('request', (r) => {
        if (r.method() === 'PUT') puts++;
      });

      await ctx.page.keyboard.type(' and more');
      await ctx.page.waitForTimeout(SETTLE * 2);

      assert.equal(puts, 0, `kept retrying a save it knows will fail (${puts} attempts)`);
    });
  });
});

describe('resolving it', () => {
  test('keep mine puts my version on disk', async () => {
    await withApp({ 'note.md': '# hello\n' }, async (ctx) => {
      await provokeConflict(ctx);
      await ctx.page.click('[data-conflict-keep]');
      await ctx.page.waitForTimeout(SETTLE);

      const onDisk = await ctx.read('note.md');
      assert.match(onDisk, /mine/, 'keeping mine did not reach disk');
      assert.doesNotMatch(onDisk, /their version/, 'their text survived a deliberate overwrite');
      await waitForAttr(ctx.page, '.shell', 'data-conflict', 'false');
    });
  });

  test('load theirs shows what is actually on disk', async () => {
    await withApp({ 'note.md': '# hello\n' }, async (ctx) => {
      await provokeConflict(ctx);
      await ctx.page.click('[data-conflict-theirs]');
      await ctx.page.waitForTimeout(400);

      assert.match(await editorText(ctx.page), /their version/, 'the editor did not reload');
      await waitForAttr(ctx.page, '.shell', 'data-conflict', 'false');
    });
  });

  /**
   * The kind option, and the same instinct as never refusing a duplicate name:
   * walking to a free filename beats making someone choose which version to
   * lose while they are already annoyed.
   */
  test('save a copy keeps both versions', async () => {
    await withApp({ 'note.md': '# hello\n' }, async (ctx) => {
      await provokeConflict(ctx);
      await ctx.page.click('[data-conflict-copy]');
      await ctx.page.waitForTimeout(SETTLE);

      assert.match(await ctx.read('note.md'), /their version/, 'their version was lost');
      assert.match(
        await ctx.read('note (conflict).md'),
        /mine/,
        'my version was not kept anywhere',
      );
      await waitForAttr(ctx.page, '.shell', 'data-conflict', 'false');
    });
  });

  test('editing works normally again afterwards', async () => {
    await withApp({ 'note.md': '# hello\n' }, async (ctx) => {
      await provokeConflict(ctx);
      await ctx.page.click('[data-conflict-keep]');
      await ctx.page.waitForTimeout(SETTLE);

      await typeAndSettle(ctx.page, ' after');

      assert.match(
        await ctx.read('note.md'),
        /after/,
        'saving stayed broken once the conflict was resolved',
      );
    });
  });
});
