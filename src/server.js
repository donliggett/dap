import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault, BadPath } from './vault.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'];

/**
 * Which Host headers we answer to.
 *
 * This is the DNS-rebinding guard: an attacker can point their own domain at
 * 127.0.0.1, and the browser will then send us requests carrying THEIR host
 * — same-origin as far as it's concerned, so origin checks don't help.
 * Checking Host is what stops it.
 *
 * Which is why reaching dap from a phone can't just mean "allow anything".
 * You name the host you'll actually use (a tailnet name, a LAN address), and
 * that name joins the list. Everything else still gets turned away.
 */
function buildAllowlist(extra = []) {
  const set = new Set(LOOPBACK);
  for (const h of extra) {
    const name = String(h).trim().replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    if (name) set.add(name);
  }
  return set;
}

export async function serve({ vault: vaultPath, port = 4747, host = '127.0.0.1', allowHosts = [] }) {
  const vault = new Vault(vaultPath);
  await fs.access(vault.root);
  const allowed = buildAllowlist(allowHosts);

  let boundPort = port;

  const server = http.createServer(async (req, res) => {
    try {
      // Host check before anything else. An attacker's domain can be pointed at
      // 127.0.0.1, and the browser will then send us same-origin requests with
      // their Host header — origin checks don't catch that, this does.
      // Bracketed IPv6 hosts keep their brackets; everything else loses its port.
      const raw = req.headers.host ?? '';
      const m = raw.match(/^(\[[^\]]+\]|[^:]+)(?::\d+)?$/);
      const hostName = m ? m[1] : '';
      if (!allowed.has(hostName)) {
        return json(res, 403, {
          error: 'bad host',
          host: hostName,
          hint: `dap only answers to ${[...allowed].join(', ')} — start it with --hostname ${hostName || '<name>'} to add this one`,
        });
      }

      const url = new URL(req.url, 'http://localhost');
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /api/notes') {
        return json(res, 200, { notes: await vault.list(), vault: vault.root });
      }

      if (route === 'GET /api/note') {
        const rel = url.searchParams.get('path');
        try {
          return json(res, 200, await vault.read(rel));
        } catch (err) {
          if (err.code === 'ENOENT') return json(res, 404, { error: 'no such note' });
          throw err;
        }
      }

      if (route === 'PUT /api/note') {
        const rel = url.searchParams.get('path');
        const body = await readJson(req);
        if (typeof body?.content !== 'string') {
          return json(res, 400, { error: 'content required' });
        }
        const result = await vault.write(rel, body.content, body.baseHash);
        return json(res, result.conflict ? 409 : 200, result);
      }

      if (req.method === 'GET') return serveStatic(res, url.pathname);
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof BadPath) return json(res, 400, { error: err.message });
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.end();
    }
  });

  await new Promise((r) => server.listen(port, host, r));
  boundPort = server.address().port;

  return {
    port: boundPort,
    allowed: [...allowed],
    vault,
    url: `http://localhost:${boundPort}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const abs = path.join(WEB, rel);
  if (!abs.startsWith(WEB + path.sep)) return json(res, 400, { error: 'bad path' });
  try {
    const buf = await fs.readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] ?? 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}
