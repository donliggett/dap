import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from './helpers.js';

/**
 * The link dialog, which replaced a `prompt()`.
 *
 * The dialog is the smaller half of the change. The old command could only add
 * or remove: with the cursor inside an existing link it unlinked, so fixing a
 * typo in a URL meant destroying the link and building it again. Most of these
 * are about editing rather than about the modal.
 */

const SETTLE = 1200;

const selectWord = (page, word) =>
  page.evaluate((w) => {
    const walk = document.createTreeWalker(document.querySelector('[data-editor]'), NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const at = n.textContent.indexOf(w);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(n, at);
      range.setEnd(n, at + w.length);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }
    return false;
  }, word);

const openLink = async (page) => {
  await page.click('[data-cmd="link"]');
  await page.waitForSelector('[data-link-dialog][open]');
};

describe('adding a link', () => {
  test('the button opens a dialog, not a prompt', async () => {
    await withApp({ 'note.md': '# note\n\nsome words here\n' }, async ({ page }) => {
      await openLink(page);
      assert.equal(await page.isVisible('[data-link-dialog]'), true);
    });
  });

  test('wraps the selected words', async () => {
    await withApp({ 'note.md': '# note\n\nsome words here\n' }, async ({ page, read }) => {
      await page.locator('[data-editor]').click();
      assert.equal(await selectWord(page, 'words'), true, 'fixture selection failed');

      await openLink(page);
      await page.fill('[data-link-input]', 'https://example.com');
      await page.click('[data-link-apply]');
      await page.waitForTimeout(SETTLE);

      assert.match(await read('note.md'), /\[words\]\(https:\/\/example\.com\)/);
    });
  });

  test('a bare domain gets a scheme, because nobody types one', async () => {
    await withApp({ 'note.md': '# note\n\nsome words here\n' }, async ({ page, read }) => {
      await page.locator('[data-editor]').click();
      await selectWord(page, 'words');

      await openLink(page);
      await page.fill('[data-link-input]', 'example.com');
      await page.click('[data-link-apply]');
      await page.waitForTimeout(SETTLE);

      assert.match(await read('note.md'), /\(https:\/\/example\.com\)/);
    });
  });

  test('with nothing selected it writes the address as the text', async () => {
    // The old behaviour here was to do nothing at all, which read as broken.
    await withApp({ 'note.md': '# note\n\nsome words here\n' }, async ({ page, read }) => {
      await page.locator('[data-editor]').click();
      await page.keyboard.press('Control+End');

      await openLink(page);
      await page.fill('[data-link-input]', 'https://example.com');
      await page.click('[data-link-apply]');
      await page.waitForTimeout(SETTLE);

      // Either markdown form is correct. A link whose text is its own address
      // serialises as an autolink, `<https://example.com>`, which is tidier
      // than the doubled form and means the same thing everywhere.
      assert.match(
        await read('note.md'),
        /(<https:\/\/example\.com>|\[https:\/\/example\.com\]\(https:\/\/example\.com\))/,
      );
    });
  });
});

describe('editing a link that is already there', () => {
  test('prefills the address instead of starting over', async () => {
    await withApp(
      { 'note.md': '# note\n\nsee [the docs](https://old.example.com) here\n' },
      async ({ page }) => {
        await selectWord(page, 'docs');
        await openLink(page);

        assert.equal(await page.inputValue('[data-link-input]'), 'https://old.example.com');
        assert.match(await page.textContent('[data-link-title]'), /edit/i);
      },
    );
  });

  test('changing it rewrites the whole link, not part of it', async () => {
    await withApp(
      { 'note.md': '# note\n\nsee [the docs](https://old.example.com) here\n' },
      async ({ page, read }) => {
        await selectWord(page, 'docs');
        await openLink(page);
        await page.fill('[data-link-input]', 'https://new.example.com');
        await page.click('[data-link-apply]');
        await page.waitForTimeout(SETTLE);

        const note = await read('note.md');
        assert.match(note, /\[the docs\]\(https:\/\/new\.example\.com\)/, 'did not update the link');
        assert.doesNotMatch(note, /old\.example\.com/, 'left the old address behind');
        // Splitting one link into two is the classic failure of not extending
        // the mark range before setting it.
        assert.equal(note.match(/\]\(/g).length, 1, 'split the link in two');
      },
    );
  });

  test('remove takes the link off and keeps the words', async () => {
    await withApp(
      { 'note.md': '# note\n\nsee [the docs](https://example.com) here\n' },
      async ({ page, read }) => {
        await selectWord(page, 'docs');
        await openLink(page);
        await page.click('[data-link-remove]');
        await page.waitForTimeout(SETTLE);

        const note = await read('note.md');
        assert.match(note, /see the docs here/, 'the words went with the link');
        assert.doesNotMatch(note, /example\.com/);
      },
    );
  });

  test('remove is not offered when there is no link', async () => {
    await withApp({ 'note.md': '# note\n\nplain words\n' }, async ({ page }) => {
      await page.locator('[data-editor]').click();
      await openLink(page);
      assert.equal(await page.isVisible('[data-link-remove]'), false);
    });
  });
});

