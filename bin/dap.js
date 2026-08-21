#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as cli from '../src/cli.js';

const HELP = `dap - a small, local notetaking app

usage
  dap [folder]              serve a folder of notes
  dap serve [folder]        the same thing, said out loud

  dap ls                    list every note, newest first
  dap find <query>          search names and contents
  dap cat <note>            print a note as raw markdown
  dap path <note>           print its full path
  dap new <name>            create a note (body from stdin if piped)

options
  -C, --vault <folder>      which folder to use (default: \$DAP_VAULT, else .)
      --port <n>            port for serve (default 4747)
      --open                open a browser too
      --hostname <name>     also answer to this host (repeatable)
      --lan                 listen on every interface, not just localhost
  -h, --help

notes are .md files in a folder. that's the whole storage format. every command
except serve reads the folder directly, so none of them need the server running.

piping
  output goes plain and one-per-line when it isn't a terminal, and exit codes
  mean something — 0 found, 1 nothing found, 2 asked wrong.

      dap find budget | xargs grep -l urgent
      vim "\$(dap path meeting)"
      pbpaste | dap new "from clipboard"

reaching dap from a phone
  put something in front of it that already does auth, and name the host:

      tailscale serve --bg 4747
      dap --hostname your-machine.your-tailnet.ts.net

  dap stays on localhost; tailscale does the listening and the authenticating.
  --lan is the blunter option: no auth, anyone on the network can read your
  notes. only on a network you trust.
`;

/**
 * Expected problems get a sentence. Only genuine bugs get a stack trace —
 * a missing folder is not a crash, and printing Node's internals at someone
 * for it is a small betrayal of the "this is a simple tool" promise.
 */
function fail(message, hint) {
  console.error(`dap: ${message}`);
  if (hint) console.error(`     ${hint}`);
  process.exit(cli.EXIT.usage);
}

let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      vault: { type: 'string', short: 'C' },
      port: { type: 'string' },
      open: { type: 'boolean', default: false },
      hostname: { type: 'string', multiple: true },
      lan: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (e) {
  fail(e.message.replace(/^Error: /, ''), 'run `dap -h` for the options that exist');
}

if (values.help) {
  console.log(HELP);
  process.exit(cli.EXIT.ok);
}

const COMMANDS = new Set(['serve', 'ls', 'find', 'cat', 'path', 'new']);
const first = positionals[0];
const command = COMMANDS.has(first) ? first : 'serve';
const rest = COMMANDS.has(first) ? positionals.slice(1) : positionals;

// `dap ./notes` serves that folder; `dap find x -C ./notes` searches it. The
// positional only means "folder" for serve, where it's the common case.
const folder = path.resolve(
  values.vault ?? (command === 'serve' ? rest[0] ?? process.env.DAP_VAULT ?? '.' : process.env.DAP_VAULT ?? '.'),
);

if (command !== 'serve') {
  const opened = await cli.openVault(folder);
  if (opened.error) fail(opened.error, 'use -C <folder> or set DAP_VAULT');

  const arg = rest.join(' ');
  let code;
  switch (command) {
    case 'ls': code = await cli.ls(opened.vault); break;
    case 'find': code = await cli.find(opened.vault, arg); break;
    case 'cat': code = await cli.cat(opened.vault, arg); break;
    case 'path': code = await cli.where(opened.vault, arg); break;
    case 'new': code = await cli.neu(opened.vault, arg, { stdin: await cli.readStdin() }); break;
  }
  process.exit(code);
}

// ── serve ──────────────────────────────────────────────────────────────

// Pointing dap at a folder is how you say "keep my notes here", so make it if
// it isn't there. Say so, in case it was a typo.
let created = false;
try {
  const st = await fs.stat(folder);
  if (!st.isDirectory()) fail(`not a folder: ${folder}`);
} catch (e) {
  if (e.code !== 'ENOENT') fail(`can't read ${folder}`, e.code);
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
  server = await serve({
    vault: folder,
    port,
    host: values.lan ? '0.0.0.0' : '127.0.0.1',
    allowHosts: values.hostname ?? [],
  });
} catch (e) {
  if (e.code === 'EADDRINUSE') fail(`port ${port} is already in use`, 'try --port 4748, or stop the other dap');
  if (e.code === 'EACCES') fail(`not allowed to listen on port ${port}`, 'ports below 1024 need admin');
  throw e;
}

if (created) console.log(`dap  created ${folder}`);
console.log(`dap  ${server.url}`);
console.log(`     ${folder}`);
for (const name of values.hostname ?? []) console.log(`     also answering to ${name}`);
if (values.lan) console.log('     listening on every interface — dap has no password of its own');

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
    process.exit(cli.EXIT.ok);
  });
}
