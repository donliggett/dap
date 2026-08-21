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
    capabilities: [],

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
