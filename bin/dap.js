#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const HELP = `dap - a small, local notetaking app

usage
  dap [folder]            serve a folder of notes
  dap [folder] --port N   pick the port (default 4747)
  dap --open              open a browser too
  dap -h                  this

the folder is just a folder. notes are .md files inside it. if it doesn't
exist yet, dap makes it.
`;

/**
 * Expected problems get a sentence. Only genuine bugs get a stack trace —
 * a missing folder is not a crash, and printing Node's internals at someone
 * for it is a small betrayal of the "this is a simple tool" promise.
 */
function fail(message, hint) {
  console.error(`dap: ${message}`);
  if (hint) console.error(`     ${hint}`);
  process.exit(1);
}

let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      open: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (err) {
  fail(err.message.replace(/^Error: /, ''), 'run `dap -h` for the options that exist');
}

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const folder = path.resolve(positionals[0] ?? process.cwd());

// Make the folder if it isn't there. Pointing dap at a folder is how you say
// "keep my notes here", and refusing because it doesn't exist yet is a chore
// rather than a safeguard. Say what happened so a typo is still obvious.
let created = false;
try {
  const st = await fs.stat(folder);
  if (!st.isDirectory()) fail(`not a folder: ${folder}`);
} catch (err) {
  if (err.code !== 'ENOENT') fail(`can't read ${folder}`, err.code);
  try {
    await fs.mkdir(folder, { recursive: true });
    created = true;
  } catch (mkErr) {
    fail(`couldn't create ${folder}`, mkErr.code === 'EACCES' ? 'permission denied' : mkErr.code);
  }
}

const port = values.port === undefined ? 4747 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  fail(`--port needs a number between 0 and 65535, got "${values.port}"`);
}

const { serve } = await import('../src/server.js');

let server;
try {
  server = await serve({ vault: folder, port });
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    fail(`port ${port} is already in use`, 'try `dap --port 4748`, or stop the other dap');
  }
  if (err.code === 'EACCES') fail(`not allowed to listen on port ${port}`, 'ports below 1024 need admin');
  throw err;
}

if (created) console.log(`dap  created ${folder}`);
console.log(`dap  ${server.url}`);
console.log(`     ${folder}`);

if (values.open) {
  const { spawn } = await import('node:child_process');
  const cmd =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', server.url]]
    : process.platform === 'darwin' ? ['open', [server.url]]
    : ['xdg-open', [server.url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* headless box — the url is printed above */
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await server.close();
    process.exit(0);
  });
}
