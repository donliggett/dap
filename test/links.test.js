import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, isSafeHref, displayUrl } from '../web/links.js';

/**
 * No browser. This is the half of the link feature where being wrong is
 * expensive — an href becomes a live anchor inside a page holding a handle on
 * every note in the vault — and where being sure costs milliseconds.
 */

describe('what somebody typed', () => {
  test('a bare domain becomes https, because nobody types the scheme', () => {
    assert.deepEqual(normalizeUrl('example.com'), { ok: true, href: 'https://example.com' });
    assert.deepEqual(normalizeUrl('www.example.com'), { ok: true, href: 'https://www.example.com' });
    assert.deepEqual(normalizeUrl('example.com/path?q=1#top'), {
      ok: true,
      href: 'https://example.com/path?q=1#top',
    });
  });

  test('a real url is left exactly as it is', () => {
    for (const url of [
      'https://example.com',
      'http://example.com/x',
      'https://example.com/a%20b',
      'mailto:someone@example.com',
    ]) {
      assert.deepEqual(normalizeUrl(url), { ok: true, href: url }, url);
    }
  });

  test('an email address becomes a mailto', () => {
    assert.deepEqual(normalizeUrl('someone@example.com'), {
      ok: true,
      href: 'mailto:someone@example.com',
    });
  });

  test('whitespace around it does not count', () => {
    assert.deepEqual(normalizeUrl('  example.com  '), { ok: true, href: 'https://example.com' });
  });

  test('nothing is not a link', () => {
    assert.equal(normalizeUrl('').ok, false);
    assert.equal(normalizeUrl('   ').ok, false);
    assert.equal(normalizeUrl(undefined).ok, false);
  });

  /**
   * A bare word is a relative link to a file, not a website. Guessing
   * `https://notes` would be worse than saying no.
   */
  test('a bare word is not a domain', () => {
    assert.equal(normalizeUrl('notes').ok, false);
    assert.equal(normalizeUrl('some thing').ok, false);
  });

  test('relative links are kept as written', () => {
    for (const rel of ['/absolute', '#anchor', './sibling.md', '../up.md']) {
      assert.deepEqual(normalizeUrl(rel), { ok: true, href: rel }, rel);
    }
  });
});

describe('what must never become an anchor', () => {
  /**
   * The one with teeth. A note authored elsewhere can contain anything, and
   * this runs against notes from disk as well as against typed input.
   */
  test('script-bearing schemes are refused', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '  javascript:alert(1)',
      'java\tscript:alert(1)'.replace('\t', ''),
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://example.com/uuid',
      'file:///etc/passwd',
    ]) {
      assert.equal(normalizeUrl(bad).ok, false, `accepted ${bad}`);
      assert.equal(isSafeHref(bad), false, `called ${bad} safe`);
    }
  });

  test('the refusal says what is allowed', () => {
    assert.match(normalizeUrl('javascript:alert(1)').error, /http, https and mailto/);
  });

  test('an unfamiliar scheme is refused rather than guessed at', () => {
    assert.equal(normalizeUrl('ftp://example.com').ok, false);
    assert.equal(isSafeHref('ftp://example.com'), false);
  });

  test('safe things are still safe', () => {
    for (const good of [
      'https://example.com',
      'http://example.com',
      'mailto:a@b.co',
      'relative.md',
      '#anchor',
      '/rooted',
    ]) {
      assert.equal(isSafeHref(good), true, `refused ${good}`);
    }
  });

  test('nothing is not safe either', () => {
    assert.equal(isSafeHref(''), false);
    assert.equal(isSafeHref(null), false);
  });
});

describe('showing it back', () => {
  test('a mailto reads as the address someone typed', () => {
    assert.equal(displayUrl('mailto:someone@example.com'), 'someone@example.com');
  });

  test('everything else is shown as-is', () => {
    assert.equal(displayUrl('https://example.com'), 'https://example.com');
    assert.equal(displayUrl(''), '');
  });
});
