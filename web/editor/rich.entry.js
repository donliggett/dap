/**
 * The rich engine — Tiptap, bundled.
 *
 * This file is NOT loaded by the browser directly. `npm run bundle` compiles it
 * and everything it imports into `web/vendor/rich.js`, which is committed. That
 * keeps two promises at once: users clone and run with no build step, and the
 * app stays offline — nothing is fetched from a CDN at runtime.
 *
 * Regenerate the bundle only when the editor dependencies change.
 *
 * Everything below satisfies the same interface as the plain engine. Nothing
 * outside this file may know Tiptap exists.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import { Markdown } from 'tiptap-markdown';

export function createRichEditor() {
  let editor = null;
  let listeners = [];
  let suppress = false;

  return {
    capabilities: ['bold', 'italic', 'strike', 'heading', 'bulletList', 'link', 'table', 'clear', 'image'],

    mount(node) {
      node.replaceChildren();
      editor = new Editor({
        element: node,
        extensions: [
          StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
          Link.configure({ openOnClick: false }),
          // allowBase64 is off deliberately. An inlined data: URL would put
          // megabytes of base64 into a note that is supposed to stay readable
          // in any editor, and would defeat the point of attachments living in
          // a folder you can open.
          Image.configure({ inline: false, allowBase64: false }),
          Table.configure({ resizable: false }),
          TableRow,
          TableHeader,
          TableCell,
          Markdown.configure({
            // Fidelity settings. These are the knobs that decide whether opening
            // and saving an untouched note produces a diff — see the round-trip
            // test, which is the thing that will tell us if they're wrong.
            html: false,
            tightLists: true,
            bulletListMarker: '-',
            linkify: false,
            breaks: false,
            transformPastedText: true,
            transformCopiedText: true,
          }),
        ],
        /**
         * data-editor goes on the contenteditable Tiptap creates, NOT on the
         * host — otherwise two elements match the selector, querySelector
         * returns the wrong one, and every interaction lands on a div that
         * isn't editable. Tiptap owns this element completely; the app finds
         * it by this attribute and never reaches inside.
         */
        editorProps: { attributes: { class: 'note', 'data-editor': '' } },
        onUpdate: () => {
          if (suppress) return;
          for (const fn of listeners) fn();
        },
      });
      return this;
    },

    getMarkdown() {
      if (!editor) return '';
      const md = editor.storage.markdown.getMarkdown();
      return md.endsWith('\n') ? md : md + '\n';
    },

    setMarkdown(md) {
      if (!editor) return;
      if (this.getMarkdown() === md) return;
      // emitUpdate:false — replacing the document is not a user edit, and
      // treating it as one would mark the note dirty the instant it opened and
      // save it straight back, which is how a serializer quietly rewrites every
      // file you look at.
      suppress = true;
      editor.commands.setContent(md, false);
      suppress = false;
    },

    onChange(fn) {
      listeners.push(fn);
      return () => { listeners = listeners.filter((f) => f !== fn); };
    },

    can(cmd) { return this.capabilities.includes(cmd); },

    isActive(cmd) {
      if (!editor) return false;
      switch (cmd) {
        case 'heading': return editor.isActive('heading');
        case 'bulletList': return editor.isActive('bulletList');
        case 'table': return editor.isActive('table');
        case 'clear': return false;
        default: return editor.isActive(cmd);
      }
    },

    /** What the block-style button should read: P, H1, H2, H3. */
    blockLabel() {
      if (!editor) return 'P';
      for (const level of [1, 2, 3]) {
        if (editor.isActive('heading', { level })) return `H${level}`;
      }
      return 'P';
    },

    run(cmd) {
      if (!editor) return false;
      const chain = editor.chain().focus();
      switch (cmd) {
        case 'bold': return chain.toggleBold().run();
        case 'italic': return chain.toggleItalic().run();
        case 'strike': return chain.toggleStrike().run();
        case 'bulletList': return chain.toggleBulletList().run();
        case 'clear': return chain.unsetAllMarks().clearNodes().run();
        case 'heading': {
          // Cycle P -> H1 -> H2 -> H3 -> P. One button, no dropdown to build
          // yet; the dropdown can replace this without the app noticing.
          const level = [1, 2, 3].find((l) => editor.isActive('heading', { level: l }));
          if (!level) return chain.toggleHeading({ level: 1 }).run();
          if (level < 3) return chain.toggleHeading({ level: level + 1 }).run();
          return chain.setParagraph().run();
        }
        case 'link': {
          if (editor.isActive('link')) return chain.unsetLink().run();
          const url = globalThis.prompt?.('link to');
          if (!url) return false;
          return chain.setLink({ href: url }).run();
        }
        case 'table':
          return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
        default:
          return false;
      }
    },

    /** Fires whenever the selection moves, so the toolbar can restate itself. */
    onSelection(fn) {
      editor?.on('selectionUpdate', fn);
      editor?.on('transaction', fn);
    },

    focus() { editor?.commands.focus(); },

    destroy() {
      editor?.destroy();
      editor = null;
      listeners = [];
    },
  };
}
