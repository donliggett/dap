import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, editorText, caretToEndOfFirstLine } from './helpers.js';

/**
 * Round-trip fidelity.
 *
 * These exist before the markdown serializer does, on purpose. A rich-text
 * editor stores a document model, not text — so saving is a re-serialization,
 * and a serializer with different opinions than your file will quietly rewrite
 * it. For a files-first app that is the failure that destroys trust: you open a
 * note to read it, and git shows a diff.
 *
 * The plain engine passes these trivially. The rich engine is what they're for.
 */

const SETTLE = 1200;

const TRICKY = `---
title: fixture
tags: [a, b]
---

# heading one

Some *emphasis*, some **strong**, and a [link](https://example.com).

- first
- second
  - nested
- third

1. one
2. two

| col | other |
|-----|-------|
| a   | b     |

> a quote
> across two lines

\`\`\`js
const x = 1;
\`\`\`

Trailing prose.
`;

describe('round trip', () => {
  test('opening a note does not rewrite it', async () => {
    await withApp({ 'tricky.md': TRICKY }, async ({ page, read }) => {
      await page.waitForSelector('body[data-ready="true"]');
      await page.waitForTimeout(SETTLE);
      assert.equal(await read('tricky.md'), TRICKY, 'the file changed just by being opened');
    });
  });

  test('clicking into a note does not rewrite it', async () => {
    await withApp({ 'tricky.md': TRICKY }, async ({ page, read }) => {
      await page.locator('[data-editor]').click();
      await page.waitForTimeout(SETTLE);
      assert.equal(await read('tricky.md'), TRICKY, 'focus alone dirtied the note');
    });
  });

  test('switching away and back does not rewrite it', async () => {
    await withApp({ 'tricky.md': TRICKY, 'other.md': 'other\n' }, async ({ page, read }) => {
      await page.locator('[data-drawer-toggle]').click();
      await page.locator('.note-item', { hasText: 'other' }).click();
      await page.waitForTimeout(500);
      await page.locator('[data-drawer-toggle]').click();
      await page.locator('.note-item', { hasText: 'tricky' }).click();
      await page.waitForTimeout(SETTLE);
      assert.equal(await read('tricky.md'), TRICKY);
    });
  });

  /**
   * The honest contract, measured rather than hoped for.
   *
   * A rich-text editor holds a document model, so saving re-serializes the
   * whole file — there is no way to edit one word and leave the other bytes
   * untouched. What we CAN promise is that nothing is lost. This test pins
   * that promise: every piece of content survives an edit.
   */
  test('editing never loses content', async () => {
    await withApp({ 'tricky.md': TRICKY }, async ({ page, read }) => {
      await page.locator('[data-editor]').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' EDIT');
      await page.waitForTimeout(SETTLE);

      const after = await read('tricky.md');
      for (const [what, pattern] of [
        ['frontmatter', /^---\ntitle: fixture\ntags: \[a, b\]\n---/],
        ['heading', /^# heading one$/m],
        ['emphasis', /\*emphasis\*/],
        ['strong', /\*\*strong\*\*/],
        ['link', /\[link\]\(https:\/\/example\.com\)/],
        ['bullet list', /^- first$/m],
        ['nested item', /^ {2}- nested$/m],
        ['ordered list', /^1\. one$/m],
        ['table cells', /\| a \| b \|/],
        ['blockquote', /^> a quote/m],
        ['code fence', /```js\nconst x = 1;\n```/],
        ['the edit', /Trailing prose\. EDIT/],
      ]) {
        assert.match(after, pattern, `${what} did not survive the round trip`);
      }
    });
  });

  /**
   * A snapshot of what normalization we currently accept. Not a wish — a record.
   * If this starts failing, the serializer got MORE destructive and we want to
   * know on the commit that did it, not months later via a confusing git diff.
   */
  test('normalization stays within the known set', async () => {
    await withApp({ 'tricky.md': TRICKY }, async ({ page, read }) => {
      await page.locator('[data-editor]').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type('.');
      await page.waitForTimeout(SETTLE);
      const after = await read('tricky.md');

      // known: table delimiter rows and cell padding are rewritten
      assert.match(after, /\| --- \| --- \|/, 'table delimiters normalize — expected');
      // known: a hard-wrapped blockquote is joined onto one line
      assert.match(after, /> a quote across two lines/, 'blockquote rewraps — expected');

      // NOT known, and must never happen:
      assert.doesNotMatch(after, /## title/, 'frontmatter must never become a heading');
      assert.doesNotMatch(after, /\\\[/, 'brackets must not be escaped into the text');
      assert.ok(after.split('\n').length > 20, 'the document must not collapse onto few lines');
    });
  });
});

describe('engine selection', () => {
  test('falls back to plain when the bundle is missing, and still works', async () => {
    await withApp({ 'a.md': 'text\n' }, async ({ page, read }) => {
      await page.waitForSelector('body[data-ready="true"]');
      await caretToEndOfFirstLine(page);
      await page.keyboard.type(' more');
      await page.waitForTimeout(SETTLE);
      assert.match(await read('a.md'), /text more/, 'the fallback editor could not save');
    });
  });

  test('?engine=plain is honoured', async () => {
    await withApp({ 'a.md': 'x\n' }, async ({ page, app }) => {
      await page.goto(`${app.url}/?engine=plain`);
      await page.waitForSelector('body[data-ready="true"]');
      assert.equal(await page.getAttribute('body', 'data-engine'), 'plain');
    });
  });

  test('unavailable commands are dimmed, not silently inert', async () => {
    await withApp({ 'a.md': 'x\n' }, async ({ page }) => {
      await page.goto(`${page.url()}?engine=plain`);
      await page.waitForSelector('body[data-ready="true"]');
      const bold = page.locator('.tool[data-cmd="bold"]');
      assert.equal(await bold.isDisabled(), true);
      assert.match(await bold.getAttribute('class'), /is-unavailable/);
    });
  });
});

describe('frontmatter', () => {
  const WITH_FRONT = `---
title: kept exactly
tags: [a, b]
weird: !!binary |
  R0lGODlh
---

# body

Some prose.
`;

  /**
   * A document-model editor parses `---` as a horizontal rule and eats the YAML.
   * dap splits frontmatter off before the editor sees it and re-attaches it
   * byte for byte, so metadata it doesn't understand still survives.
   */
  test('survives an edit to the body', async () => {
    await withApp({ 'n.md': WITH_FRONT }, async ({ page, read }) => {
      await page.locator('[data-editor]').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' EDIT');
      await page.waitForTimeout(SETTLE);

      const after = await read('n.md');
      assert.ok(after.startsWith(WITH_FRONT.slice(0, WITH_FRONT.indexOf('\n\n# body'))),
        `frontmatter was altered:\n${JSON.stringify(after.slice(0, 160))}`);
      assert.match(after, /EDIT/, 'the edit never landed');
      assert.doesNotMatch(after, /## title/, 'frontmatter leaked into the document as a heading');
    });
  });

  test('is not invented where there is none', async () => {
    await withApp({ 'n.md': '# just a note\n\nbody\n' }, async ({ page, read }) => {
      await page.locator('[data-editor]').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type('.');
      await page.waitForTimeout(SETTLE);
      assert.doesNotMatch(await read('n.md'), /^---/);
    });
  });

  test('a lone --- is a horizontal rule, not an unterminated fence', async () => {
    await withApp({ 'n.md': '---\n\nnot frontmatter\n' }, async ({ page, read }) => {
      await page.waitForSelector('body[data-ready="true"]');
      await page.waitForTimeout(SETTLE);
      assert.match(await read('n.md'), /not frontmatter/);
    });
  });
});
