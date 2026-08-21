/**
 * The editing surface, behind a deliberately small interface.
 *
 * Nothing outside this file knows what engine is underneath. The app calls
 * methods and subscribes to changes; it never hands the editor reactive state
 * and never reaches into it. That boundary is the whole point — an editor owns
 * its own DOM and its own document model, and the moment something outside can
 * rebuild it from the outside you get an editor you cannot type in.
 *
 * Current implementation is plain text, which is enough to prove the save loop
 * end to end. Tiptap slots in here by satisfying the same interface:
 *
 *   mount(el)                 take over an element
 *   getMarkdown()             what should be written to disk
 *   setMarkdown(md)           replace the document
 *   onChange(fn)              fires on user edits only, never on setMarkdown
 *   can(cmd) / run(cmd)       toolbar support, advertised via capabilities
 *   focus() / destroy()
 */

export function createEditor() {
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
      el = node;
      el.contentEditable = 'true';
      el.spellcheck = true;
      el.setAttribute('role', 'textbox');
      el.setAttribute('aria-multiline', 'true');
      el.addEventListener('input', emit);
      return this;
    },

    getMarkdown() {
      if (!el) return '';
      // innerText preserves the line breaks contenteditable actually rendered,
      // which textContent does not.
      return el.innerText.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    },

    setMarkdown(md) {
      if (!el) return;
      if (this.getMarkdown() === md) return;
      suppress = true;
      el.textContent = md;
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
