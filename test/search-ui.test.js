import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from './helpers.js';

const VAULT = {
  'meeting notes.md': '# meeting notes\n\nwe discussed the budget at length.\n',
  'budget.md': '# budget\n\nnumbers for the quarter.\n',
  'groceries.md': '# groceries\n\nmilk, eggs, bread\n',
};

const search = async (page, q) => {
  await page.keyboard.press('Control+k');
  await page.locator('[data-search-input]').fill(q);
  await page.waitForTimeout(500);
};
const rows = (page) => page.locator('.search-row');

describe('opening search', () => {
  test('ctrl+k opens it', async ({ }) => {
    await withApp(VAULT, async ({ page }) => {
      assert.equal(await page.locator('[data-search]').isHidden(), true);
      await page.keyboard.press('Control+k');
      assert.equal(await page.locator('[data-search]').isVisible(), true);
    });
  });

  /** Ctrl+K is a CodeMirror binding in some editors; ours must win. */
  test('ctrl+k works while the editor has focus', async () => {
    await withApp(VAULT, async ({ page }) => {
      await page.locator('[data-editor]').click();
      await page.keyboard.press('Control+k');
      assert.equal(await page.locator('[data-search]').isVisible(), true);
    });
  });

  test('the nav item opens it', async () => {
    await withApp(VAULT, async ({ page }) => {
      await page.locator('[data-drawer-toggle]').click();
      await page.locator('[data-open-search]').click();
      assert.equal(await page.locator('[data-search]').isVisible(), true);
    });
  });

  test('escape closes it and leaves the drawer alone', async () => {
    await withApp(VAULT, async ({ page }) => {
      await page.keyboard.press('Control+k');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('[data-search]').isHidden(), true);
    });
  });

  test('clicking the backdrop closes it', async () => {
    await withApp(VAULT, async ({ page }) => {
      await page.keyboard.press('Control+k');
      await page.locator('[data-search]').click({ position: { x: 8, y: 8 } });
      assert.equal(await page.locator('[data-search]').isHidden(), true);
    });
  });
});

describe('results', () => {
  test('finds by name and shows the path', async () => {
    await withApp(VAULT, async ({ page }) => {
      await search(page, 'groceries');
      assert.equal(await rows(page).count(), 1);
      assert.match(await rows(page).first().textContent(), /groceries\.md/);
    });
  });

  test('finds by content and shows the matching line', async () => {
    await withApp(VAULT, async ({ page }) => {
      await search(page, 'milk');
      assert.match(await rows(page).first().textContent(), /milk, eggs, bread/);
    });
  });

  test('the match itself is highlighted', async () => {
    await withApp(VAULT, async ({ page }) => {
      await search(page, 'milk');
      assert.equal(await page.locator('.search-snippet mark').first().textContent(), 'milk');
    });
  });

  test('says so when nothing matches', async () => {
    await withApp(VAULT, async ({ page }) => {
      await search(page, 'zzzznope');
      assert.equal(await rows(page).count(), 0);
      assert.match(await page.locator('[data-search-status]').textContent(), /nothing found/);
    });
  });

  test('clearing the field clears the results', async () => {
    await withApp(VAULT, async ({ page }) => {
      await search(page, 'milk');
      await page.locator('[data-search-input]').fill('');
      await page.waitForTimeout(400);
      assert.equal(await rows(page).count(), 0);
    });
  });
});

describe('choosing a result', () => {
  test('enter opens the note and closes search', async () => {
    await withApp(VAULT, async ({ page }) => {
      await search(page, 'milk');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);

      assert.equal(await page.locator('[data-search]').isHidden(), true);
      assert.match(await page.locator('[data-doc-name]').textContent(), /groceries\.md/);
    });
  });

  test('arrow keys move the selection before enter', async () => {
    await withApp(VAULT, async ({ page }) => {
      await search(page, 'budget');
      assert.ok((await rows(page).count()) >= 2, 'need two results for this to mean anything');
      const first = await rows(page).nth(0).textContent();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);

      const opened = await page.locator('[data-doc-name]').textContent();
      assert.ok(!first.includes(opened), `arrow down still opened the first result (${opened})`);
    });
  });

  test('clicking a result opens it', async () => {
    await withApp(VAULT, async ({ page }) => {
      await search(page, 'quarter');
      await rows(page).first().click();
      await page.waitForTimeout(600);
      assert.match(await page.locator('[data-doc-name]').textContent(), /budget\.md/);
    });
  });
});

describe('search does not damage anything', () => {
  test('an unsaved edit is kept when you search and open another note', async () => {
    await withApp(VAULT, async ({ page, read }) => {
      // Open a KNOWN note first. The fixture's files are created in the same
      // millisecond, so "most recent" — which is what boots — is arbitrary,
      // and assuming which note is open makes this pass or fail by luck.
      await search(page, 'budget');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
      assert.match(await page.locator('[data-doc-name]').textContent(), /budget\.md/);

      await page.locator('[data-editor]').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' UNSAVED');

      // straight into search without waiting for autosave
      await search(page, 'groceries');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1400);

      assert.match(await page.locator('[data-doc-name]').textContent(), /groceries\.md/);
      assert.match(await read('budget.md'), /UNSAVED/, 'the pending edit was lost on the way out');
    });
  });

  test('searching never writes to a note', async () => {
    await withApp(VAULT, async ({ page, read }) => {
      const before = await read('groceries.md');
      await search(page, 'milk');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      assert.equal(await read('groceries.md'), before);
    });
  });
});
