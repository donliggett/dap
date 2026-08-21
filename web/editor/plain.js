/**
 * The plain-text engine — the floor everything falls back to.
 *
 * It satisfies the same interface as the rich engine but formats nothing, so
 * the toolbar dims itself. It exists so that a missing, broken, or
 * still-loading rich engine costs you formatting, never your notes.
 *
 * It's a textarea rather than a contenteditable, and that is not a style
 * preference. A contenteditable holding plain text loses its line structure:
 * `innerText` collapses newlines that were never real block elements, so a
 * single edit rewrote an entire multi-line note onto one line. A textarea's
 * value is exactly the text, which is the whole job here.
 *
 * Nothing outside this file knows what engine is underneath. The app calls
 * methods and subscribes to changes; it never hands the editor state to hold
 * and never reaches inside.
 */

import { isSafeHref } from '../links.js';

export function createPlainEditor() {
  let el = null;
  let listeners = [];
  let suppress = false;

  const emit = () => {
    if (suppress) return;
    for (const fn of listeners) fn();
  };

  return {
    /** Commands this engine supports. The toolbar dims anything absent. */
    capabilities: ['image', 'link'],

    /** A textarea shows the markdown; it never draws the picture. */
    rendersImages: false,

    mount(node) {
      el = document.createElement('textarea');
      el.className = 'note note-plain';
      el.setAttribute('data-editor', '');
      el.setAttribute('aria-label', 'Note');
      el.spellcheck = true;
      el.autocapitalize = 'sentences';
      el.addEventListener('input', emit);
      // Append into the host rather than replacing it. Both engines mount the
      // same way, and exactly one element ends up carrying data-editor — the
      // one you can actually type in.
      node.replaceChildren(el);
      return this;
    },

    getMarkdown() {
      if (!el) return '';
      const text = el.value.replace(/\r\n/g, '\n');
      return text.endsWith('\n') || text === '' ? text : text + '\n';
    },

    setMarkdown(md) {
      if (!el) return;
      if (el.value === md) return;
      suppress = true;
      el.value = md;
      suppress = false;
    },

    /**
     * The plain engine writes the markdown itself, because that is all it has.
     *
     * `at` is ignored: a textarea has no notion of a position under the mouse,
     * and guessing one from coordinates would be worse than the honest answer
     * of "where your cursor already is".
     */
    insertImage(src, { alt = '' } = {}) {
      if (!el) return false;
      const snippet = `![${alt}](${src})`;
      const { selectionStart: from, selectionEnd: to, value } = el;
      el.value = value.slice(0, from) + snippet + value.slice(to);
      el.selectionStart = el.selectionEnd = from + snippet.length;
      emit();
      return true;
    },

    /**
     * The plain engine has no marks, only text, so a link is the markdown for
     * one. It can never report an existing link: finding the `[text](href)` the
     * cursor happens to be inside would mean parsing markdown in a textarea,
     * and the person can already see and edit it directly, which is the whole
     * point of this engine.
     */
    linkState() {
      if (!el) return { active: false, href: '', selected: false };
      return { active: false, href: '', selected: el.selectionStart !== el.selectionEnd };
    },

    applyLink(href, { text = '' } = {}) {
      if (!el || !isSafeHref(href)) return false;
      const { selectionStart: from, selectionEnd: to, value } = el;
      const label = value.slice(from, to) || text || href;
      const snippet = `[${label}](${href})`;

      el.value = value.slice(0, from) + snippet + value.slice(to);
      el.selectionStart = el.selectionEnd = from + snippet.length;
      emit();
      return true;
    },

    /** Nothing to remove: there is no mark, only the text you can see. */
    removeLink() { return false; },

    onChange(fn) {
      listeners.push(fn);
      return () => { listeners = listeners.filter((f) => f !== fn); };
    },

    can() { return false; },
    run() { return false; },
    isActive() { return false; },

    focus() { el?.focus(); },

    destroy() {
      el?.removeEventListener('input', emit);
      listeners = [];
      el = null;
    },
  };
}
