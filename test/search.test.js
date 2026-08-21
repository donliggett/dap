import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Vault } from '../src/vault.js';
import { makeVault } from './helpers.js';

/**
 * Ranking, tested without a browser because it's just a function.
 *
 * The thing that makes search feel right or wrong isn't whether it finds
 * matches — it's the order. So the order is what gets pinned.
 */

let dir, vault;

before(async () => {
  dir = await makeVault({
    'meeting notes.md': '# meeting notes\n\nwe discussed the budget at length.\n',
    'budget.md': '# budget\n\nnumbers for the quarter. budget budget budget.\n',
    'groceries.md': '# groceries\n\nmilk, eggs, bread\n',
    'archive/old budget.md': '# old budget\n\nlast year\n',
    'long.md': '# long\n\n' + 'padding '.repeat(60) + 'needle here\n',
  });
  vault = new Vault(dir);
});
after(async () => fs.rm(dir, { recursive: true, force: true }));

const paths = async (q) => (await vault.search(q)).map((r) => r.path);

describe('finding things', () => {
  test('matches on filename', async () => {
    assert.ok((await paths('groceries')).includes('groceries.md'));
  });

  test('matches on content', async () => {
    assert.ok((await paths('milk')).includes('groceries.md'));
  });

  test('finds nothing for nonsense', async () => {
    assert.deepEqual(await paths('zzzznotathing'), []);
  });

  test('an empty query returns nothing rather than everything', async () => {
    assert.deepEqual(await vault.search(''), []);
    assert.deepEqual(await vault.search('   '), []);
  });

  test('is case insensitive', async () => {
    assert.ok((await paths('GROCERIES')).includes('groceries.md'));
    assert.ok((await paths('Milk')).includes('groceries.md'));
  });

  test('searches inside folders too', async () => {
    assert.ok((await paths('last year')).includes('archive/old budget.md'));
  });
});

describe('the order', () => {
  /** The note you named beats the note that merely mentions it. */
  test('an exact name match comes first', async () => {
    const r = await paths('budget');
    assert.equal(r[0], 'budget.md', `got: ${r.join(', ')}`);
  });

  test('a name match beats a body match', async () => {
    const r = await paths('budget');
    assert.ok(
      r.indexOf('budget.md') < r.indexOf('meeting notes.md'),
      `body match outranked the name: ${r.join(', ')}`,
    );
  });

  test('a folder note still ranks by its own name', async () => {
    const r = await paths('old budget');
    assert.equal(r[0], 'archive/old budget.md', `got: ${r.join(', ')}`);
  });
});

describe('multiple words', () => {
  /** Two words means "narrow it down", not "show me either". */
  test('every term must appear', async () => {
    assert.deepEqual(await paths('budget zzzznope'), []);
  });

  test('terms can come from name and body together', async () => {
    assert.ok((await paths('groceries eggs')).includes('groceries.md'));
  });
});

describe('the snippet', () => {
  test('shows the line the match is on', async () => {
    const [hit] = await vault.search('milk');
    assert.match(hit.snippet, /milk, eggs, bread/);
    assert.equal(typeof hit.line, 'number');
  });

  test('prefers the line carrying the most terms', async () => {
    const [hit] = await vault.search('eggs bread');
    assert.match(hit.snippet, /milk, eggs, bread/);
  });

  test('trims a very long line around the match', async () => {
    const [hit] = await vault.search('needle');
    assert.ok(hit.snippet.length <= 170, `snippet was ${hit.snippet.length} chars`);
    assert.match(hit.snippet, /needle/);
  });
});

describe('cost', () => {
  test('a realistic vault searches fast enough not to need an index', async () => {
    const big = await makeVault(
      Object.fromEntries(
        Array.from({ length: 400 }, (_, i) => [
          `n${i}.md`,
          `# note ${i}\n\n${'lorem ipsum dolor sit amet '.repeat(20)}\nneedle${i}\n`,
        ]),
      ),
    );
    try {
      const v = new Vault(big);
      const started = performance.now();
      const hits = await v.search('needle399');
      const took = performance.now() - started;
      assert.equal(hits[0].path, 'n399.md');
      assert.ok(took < 1500, `400 notes took ${Math.round(took)}ms — time to reconsider the index`);
    } finally {
      await fs.rm(big, { recursive: true, force: true });
    }
  });
});
