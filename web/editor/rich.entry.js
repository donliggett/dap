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
import { isSafeHref } from '../links.js';

export function createRichEditor() {
  let editor = null;
  let listeners = [];
  let suppress = false;

  return {
    capabilities: ['bold', 'italic', 'strike', 'heading', 'bulletList', 'link', 'table', 'clear', 'image'],

    /**
     * Distinct from the 'image' capability on purpose. That one says "an image
     * can be inserted"; this says "an image is drawn on screen", which is what
     * decides whether hrefs need swapping for URLs the browser can load. Both
     * engines can accept an image; only this one displays it.
     */
    rendersImages: true,

    mount(node) {
      node.replaceChildren();
      editor = new Editor({
        element: node,
        extensions: [
          StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
          // Narrowing, not a fix — worth being precise about. Tiptap already
          // refuses `javascript:` on its own; verified by testing a note
          // containing one against a bundle built without this config, with a
          // safe link beside it as a control so the test could actually fail.
          // What this adds is the narrower set: Tiptap's default also permits
          // ftp and friends, and dap has no reason to. openOnClick keeps a
          // stray click from navigating.
          Link.configure({
            openOnClick: false,
            protocols: ['http', 'https', 'mailto'],
            validate: (href) => isSafeHref(href),
          }),
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

    /**
     * Put an image into the document.
     *
     * `at` is a pair of client coordinates, which is what a drop event gives
     * you. Dropping an image at the bottom of a note and watching it appear at
     * the top, where the caret happened to be, reads as broken — so a drop
     * lands where it was dropped, and everything else lands at the caret.
     */
    insertImage(src, { alt = '', at = null } = {}) {
      if (!editor) return false;
      const attrs = { src, alt };

      // Always an explicit position, never setImage().
      //
      // setImage() inserts at the current selection, and after inserting an
      // image the selection *is* that image — so a second insert replaced the
      // first rather than adding to it. Two images, one link. Using the end of
      // the selection puts the new one after whatever is selected instead of
      // on top of it.
      const dropped = at && editor.view.posAtCoords({ left: at.x, top: at.y });
      const pos = dropped ? dropped.pos : editor.state.selection.to;

      editor.chain().focus().insertContentAt(pos, { type: 'image', attrs }).run();
      return true;
    },

    /**
     * What the link button needs to know before it opens.
     *
     * `href` is what to prefill. Without it, editing an existing link is
     * impossible — the old prompt() could only ever add or remove one, so
     * fixing a typo in a URL meant unlinking and starting again.
     */
    linkState() {
      if (!editor) return { active: false, href: '', selected: false };
      return {
        active: editor.isActive('link'),
        href: editor.getAttributes('link').href ?? '',
        selected: !editor.state.selection.empty,
      };
    },

    /**
     * `extendMarkRange` is what makes editing work: with the cursor sitting
     * inside a link and nothing selected, it grows the selection to the whole
     * link, so the change lands on all of it rather than splitting it in two.
     */
    applyLink(href, { text = '' } = {}) {
      if (!editor || !isSafeHref(href)) return false;

      // Nothing selected and no link here: there is no text to attach the link
      // to, so write some. Doing nothing at all is how the old one felt broken.
      if (editor.state.selection.empty && !editor.isActive('link')) {
        return editor
          .chain()
          .focus()
          .insertContent({ type: 'text', text: text || href, marks: [{ type: 'link', attrs: { href } }] })
          .run();
      }

      return editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    },

    removeLink() {
      if (!editor) return false;
      return editor.chain().focus().extendMarkRange('link').unsetLink().run();
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
