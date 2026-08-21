import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import { serve } from '../src/server.js';
import { makeVault } from './helpers.js';

/**
 * The Host allowlist is the DNS-rebinding guard, so it gets tested directly
 * rather than through the browser — `fetch` refuses to set a Host header, which
 * means a browser test would silently prove nothing.
 */

let vault, app;
const TAILNET = 'desktop-alpha.drake-chroma.ts.net';

before(async () => {
  vault = await makeVault({ 'a.md': 'a\n' });
  app = await serve({ vault, port: 0, allowHosts: [TAILNET] });
});
after(async () => {
  await app.close();
  await fs.rm(vault, { recursive: true, force: true });
});

/** Raw socket, because we need to choose the Host header ourselves. */
function get(hostHeader, target = '/api/notes') {
  return new Promise((resolve) => {
    const sock = net.connect(app.port, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => (buf += d));
    sock.on('end', () => resolve(buf));
    sock.on('error', () => resolve('ERR'));
  });
}
const status = async (h) => (await get(h)).split('\r\n')[0];

describe('host allowlist', () => {
  test('localhost is allowed', async () => {
    assert.match(await status(`localhost:${app.port}`), /200/);
  });

  test('127.0.0.1 is allowed', async () => {
    assert.match(await status(`127.0.0.1:${app.port}`), /200/);
  });

  test('a named host is allowed once you name it', async () => {
    assert.match(await status(TAILNET), /200/, 'the tailnet name should be answered');
  });

  test('the named host works without a port, as a proxy sends it', async () => {
    // tailscale serve terminates TLS on 443, and browsers omit the default
    // port — so the Host header arrives bare. That must still match.
    assert.match(await status(TAILNET), /200/);
  });

  /** The whole point: naming one host must not open the door to every host. */
  test('an unnamed host is still refused', async () => {
    assert.match(await status('evil.example.com'), /403/);
  });

  test('a rebound subdomain of the allowed name is refused', async () => {
    assert.match(await status(`attacker.${TAILNET}`), /403/);
  });

  test('an empty host is refused', async () => {
    assert.match(await status(''), /403/);
  });

  test('the refusal says how to fix it', async () => {
    const body = await get('evil.example.com');
    assert.match(body, /--hostname/, 'a 403 should explain itself');
  });

  test('by default only loopback is allowed', async () => {
    const bare = await makeVault({ 'a.md': 'a\n' });
    const plain = await serve({ vault: bare, port: 0 });
    try {
      assert.deepEqual(plain.allowed.includes(TAILNET), false);
    } finally {
      await plain.close();
      await fs.rm(bare, { recursive: true, force: true });
    }
  });
});
