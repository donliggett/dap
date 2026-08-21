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
export async function withApp(files, fn) {
  const vault = await makeVault(files);
  const app = await serve({ vault, port: 0 });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(app.url);
    return await fn({ page, vault, app, read: (rel) => fs.readFile(path.join(vault, rel), 'utf8') });
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(vault, { recursive: true, force: true });
  }
}
