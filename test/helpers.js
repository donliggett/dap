import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { serve } from '../src/server.js';

export async function makeVault(files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dap-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

/**
 * A running server and a real browser pointed at it.
 *
 * Everything the browser does here happens at human speed — see the waits in
 * the tests. Assertions that fire in the same tick as the keystroke are what
 * let the last build ship an editor you could not type in.
 */
/**
 * Read what's in the editor, whatever engine is mounted.
 *
 * A textarea keeps its content in `value`; a contenteditable keeps it in the
 * DOM. Playwright's hasText only sees the latter, so asserting through it
 * silently stops working the moment the engine changes.
 */
export const editorText = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-editor]');
    return el?.tagName === 'TEXTAREA' ? el.value : (el?.innerText ?? '');
  });

/** Put the caret at the end of the first line, deterministically. */
export async function caretToEndOfFirstLine(page) {
  await page.locator('[data-editor]').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('End');
}

/**
 * Poll for an attribute rather than reading it once.
 *
 * Reading immediately after a click passes on an idle machine and fails when
 * three browsers are competing — the assertion outruns the handler. Waiting for
 * the state is the same discipline the typing tests use.
 */
export async function waitForAttr(page, selector, attr, expected, timeout = 3000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await page.getAttribute(selector, attr);
    if (last === expected) return last;
    await page.waitForTimeout(40);
  }
  throw new Error(`${selector}[${attr}] was "${last}", expected "${expected}"`);
}

export async function withApp(files, fn) {
  const vault = await makeVault(files);
  const app = await serve({ vault, port: 0 });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(app.url);
    // Wait for the app to finish wiring before anyone touches it. Clicking a
    // control whose handler isn't attached yet does nothing, and the failure
    // surfaces 30 seconds later as an unrelated click timeout.
    await page.waitForSelector('body[data-ready="true"]', { timeout: 10000 });
    return await fn({ page, vault, app, read: (rel) => fs.readFile(path.join(vault, rel), 'utf8') });
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(vault, { recursive: true, force: true });
  }
}
