import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withApp } from './helpers.js';

const exists = async (v, rel) => fs.access(path.join(v, rel)).then(() => true, () => false);
const notes = async (v) => (await fs.readdir(v)).filter((f) => f.endsWith('.md')).sort();

describe('naming a note when you make it', () => {
  test('the name you type becomes the filename', async () => {
    await withApp({}, async ({ page, vault }) => {
      await page.locator('[data-new-btn]').click();
      await page.locator('[data-name-input]').fill('grocery list');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
      assert.deepEqual(await notes(vault), ['grocery list.md']);
    });
  });

  test('the checkmark commits it too', async () => {
    await withApp({}, async ({ page, vault }) => {
      await page.locator('[data-new-btn]').click();
      await page.locator('[data-name-input]').fill('via the button');
      await page.locator('[data-confirm]').click();
      await page.waitForTimeout(700);
      assert.deepEqual(await notes(vault), ['via the button.md']);
    });
  });

  test('clicking away commits what is in the field', async () => {
    await withApp({}, async ({ page, vault }) => {
      await page.locator('[data-new-btn]').click();
      await page.locator('[data-name-input]').fill('by leaving');
      await page.locator('.topbar').click();
      await page.waitForTimeout(700);
      assert.deepEqual(await notes(vault), ['by leaving.md']);
    });
  });

  /** Backing out must not leave a stray file — that's what forced rename. */
  test('escape creates nothing at all', async () => {
    await withApp({}, async ({ page, vault }) => {
      await page.locator('[data-new-btn]').click();
      await page.locator('[data-name-input]').fill('never mind');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
      assert.deepEqual(await notes(vault), []);
    });
  });

  test('an empty name is not an error, it is just untitled', async () => {
    await withApp({}, async ({ page, vault }) => {
      await page.locator('[data-new-btn]').click();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
      assert.deepEqual(await notes(vault), ['untitled.md']);
    });
  });

  test('the + becomes a checkmark while naming, and back again after', async () => {
    await withApp({}, async ({ page }) => {
      assert.equal(await page.locator('[data-confirm]').isHidden(), true);
      await page.locator('[data-new-btn]').click();
      assert.equal(await page.locator('[data-new-btn]').isHidden(), true);
      assert.equal(await page.locator('[data-confirm]').isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('[data-new-btn]').isVisible(), true);
      assert.equal(await page.locator('[data-confirm]').isHidden(), true);
    });
  });
});

describe('names a filesystem will accept', () => {
  test('a slash never becomes a folder', async () => {
    await withApp({}, async ({ page, vault }) => {
      await page.locator('[data-new-btn]').click();
      await page.locator('[data-name-input]').fill('Q1/Q2 plan');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
      assert.deepEqual(await notes(vault), ['Q1 Q2 plan.md']);
      assert.equal(await exists(vault, 'Q1'), false);
    });
  });

  test('characters windows rejects are stripped', async () => {
    await withApp({}, async ({ page, vault }) => {
      await page.locator('[data-new-btn]').click();
      await page.locator('[data-name-input]').fill('what? "really" <yes>');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
      assert.deepEqual(await notes(vault), ['what really yes.md']);
    });
  });

  test('a reserved device name is escaped rather than failing', async () => {
    await withApp({}, async ({ page, vault }) => {
      await page.locator('[data-new-btn]').click();
      await page.locator('[data-name-input]').fill('con');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
      assert.deepEqual(await notes(vault), ['con note.md']);
    });
  });

  /** No rename exists, so a collision must never be a dead end. */
  test('a taken name walks to a free one instead of refusing', async () => {
    await withApp({ 'meeting.md': 'first\n' }, async ({ page, vault, read }) => {
      await page.locator('[data-new-btn]').click();
      await page.locator('[data-name-input]').fill('meeting');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);

      assert.deepEqual(await notes(vault), ['meeting 2.md', 'meeting.md']);
      assert.equal(await read('meeting.md'), 'first\n', 'the existing note was overwritten');
    });
  });
});
