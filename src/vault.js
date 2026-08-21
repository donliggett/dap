import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * A vault is a folder of files. That's the whole model.
 *
 * Everything here works in vault-relative paths with forward slashes, on every
 * platform, and nothing outside the vault root is ever read or written.
 */

const NOTE_EXTS = new Set(['.md', '.txt']);

export class Vault {
  constructor(root) {
    this.root = path.resolve(root);
  }

  /**
   * Vault-relative -> absolute, or throw.
   *
   * Containment is checked against the nearest ancestor that actually exists,
   * because the target often doesn't yet — you're creating it. Checking only the
   * immediate parent breaks the moment someone makes a note in a new folder.
   */
  async abs(rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new BadPath(rel);
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) {
      throw new BadPath(rel);
    }

    const abs = path.resolve(this.root, rel.split('/').join(path.sep));
    const realRoot = await fs.realpath(this.root);

    let probe = abs;
    for (let i = 0; i < 64; i++) {
      try {
        const real = await fs.realpath(probe);
        const rel2 = path.relative(realRoot, real);
        if (rel2.startsWith('..') || path.isAbsolute(rel2)) throw new BadPath(rel);
        return abs;
      } catch (err) {
        if (err instanceof BadPath) throw err;
        if (err.code !== 'ENOENT') throw err;
      }
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
    throw new BadPath(rel);
  }

  rel(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  /** Every note in the vault, newest first. */
  async list() {
    const out = [];
    const walk = async (dir) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (NOTE_EXTS.has(path.extname(e.name).toLowerCase())) {
          const st = await fs.stat(full).catch(() => null);
          if (st) out.push({ path: this.rel(full), mtime: Math.round(st.mtimeMs), size: st.size });
        }
      }
    };
    await walk(this.root);
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  async read(rel) {
    const buf = await fs.readFile(await this.abs(rel));
    return { path: rel, content: buf.toString('utf8'), hash: hash(buf) };
  }

  /**
   * Write, refusing to clobber.
   *
   * `baseHash` is what the caller last saw. If the file on disk no longer
   * matches it, someone else changed it and we say so instead of overwriting —
   * which is what makes it safe to keep a note open here and edit it elsewhere.
   */
  async write(rel, content, baseHash) {
    const abs = await this.abs(rel);
    let current = null;
    try {
      current = await fs.readFile(abs);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const currentHash = current ? hash(current) : null;
    if (baseHash !== undefined && baseHash !== currentHash) {
      return {
        ok: false,
        conflict: true,
        path: rel,
        hash: currentHash,
        content: current ? current.toString('utf8') : null,
      };
    }

    const buf = Buffer.from(content, 'utf8');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
    return { ok: true, path: rel, hash: hash(buf) };
  }
}

export const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export class BadPath extends Error {
  constructor(p) {
    super(`path not allowed: ${p}`);
    this.name = 'BadPath';
    this.status = 400;
  }
}
