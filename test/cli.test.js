import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeVault } from './helpers.js';
import * as cli from '../src/cli.js';
import { Vault } from '../src/vault.js';

const exists = (abs) => fs.access(abs).then(() => true, () => false);

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/dap.js');

/**
 * The CLI is exercised by actually running it.
 *
 * Two bugs shipped in the previous build because a file was edited and never
 * executed — a flag advertised in --help that parseArgs rejected, and a help
 * string containing backticks that made the whole module a syntax error. Both
 * are caught by running the thing once.
 */

let vault;

before(async () => {
  vault = await makeVault({
    'budget.md': '# budget\n\nnumbers for the quarter\n',
    'groceries.md': '# groceries\n\nmilk, eggs, bread\n',
    'archive/old budget.md': '# old budget\n\nlast year\n',
  });
});
after(async () => fs.rm(vault, { recursive: true, force: true }));

/** Runs without a TTY, which is the piped behaviour. */
function run(args, { input = null, cwd = vault, vaultDir = vault } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, ...args],
      { cwd, env: { ...process.env, DAP_VAULT: vaultDir } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

describe('the binary runs at all', () => {
  test('--help prints usage and exits clean', async () => {
    const { code, stdout } = await run(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /usage/);
  });

  /**
   * Every flag dap advertises as its OWN option must actually parse.
   *
   * Scoped to the options block on purpose — the help also shows example
   * commands for other tools, and scraping the whole text picks up
   * `tailscale serve --bg` and asks dap to accept it.
   */
  test('every documented flag is accepted', async () => {
    const { stdout } = await run(['--help']);
    const block = stdout.slice(stdout.indexOf('\noptions')).split('\n\n')[0];
    const flags = [...block.matchAll(/(?:^|\s)(--[a-z-]{2,})/g)].map((m) => m[1]);
    assert.ok(flags.length >= 5, `expected several flags, found ${flags.length}`);

    const needsValue = new Set(['--vault', '--port', '--hostname']);
    for (const flag of new Set(flags)) {
      const args = needsValue.has(flag) ? [flag, flag === '--port' ? '0' : 'x'] : [flag];
      const { stderr } = await run([...args, '--help']);
      assert.doesNotMatch(stderr, /Unknown option/, `${flag} is documented but rejected`);
    }
  });

  test('an unknown flag explains itself instead of throwing', async () => {
    const { code, stderr } = await run(['--nonsense']);
    assert.equal(code, 2);
    assert.match(stderr, /dap:/);
    assert.doesNotMatch(stderr, /at Object|node:internal/, 'a stack trace leaked');
  });
});

describe('ls', () => {
  test('lists every note', async () => {
    const { code, stdout } = await run(['ls']);
    assert.equal(code, 0);
    const lines = stdout.trim().split('\n');
    assert.deepEqual(lines.sort(), ['archive/old budget.md', 'budget.md', 'groceries.md']);
  });

  test('piped output is bare paths, one per line', async () => {
    const { stdout } = await run(['ls']);
    for (const line of stdout.trim().split('\n')) {
      assert.match(line, /^[^\s].*\.md$/, `decorated when piped: ${JSON.stringify(line)}`);
    }
  });

  test('an empty folder is exit 1, not a crash', async () => {
    const empty = await makeVault({});
    try {
      const { code } = await run(['ls', '-C', empty]);
      assert.equal(code, 1);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});

describe('find', () => {
  test('finds by content and exits 0', async () => {
    const { code, stdout } = await run(['find', 'milk']);
    assert.equal(code, 0);
    assert.match(stdout, /groceries\.md/);
  });

  test('a miss is exit 1 with nothing on stdout', async () => {
    const { code, stdout } = await run(['find', 'zzzznope']);
    assert.equal(code, 1);
    assert.equal(stdout.trim(), '');
  });

  test('multiple words narrow rather than widen', async () => {
    const { stdout } = await run(['find', 'budget', 'zzzznope']);
    assert.equal(stdout.trim(), '');
  });

  test('output is pipeable straight into another command', async () => {
    const { stdout } = await run(['find', 'budget']);
    for (const line of stdout.trim().split('\n')) assert.match(line, /\.md$/);
  });

  test('asking for nothing is a usage error', async () => {
    const { code, stderr } = await run(['find']);
    assert.equal(code, 2);
    assert.match(stderr, /usage/);
  });
});

describe('cat', () => {
  test('prints raw markdown, not rendered text', async () => {
    const { code, stdout } = await run(['cat', 'budget']);
    assert.equal(code, 0);
    assert.equal(stdout, '# budget\n\nnumbers for the quarter\n');
  });

  test('a partial name is enough', async () => {
    const { stdout } = await run(['cat', 'groc']);
    assert.match(stdout, /milk, eggs, bread/);
  });

  test('the full path works too', async () => {
    const { stdout } = await run(['cat', 'archive/old budget.md']);
    assert.match(stdout, /last year/);
  });

  /** Two matches is a question, not a guess. */
  test('an ambiguous name lists the candidates and refuses', async () => {
    const { code, stderr, stdout } = await run(['cat', 'budget.md'.slice(0, 3)]);
    assert.equal(code, 2);
    assert.match(stderr, /be more specific/);
    assert.match(stderr, /archive\/old budget\.md/);
    assert.equal(stdout, '', 'printed a note despite being unsure which');
  });

  test('a miss is exit 1', async () => {
    const { code } = await run(['cat', 'zzzznope']);
    assert.equal(code, 1);
  });
});

describe('path', () => {
  test('prints an absolute path for use in a shell', async () => {
    const { code, stdout } = await run(['path', 'groceries']);
    assert.equal(code, 0);
    const p = stdout.trim();
    assert.ok(path.isAbsolute(p), `not absolute: ${p}`);
    await fs.access(p);
  });
});

describe('new', () => {
  test('creates an empty note', async () => {
    const dir = await makeVault({});
    try {
      const { code, stdout } = await run(['new', 'fresh thought', '-C', dir]);
      assert.equal(code, 0);
      assert.equal(stdout.trim(), 'fresh thought.md');
      assert.equal(await fs.readFile(path.join(dir, 'fresh thought.md'), 'utf8'), '');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  /** The point of a CLI: it composes. */
  test('takes its body from stdin when piped', async () => {
    const dir = await makeVault({});
    try {
      await run(['new', 'from pipe', '-C', dir], { input: '# piped\n\nbody\n' });
      assert.equal(await fs.readFile(path.join(dir, 'from pipe.md'), 'utf8'), '# piped\n\nbody\n');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('sanitises the name the same way the browser does', async () => {
    const dir = await makeVault({});
    try {
      await run(['new', 'Q1/Q2 plan', '-C', dir]);
      const files = await fs.readdir(dir);
      assert.deepEqual(files, ['Q1 Q2 plan.md']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('never overwrites an existing note', async () => {
    const dir = await makeVault({ 'taken.md': 'original\n' });
    try {
      await run(['new', 'taken', '-C', dir]);
      assert.equal(await fs.readFile(path.join(dir, 'taken.md'), 'utf8'), 'original\n');
      assert.equal(await fs.readFile(path.join(dir, 'taken 2.md'), 'utf8'), '');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('choosing the folder', () => {
  test('DAP_VAULT is honoured', async () => {
    const { stdout } = await run(['ls'], { cwd: path.dirname(vault) });
    assert.match(stdout, /budget\.md/);
  });

  test('-C beats the environment', async () => {
    const other = await makeVault({ 'only-here.md': 'x\n' });
    try {
      const { stdout } = await run(['ls', '-C', other]);
      assert.equal(stdout.trim(), 'only-here.md');
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  test('a missing folder says so without a stack trace', async () => {
    const { code, stderr } = await run(['ls', '-C', '/definitely/not/here']);
    assert.equal(code, 2);
    assert.match(stderr, /no such folder/);
    assert.doesNotMatch(stderr, /node:internal/);
  });
});

describe('stdin', () => {
  /**
   * Found by running it, not by writing a test.
   *
   * "not a TTY, so read until EOF" hangs forever on a pipe nobody writes to or
   * closes — cron, CI, any script that inherits a stdin it isn't using. Every
   * other test here closes stdin explicitly, so none of them could see it.
   *
   * The reproduction is just: give the child a pipe and never touch it. No
   * mkfifo, which does not exist on Windows anyway.
   */
  test('a pipe with no writer does not hang forever', async () => {
    const dir = await makeVault({});
    try {
      const started = Date.now();
      const code = await new Promise((resolve) => {
        const child = execFile(
          process.execPath,
          [BIN, 'new', 'from a dead pipe', '-C', dir],
          { env: { ...process.env, DAP_VAULT: dir }, timeout: 15000 },
          (error) => resolve(error?.code ?? 0),
        );
        // Deliberately never end() or write() — the pipe stays open with
        // nothing coming, which is the situation that used to hang.
        void child;
      });

      assert.equal(code, 0, 'exited badly, or was killed by the timeout');
      assert.ok(Date.now() - started < 10000, 'it waited for input that was never coming');
      assert.equal(await fs.readFile(path.join(dir, 'from a dead pipe.md'), 'utf8'), '');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('no server needed', () => {
  /** The whole point — these work over ssh, in cron, with nothing running. */
  test('every read command works with no server anywhere', async () => {
    for (const args of [['ls'], ['find', 'budget'], ['cat', 'budget'], ['path', 'budget']]) {
      const { code } = await run(args);
      assert.equal(code, 0, `\`dap ${args.join(' ')}\` needed something to be running`);
    }
  });
});

/**
 * Deleting from a terminal.
 *
 * The interesting part is not the deletion — `vault.trash` is covered
 * elsewhere — it is the asking. dap's rule is that destructive things ask, and
 * a CLI has nobody to ask when it runs in a script. A prompt written to a pipe
 * is not a safeguard, it is a hang.
 */
describe('rm', () => {
  const own = (dir) => ({ vaultDir: dir, cwd: dir });

  test('moves the note to the trash rather than removing it', async () => {
    const dir = await makeVault({ 'note.md': 'body\n' });
    try {
      const { code, stdout } = await run(['rm', 'note', '--yes'], own(dir));

      assert.equal(code, cli.EXIT.ok);
      assert.match(stdout.trim(), /^\.trash\//, `said "${stdout.trim()}"`);
      assert.equal(await exists(path.join(dir, 'note.md')), false);
      assert.equal(await exists(path.join(dir, stdout.trim())), true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The one that matters. Without a terminal there is nothing to answer a
   * prompt, so the choice is between deleting silently and refusing. Refuse,
   * with a sentence saying what to type instead.
   */
  test('refuses to delete unasked when nothing can answer', async () => {
    const dir = await makeVault({ 'note.md': 'body\n' });
    try {
      const { code, stderr } = await run(['rm', 'note'], own(dir));

      assert.equal(code, cli.EXIT.usage);
      assert.match(stderr, /--yes/, `said "${stderr}"`);
      assert.equal(await exists(path.join(dir, 'note.md')), true, 'deleted it anyway');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('resolves a partial name the way the other commands do', async () => {
    const dir = await makeVault({ 'budget 2026.md': 'x\n', 'other.md': 'y\n' });
    try {
      const { code } = await run(['rm', 'budget', '--yes'], own(dir));
      assert.equal(code, cli.EXIT.ok);
      assert.equal(await exists(path.join(dir, 'budget 2026.md')), false);
      assert.equal(await exists(path.join(dir, 'other.md')), true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('two matches is a question, not a coin toss', async () => {
    const dir = await makeVault({ 'budget 2025.md': 'x\n', 'budget 2026.md': 'y\n' });
    try {
      const { code, stderr } = await run(['rm', 'budget', '--yes'], own(dir));

      assert.equal(code, cli.EXIT.usage);
      assert.match(stderr, /budget 2025\.md/);
      assert.match(stderr, /budget 2026\.md/);
      assert.equal(await exists(path.join(dir, 'budget 2025.md')), true, 'deleted one of them');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a note that is not there is a miss, not a crash', async () => {
    const dir = await makeVault({});
    try {
      const { code } = await run(['rm', 'ghost', '--yes'], own(dir));
      assert.equal(code, cli.EXIT.notFound);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('what it deleted comes back like anything else in the trash', async () => {
    const dir = await makeVault({ 'note.md': 'worth keeping\n' });
    try {
      await run(['rm', 'note', '--yes'], own(dir));

      const vault = new Vault(dir);
      const [item] = await vault.trashList();
      await vault.restore(item.trashed, item.path);

      assert.equal(await fs.readFile(path.join(dir, 'note.md'), 'utf8'), 'worth keeping\n');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('rm, with somebody there to answer', () => {
  /**
   * Driven directly rather than through a spawned process. Faking a TTY on a
   * child is a fight, and the thing worth testing is the decision, not the
   * terminal.
   */
  const answering = (answer) => async () => answer;

  test('yes deletes it', async () => {
    const dir = await makeVault({ 'note.md': 'x\n' });
    try {
      const code = await cli.rm(new Vault(dir), 'note', {
        interactive: true,
        ask: answering(true),
      });
      assert.equal(code, cli.EXIT.ok);
      assert.equal(await exists(path.join(dir, 'note.md')), false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('anything else leaves it alone', async () => {
    const dir = await makeVault({ 'note.md': 'x\n' });
    try {
      const code = await cli.rm(new Vault(dir), 'note', {
        interactive: true,
        ask: answering(false),
      });
      assert.equal(code, cli.EXIT.ok, 'declining is not an error');
      assert.equal(await exists(path.join(dir, 'note.md')), true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('the question names the file, not what was typed', async () => {
    // `dap rm budget` matching `budget 2026.md` on a substring is exactly how
    // the wrong note gets deleted. The prompt is where that gets caught.
    const dir = await makeVault({ 'budget 2026.md': 'x\n' });
    let asked = '';
    try {
      await cli.rm(new Vault(dir), 'budget', {
        interactive: true,
        ask: async (q) => { asked = q; return false; },
      });
      assert.match(asked, /budget 2026\.md/, `asked "${asked}"`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