describe('refusing', () => {
  /**
   * The one that matters. An href becomes a live anchor in a page holding a
   * handle on every note in the vault.
   */
  test('a javascript: url is refused and the dialog stays open', async () => {
    await withApp({ 'note.md': '# note\n\nsome words here\n' }, async ({ page, read }) => {
      await page.locator('[data-editor]').click();
      await selectWord(page, 'words');

      await openLink(page);
      await page.fill('[data-link-input]', 'javascript:alert(1)');
      await page.click('[data-link-apply]');
      await page.waitForTimeout(400);

      assert.equal(await page.isVisible('[data-link-dialog]'), true, 'closed on a bad url');
      assert.equal(await page.isVisible('[data-link-error]'), true, 'refused it silently');
      assert.doesNotMatch(await read('note.md'), /javascript/);
    });
  });

  test('an empty field is refused without closing', async () => {
    await withApp({ 'note.md': '# note\n\nsome words here\n' }, async ({ page }) => {
      await page.locator('[data-editor]').click();
      await openLink(page);
      await page.fill('[data-link-input]', '   ');
      await page.click('[data-link-apply]');
      await page.waitForTimeout(300);

      assert.equal(await page.isVisible('[data-link-dialog]'), true);
    });
  });

  /**
   * A note can arrive from anywhere — a sync folder, a git clone, someone
   * else's export. The editor must not turn its markdown into a live
   * javascript: anchor just by opening it.
   */
  test('a dangerous link already in a note never becomes an anchor', async () => {
    // The safe link is the control. Without it this passes whenever no anchors
    // render at all, which would make it another test that cannot fail.
    await withApp(
      {
        'note.md':
          '# note\n\n[click me](javascript:alert(1)) and [a real one](https://example.com)\n',
      },
      async ({ page }) => {
        await page.waitForTimeout(SETTLE);

        const hrefs = await page.evaluate(() =>
          [...document.querySelectorAll('[data-editor] a')].map((a) => a.getAttribute('href')),
        );

        assert.ok(
          hrefs.includes('https://example.com'),
          `anchors are not rendering at all, so this proves nothing: ${JSON.stringify(hrefs)}`,
        );
        assert.equal(
          hrefs.some((h) => /javascript/i.test(h ?? '')),
          false,
          `rendered ${JSON.stringify(hrefs)}`,
        );
      },
    );
  });
});

describe('getting out', () => {
  test('cancel changes nothing', async () => {
    const start = '# note\n\nsome words here\n';
    await withApp({ 'note.md': start }, async ({ page, read }) => {
      await page.locator('[data-editor]').click();
      await selectWord(page, 'words');
      await openLink(page);
      await page.fill('[data-link-input]', 'https://example.com');
      await page.click('[data-link-cancel]');
      await page.waitForTimeout(SETTLE);

      assert.equal(await read('note.md'), start);
    });
  });

  test('escape changes nothing', async () => {
    const start = '# note\n\nsome words here\n';
    await withApp({ 'note.md': start }, async ({ page, read }) => {
      await page.locator('[data-editor]').click();
      await selectWord(page, 'words');
      await openLink(page);
      await page.fill('[data-link-input]', 'https://example.com');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(SETTLE);

      assert.equal(await read('note.md'), start);
    });
  });

  test('a refused url does not linger into the next open', async () => {
    // <dialog> returnValue is sticky; a stale 'apply' left over from a previous
    // round would apply something nobody asked for.
    await withApp({ 'note.md': '# note\n\nsome words here\n' }, async ({ page, read }) => {
      await page.locator('[data-editor]').click();
      await selectWord(page, 'words');

      await openLink(page);
      await page.fill('[data-link-input]', 'https://example.com');
      await page.click('[data-link-cancel]');
      await page.waitForTimeout(300);

      await openLink(page);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(SETTLE);

      assert.doesNotMatch(await read('note.md'), /example\.com/, 'applied a cancelled link');
    });
  });
});
