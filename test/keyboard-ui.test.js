import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from './helpers.js';

/**
 * The other half of the keyboard fix.
 *
 * keyboard.test.js proves the number is right. This proves the layout listens
 * to it — the two are wired together by a CSS custom property, and a token
 * nothing reads is exactly the kind of thing that looks finished and is not.
 *
 * A headless browser cannot raise a keyboard, so the tests set `--kb` by hand
 * and ask whether anything moved. That is a real question: before this, the
 * answer was no, because the search panel was sized against the layout
 * viewport, which on iOS does not shrink for the keyboard at all.
 */

const PHONE = { width: 390, height: 844 };
const KEYBOARD = 336; // iPhone portrait, roughly
const VISIBLE = PHONE.height - KEYBOARD;

/**
 * Resizing the window makes the real tracker fire and write --kb itself, and it
 * fires a beat after setViewportSize returns. Raising the fake keyboard into
 * that gap gets it overwritten with 0 — which cost me a debugging session and
 * looked exactly like the CSS not working.
 */
async function phone(page) {
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(250);
}

/**
 * Ctrl+K rather than the nav button: at phone width the button lives in the
 * closed drawer, and a test that has to open a drawer to reach search is
 * testing the drawer.
 */
async function openSearch(page) {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[data-search-input]', { state: 'visible' });
}

/** Pretend the keyboard just came up, the way trackKeyboard would. */
const raiseKeyboard = (page, px = KEYBOARD) =>
  page.evaluate((n) => {
    document.documentElement.style.setProperty('--kb', `${n}px`);
    document.documentElement.dataset.keyboard = 'up';
  }, px);

/**
 * Enough matches that the panel actually reaches its full height. With six
 * notes it fit on screen with room to spare, so the assertion below passed
 * while proving nothing — the guard at the top of the first test is there to
 * catch exactly that.
 */
const NOTES = Object.fromEntries(
  Array.from({ length: 30 }, (_, i) => [
    `note-${String(i).padStart(2, '0')}.md`,
    `# note ${i}\n\nbudget line item ${i}\n`,
  ]),
);

describe('with the keyboard up', () => {
  test('the search panel stays where it can be seen', async () => {
    await withApp(NOTES, async ({ page }) => {
      await phone(page);
      await openSearch(page);
      await page.fill('[data-search-input]', 'budget');
      await page.waitForSelector('.search-row');

      const before = await page.locator('.search-panel').boundingBox();
      assert.ok(before.y + before.height > VISIBLE, 'fixture is wrong — nothing to fix');

      await raiseKeyboard(page);
      await page.waitForTimeout(120);

      const after = await page.locator('.search-panel').boundingBox();
      assert.ok(
        after.y + after.height <= VISIBLE + 1,
        `the panel still runs to ${Math.round(after.y + after.height)}px, ` +
          `past the ${VISIBLE}px the keyboard leaves visible`,
      );
    });
  });

  test('results stay reachable by scrolling inside the panel', async () => {
    await withApp(NOTES, async ({ page }) => {
      await phone(page);
      await openSearch(page);
      await page.fill('[data-search-input]', 'budget');
      await page.waitForSelector('.search-row');
      await raiseKeyboard(page);
      await page.waitForTimeout(120);

      // The list must be the thing that overflows, not the page: a results
      // list taller than its own box is scrollable, one taller than the
      // screen is simply gone.
      const list = await page.locator('.search-results').boundingBox();
      assert.ok(
        list.y + list.height <= VISIBLE + 1,
        'the results list itself extends under the keyboard',
      );

      const scrollable = await page.evaluate(() => {
        const el = document.querySelector('.search-results');
        return el.scrollHeight > el.clientHeight ? 'yes' : 'fits';
      });
      assert.ok(['yes', 'fits'].includes(scrollable));
    });
  });

  test('the status bar is not buried', async () => {
    await withApp(NOTES, async ({ page }) => {
      await phone(page);
      await raiseKeyboard(page);
      await page.waitForTimeout(120);

      const status = await page.locator('.status').boundingBox();
      assert.ok(
        status.y + status.height <= VISIBLE + 1,
        `the status bar sits at ${Math.round(status.y + status.height)}px, under the keyboard`,
      );
    });
  });

  test('everything returns when the keyboard goes down', async () => {
    await withApp(NOTES, async ({ page }) => {
      await phone(page);
      await raiseKeyboard(page);
      await page.waitForTimeout(80);
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--kb', '0px');
        document.documentElement.dataset.keyboard = 'down';
      });
      await page.waitForTimeout(120);

      const status = await page.locator('.status').boundingBox();
      assert.ok(
        status.y + status.height > VISIBLE,
        'the layout stayed squashed after the keyboard closed',
      );
    });
  });
});
