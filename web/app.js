import { createEditor } from './editor/index.js';
import { splitFrontmatter, joinFrontmatter } from './frontmatter.js';
import { slugForFilename } from './naming.js';
import { createSearch } from './search.js';
import { trackKeyboard } from './keyboard.js';
import { toBrowser, toDisk } from './attach-rewrite.js';
import { uploadImage, imagesFrom, altFor } from './attach-client.js';
import { hrefFor } from './attach-path.js';

const $ = (sel) => document.querySelector(sel);
const shell = $('.shell');

const els = {
  list: $('[data-note-list]'),
  count: $('[data-note-count]'),
  docName: $('[data-doc-name]'),
  nameInput: $('[data-name-input]'),
  newBtn: $('[data-new-btn]'),
  confirmBtn: $('[data-confirm]'),
  statusPath: $('[data-status-path]'),
  saveDot: $('[data-save-dot]'),
  saveText: $('[data-save-text]'),
  words: $('[data-word-count]'),
  conflictBar: $('[data-conflict-bar]'),
  deleteBtn: $('[data-delete-btn]'),
  undoBtn: $('[data-undo]'),
  confirmDialog: $('[data-confirm-delete]'),
  confirmName: $('[data-confirm-name]'),
  settings: $('[data-settings]'),
  aboutVault: $('[data-about-vault]'),
  aboutNotes: $('[data-about-notes]'),
  aboutVersion: $('[data-about-version]'),
  trashSummary: $('[data-trash-summary]'),
  trashRestore: $('[data-trash-restore]'),
  imageInput: $('[data-image-input]'),
  notice: $('[data-notice]'),
  editorHost: $('[data-editor-host]'),
  empty: $('[data-empty-state]'),
  emptyPath: $('[data-empty-path]'),
  source: $('[data-source]'),
};

const state = {
  notes: [],
  path: null,
  baseHash: null,
  dirty: false,
  // Carried verbatim from open to save. The editor never sees it.
  front: '',
  // { theirs, hash } while the file on disk has moved out from under us.
  conflict: null,
  // { trashed, path } while a delete can still be taken back.
  undo: null,
};

const { engine, editor: engineImpl, reason } = await createEditor();
const editor = engineImpl.mount(els.editorHost);
document.body.dataset.engine = engine;
if (reason) console.info(`dap: using the plain editor — ${reason}`);

// Whichever engine mounted, its editable is the single [data-editor].
els.editor = document.querySelector('[data-editor]');

/**
 * The editor never sees a disk path, and the disk never sees a browser URL.
 *
 * `../attachments/x.png` is meaningless to an <img> served from `/`, so image
 * sources are swapped on the way in and swapped back on the way out. Every
 * read and write of the editor goes through this pair — one that skips the
 * conversion is the asymmetry that rewrites notes on open.
 *
 * The plain engine is exempt on purpose. It shows raw markdown in a textarea,
 * where an image cannot render anyway and a `/api/file?path=` URL would just be
 * noise in the middle of the source someone came there to read.
 *
 * Keyed on `rendersImages`, not on the 'image' capability. Both engines can
 * *insert* an image; only one *draws* it, and it is the drawing that needs a
 * URL. Reusing one flag for both questions is the same mistake as reusing a
 * data attribute for a state and a hook, which cost three bugs in this build.
 */
const rendersImages = editor.rendersImages === true;
const readEditor = () =>
  rendersImages ? toDisk(state.path ?? '', editor.getMarkdown()) : editor.getMarkdown();
const writeEditor = (md) =>
  editor.setMarkdown(rendersImages ? toBrowser(state.path ?? '', md) : md);

// ── api ────────────────────────────────────────────────────────────────
const api = {
  list: () => fetch('/api/notes').then((r) => r.json()),
  read: (path) => fetch(`/api/note?path=${encodeURIComponent(path)}`).then((r) => r.json()),
  write: (path, content, baseHash) =>
    fetch(`/api/note?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, baseHash }),
    }).then(async (r) => ({ status: r.status, body: await r.json() })),
  remove: (path) =>
    fetch(`/api/note?path=${encodeURIComponent(path)}`, { method: 'DELETE' }).then((r) => r.json()),
  restore: (trashed, path) =>
    fetch('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed, path }),
    }).then((r) => r.json()),
  about: () => fetch('/api/about').then((r) => r.json()),
  restoreTrash: () => fetch('/api/trash/restore', { method: 'POST' }).then((r) => r.json()),
};

// ── saving ─────────────────────────────────────────────────────────────
let idle = null;
let ceiling = null;

/**
 * Debounced while typing, with a ceiling so a long uninterrupted burst still
 * reaches disk. Nothing is ever held only in memory for more than two seconds.
 */
function scheduleSave() {
  state.dirty = true;
  // Once the file has moved on disk, every save is a 409 we already know the
  // answer to. Keep the edit, keep the bar up, stop asking.
  if (state.conflict) {
    setSaveState('conflict');
    return;
  }
  setSaveState('editing');
  clearTimeout(idle);
  idle = setTimeout(save, 500);
  if (!ceiling) ceiling = setTimeout(save, 2000);
}

async function save() {
  clearTimeout(idle);
  clearTimeout(ceiling);
  idle = ceiling = null;
  if (!state.path || !state.dirty || state.conflict) return;

  const content = joinFrontmatter(state.front, readEditor());
  setSaveState('saving');

  const { status, body } = await api.write(state.path, content, state.baseHash);

  if (status === 409) {
    enterConflict(body);
    return;
  }
  state.baseHash = body.hash;
  state.dirty = false;
  setSaveState('saved');
  refreshList();
}

// ── the file changed underneath us ─────────────────────────────────────
/**
 * The server hands back what is actually on disk along with the 409, so by the
 * time this runs we already hold both versions and nothing has been lost. All
 * that is left is to say so and let someone choose — which is the part the
 * previous build never did, leaving "changed on disk" in the status bar as a
 * dead end while the edit sat in a tab waiting to be closed.
 */
function enterConflict(body) {
  clearTimeout(idle);
  clearTimeout(ceiling);
  idle = ceiling = null;
  state.conflict = { theirs: body.content ?? '', hash: body.hash };
  shell.dataset.conflict = 'true';
  setSaveState('conflict');
}

function leaveConflict() {
  state.conflict = null;
  shell.dataset.conflict = 'false';
  els.conflictBar.classList.remove('is-urgent');
}

/** Mine wins. Write over disk, this time saying which version I saw. */
async function keepMine() {
  if (!state.conflict) return;
  const content = joinFrontmatter(state.front, readEditor());
  const { status, body } = await api.write(state.path, content, state.conflict.hash);
  if (status === 409) {
    // It moved again between the 409 and the click. Still nothing lost.
    state.conflict = { theirs: body.content ?? '', hash: body.hash };
    return;
  }
  state.baseHash = body.hash;
  state.dirty = false;
  leaveConflict();
  setSaveState('saved');
  refreshList();
}

/** Disk wins. My edit goes away, but only because I said so. */
function takeTheirs() {
  if (!state.conflict) return;
  const { theirs, hash } = state.conflict;
  const { front, body } = splitFrontmatter(theirs);
  state.front = front;
  writeEditor(body);
  state.baseHash = hash;
  state.dirty = false;
  els.source.textContent = theirs;
  leaveConflict();
  updateWords();
  setSaveState('ready');
}

/**
 * Nobody wins and nobody loses: my version lands beside the note under a free
 * name and the note itself goes back to what is on disk. Same instinct as
 * never refusing a duplicate filename — walking to a free name beats making
 * someone pick which version to destroy while they are already annoyed.
 */
async function saveMineAsCopy() {
  if (!state.conflict) return;
  const mine = joinFrontmatter(state.front, readEditor());
  const stem = state.path.replace(/\.md$/i, '');
  const taken = new Set(state.notes.map((n) => n.path.toLowerCase()));

  let copy = `${stem} (conflict).md`;
  for (let n = 2; taken.has(copy.toLowerCase()); n++) copy = `${stem} (conflict ${n}).md`;

  await api.write(copy, mine, null);
  takeTheirs();
  refreshList();
}

function applyPath(path) {
  state.path = path;
  els.docName.textContent = path ?? '';
  els.statusPath.textContent = path ?? '';
  els.deleteBtn.disabled = !path;
}

// ── delete ─────────────────────────────────────────────────────────────
/**
 * Delete asks first.
 *
 * I argued against this: the file only moves to `.trash/`, an undo is offered,
 * and a dialog you see every time is a dialog you learn to dismiss. All true,
 * and all beside the point once it was actually used — a note vanishing from
 * one tap, with the only acknowledgement being 11px of status bar, reads as
 * having lost something whether or not it is recoverable. Confidence about the
 * file surviving is not the same as confidence about what just happened.
 *
 * So: a real dialog, naming the note, with cancel holding focus. The undo and
 * the trash folder both stay — this is a third net, not a replacement.
 */
let undoTimer = null;

function askDelete() {
  if (!state.path || naming) return;
  if (state.conflict) return nudgeConflict();
  els.confirmName.textContent = state.path;
  els.confirmDialog.showModal();
}

async function deleteCurrent() {
  if (!state.path || naming) return;
  if (state.conflict) return nudgeConflict();

  // Belt and braces, and labelled as such. Today nothing escapes anyway —
  // opening the next note clears the dirty flag before the debounce fires, and
  // deleting the last one leaves state.path null, so save() bails either way. I
  // could not write a test that fails without these four lines. They stay
  // because a timer still holding the intent to save a note that is being
  // deleted is only safe by coincidence of ordering elsewhere.
  clearTimeout(idle);
  clearTimeout(ceiling);
  idle = ceiling = null;
  state.dirty = false;

  const result = await api.remove(state.path);
  if (!result.ok) return;

  offerUndo(result);
  applyPath(null);
  state.baseHash = null;

  await refreshList();
  if (state.notes.length) await open(state.notes[0].path);
  else {
    writeEditor('');
    state.front = '';
    els.source.textContent = '';
    updateWords();
  }
}

function offerUndo({ trashed, path }) {
  state.undo = { trashed, path };
  els.undoBtn.hidden = false;
  els.saveText.textContent = `moved ${path} to trash`;
  clearTimeout(undoTimer);
  // Long enough to notice the mistake, short enough that the button does not
  // become permanent furniture. The real safety net is the folder on disk.
  undoTimer = setTimeout(clearUndo, 12000);
}

function clearUndo() {
  clearTimeout(undoTimer);
  state.undo = null;
  els.undoBtn.hidden = true;
}

async function undoDelete() {
  const pending = state.undo;
  if (!pending) return;
  clearUndo();

  const result = await api.restore(pending.trashed, pending.path);
  if (!result.ok) return;

  await refreshList();
  await open(result.path);
}

els.deleteBtn.addEventListener('click', askDelete);
els.undoBtn.addEventListener('click', undoDelete);

// Escape and the backdrop both close with an empty returnValue, so anything
// other than the delete button walking away means "no".
els.confirmDialog.addEventListener('close', () => {
  if (els.confirmDialog.returnValue === 'delete') deleteCurrent();
  els.confirmDialog.returnValue = '';
});

// Clicking the dimmed area outside the box is a cancel, the way every other
// overlay in dap behaves. <dialog> reports those clicks as landing on itself.
els.confirmDialog.addEventListener('click', (e) => {
  if (e.target === els.confirmDialog) els.confirmDialog.close('cancel');
});

function setSaveState(kind) {
  const text = {
    editing: 'editing', saving: 'saving…', saved: 'saved',
    conflict: 'changed on disk', ready: 'ready', naming: 'naming…',
  }[kind];
  els.saveText.textContent = text;
  const bad = kind === 'conflict';
  els.saveDot.style.background =
    bad ? 'var(--danger)' : kind === 'saved' || kind === 'ready' ? 'var(--accent-lit)' : 'var(--ink-faint)';
}

// ── notes ──────────────────────────────────────────────────────────────
async function refreshList() {
  const { notes, vault } = await api.list();
  state.notes = notes;
  els.count.textContent = String(notes.length);
  shell.dataset.empty = notes.length ? 'false' : 'true';
  els.empty.hidden = notes.length > 0;
  if (vault) els.emptyPath.textContent = vault;
  els.list.replaceChildren(
    ...notes.map((n) => {
      const b = document.createElement('button');
      b.className = 'note-item';
      b.type = 'button';
      if (n.path === state.path) b.setAttribute('aria-current', 'true');
      const t = document.createElement('span');
      t.className = 'n-title';
      t.textContent = n.path.replace(/\.md$/, '').split('/').pop();
      const m = document.createElement('span');
      m.className = 'n-meta';
      m.textContent = `${n.path.includes('/') ? n.path.split('/')[0] : 'root'} · ${ago(n.mtime)}`;
      b.append(t, m);
      b.addEventListener('click', () => open(n.path));
      return b;
    }),
  );
}

async function open(path) {
  // Walking away from a conflicted note would strand the edit in a closed tab.
  // One click resolves it; refusing until then beats a silent discard.
  if (state.conflict) return nudgeConflict();
  if (state.dirty) await save();
  const note = await api.read(path);
  state.path = note.path;
  state.baseHash = note.hash;
  state.dirty = false;

  const { front, body } = splitFrontmatter(note.content);
  state.front = front;
  writeEditor(body);
  els.source.textContent = note.content;
  applyPath(note.path);
  updateWords();
  setSaveState('ready');
  shell.dataset.drawer = 'closed';
  refreshList();
  editor.focus();
}

function updateWords() {
  const n = readEditor().trim().split(/\s+/).filter(Boolean).length;
  els.words.textContent = `${n} word${n === 1 ? '' : 's'}`;
}

const ago = (ms) => {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
};

// ── wiring ─────────────────────────────────────────────────────────────
editor.onChange(() => {
  updateWords();
  els.source.textContent = joinFrontmatter(state.front, readEditor());
  refreshToolbar();
  scheduleSave();
});

/**
 * The toolbar reflects what the engine says it can do — nothing is hard-coded
 * against a particular editor. A button whose command isn't in `capabilities`
 * dims and says why, rather than sitting there looking functional.
 */
const toolButtons = [...document.querySelectorAll('.tool[data-cmd]')];
const blockLabel = $('[data-block-label]');

for (const btn of toolButtons) {
  const cmd = btn.dataset.cmd;
  if (cmd === 'image') {
    // Not an editor command: it opens a file picker, and the engine only gets
    // involved once there are bytes to insert. Still gated on the capability,
    // so an engine that cannot take an image says so rather than throwing.
    const canAttach = editor.capabilities.includes('image');
    btn.disabled = !canAttach;
    btn.classList.toggle('is-unavailable', !canAttach);
    if (canAttach) btn.addEventListener('click', () => els.imageInput.click());
    continue;
  }
  const supported = editor.capabilities.includes(cmd);
  btn.disabled = !supported;
  btn.classList.toggle('is-unavailable', !supported);
  btn.title = supported ? '' : 'not available with the plain editor';
  if (supported) {
    btn.addEventListener('click', () => {
      editor.run(cmd);
      editor.focus();
      refreshToolbar();
    });
  }
}

function refreshToolbar() {
  for (const btn of toolButtons) {
    if (btn.disabled) continue;
    // Image is an action, not a toggle. isActive('image') is true whenever an
    // image happens to be selected, which lit the button up and made it look
    // like pressing it again would take the picture out.
    if (btn.dataset.cmd === 'image') continue;
    btn.setAttribute('aria-pressed', String(editor.isActive(btn.dataset.cmd)));
  }
  if (blockLabel && editor.blockLabel) blockLabel.textContent = editor.blockLabel();
}

editor.onSelection?.(refreshToolbar);
refreshToolbar();

const modeBtns = [...document.querySelectorAll('[data-mode-btn]')];
for (const b of modeBtns) {
  b.addEventListener('click', () => {
    shell.dataset.mode = b.dataset.modeBtn;
    for (const o of modeBtns) o.setAttribute('aria-pressed', String(o === b));
    if (b.dataset.modeBtn === 'source') {
      els.source.textContent = joinFrontmatter(state.front, readEditor());
    }
  });
}

$('[data-drawer-toggle]').addEventListener('click', () => {
  shell.dataset.drawer = shell.dataset.drawer === 'open' ? 'closed' : 'open';
});
for (const el of document.querySelectorAll('[data-drawer-close]')) {
  el.addEventListener('click', () => { shell.dataset.drawer = 'closed'; });
}

$('[data-theme-toggle]').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('dap.theme', next); } catch { /* private mode */ }
});

/**
 * Naming a note happens before it exists.
 *
 * The + turns the filename slot into a field and becomes a checkmark; whatever
 * you type is the name, and leaving the field commits it. Nothing is written
 * until then, so backing out leaves no stray `untitled.md` behind — which is
 * what forced a rename feature to exist in the first place.
 */
let naming = false;

function beginNaming() {
  if (naming) return;
  if (state.conflict) return nudgeConflict();
  naming = true;
  els.docName.hidden = true;
  els.nameInput.hidden = false;
  els.nameInput.value = '';
  els.newBtn.hidden = true;
  els.confirmBtn.hidden = false;
  setSaveState('naming');
  els.nameInput.focus();
}

function endNaming(commit) {
  // Confirming hides the field, and hiding it fires blur — which would run this
  // a second time. First call wins.
  if (!naming) return;
  naming = false;
  const typed = els.nameInput.value;
  els.nameInput.hidden = true;
  els.docName.hidden = false;
  els.confirmBtn.hidden = true;
  els.newBtn.hidden = false;
  if (!commit) {
    setSaveState(state.path ? 'saved' : 'ready');
    return;
  }
  createNamed(typed);
}

async function createNamed(typed) {
  // Whatever was typed becomes a filename a filesystem will accept. An empty
  // field is not an error — it just means you hadn't decided yet.
  const base = slugForFilename(typed) || 'untitled';

  // Never refuse over a collision. There is no rename to recover with, so
  // walking to a free name is kinder than a dead end.
  const taken = new Set(state.notes.map((n) => n.path.toLowerCase()));
  let path = `${base}.md`;
  for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${base} ${n}.md`;

  await api.write(path, '', null);
  await refreshList();
  await open(path);
  editor.focus();
}

for (const b of document.querySelectorAll('[data-new]')) b.addEventListener('click', beginNaming);
els.confirmBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus so blur doesn't race the click
els.confirmBtn.addEventListener('click', () => endNaming(true));

els.nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); endNaming(true); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endNaming(false); }
});
els.nameInput.addEventListener('blur', () => endNaming(true));

// ── attaching images ───────────────────────────────────────────────────
/**
 * Three doors into the same corridor: the toolbar button, a paste, a drop.
 *
 * The button is not the nicest of the three and it is the one that matters
 * most, because it is the only one that exists on a phone — iOS turns an image
 * file input into a camera-and-library sheet for nothing.
 */
async function attachFiles(files, { at = null } = {}) {
  if (!state.path) return;
  const list = [...files];
  if (!list.length) return;

  let inserted = 0;
  let converted = 0;
  let failure = null;

  for (const [i, file] of list.entries()) {
    setSaveState('editing');
    els.saveText.textContent =
      list.length > 1 ? `adding image ${i + 1} of ${list.length}…` : 'adding image…';

    const result = await uploadImage(file);
    if (!result.ok) {
      // One bad file must not silently swallow the rest of a multi-select.
      failure = result.error;
      continue;
    }
    if (result.converted) converted += 1;

    // What gets inserted depends on who is going to read it back. The rich
    // engine holds browser URLs and `readEditor` converts them to paths on the
    // way out; the plain engine holds exactly what will be saved, so it needs
    // the relative path now. Handing the URL to both wrote `/api/file?path=`
    // straight into the file — found by running it, not by a test.
    const src = rendersImages ? result.url : hrefFor(state.path, result.path);

    // Only the first lands where it was dropped; the rest follow the caret,
    // which by then sits just after the one before it.
    editor.insertImage(src, { alt: altFor(file), at: i === 0 ? at : null });
    inserted += 1;
  }

  // A conversion the person did not ask for has to be said out loud, or it
  // reads as dap losing their file.
  if (converted) notify(converted === 1 ? 'svg converted to png' : `${converted} svgs converted to png`);
  if (failure) notify(failure);

  if (inserted) scheduleSave();
  else setSaveState(state.dirty ? 'editing' : 'ready');
}

/**
 * A sentence with a short life, kept out of the save state.
 *
 * Anything written into the save text is overwritten by the next save a second
 * later. That is correct for "saving…" and useless for "that file was
 * refused" — which is how the first version of this lost every error it
 * produced.
 */
let noticeTimer = null;
function notify(message) {
  els.notice.textContent = message;
  els.notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { els.notice.hidden = true; }, 8000);
}

els.imageInput.addEventListener('change', async () => {
  await attachFiles(els.imageInput.files);
  // Reset, or picking the same file twice in a row fires nothing the second
  // time — the value has not changed, so there is no change event.
  els.imageInput.value = '';
});

els.editorHost.addEventListener('paste', (e) => {
  const images = imagesFrom(e.clipboardData);
  if (!images.length) return;
  // Only now: letting the default run as well would paste the picture twice,
  // once as a file and once as whatever HTML flavour came with it.
  e.preventDefault();
  attachFiles(images);
});

/**
 * Drop lands where it was dropped.
 *
 * dragover has to be cancelled or the browser navigates away to the file, and
 * the counter exists because dragenter/dragleave fire for every child element
 * the pointer crosses — tracking a boolean makes the highlight flicker as you
 * move over the text.
 */
let dragDepth = 0;

els.editorHost.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

els.editorHost.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth += 1;
  shell.dataset.dropping = 'true';
});

els.editorHost.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) shell.dataset.dropping = 'false';
});

els.editorHost.addEventListener('drop', (e) => {
  const images = imagesFrom(e.dataTransfer);
  dragDepth = 0;
  shell.dataset.dropping = 'false';
  if (!images.length) return;
  e.preventDefault();
  attachFiles(images, { at: { x: e.clientX, y: e.clientY } });
});

// ── settings ───────────────────────────────────────────────────────────
/**
 * Everything the panel shows is read from the server when it opens, never
 * cached in the page. The version, the note count and the trash count all go
 * stale the moment anything happens, and a settings panel quietly showing
 * yesterday's numbers is worse than one that shows none.
 */
async function openSettings() {
  shell.dataset.drawer = 'closed';
  els.settings.showModal();
  await refreshSettings();
}

async function refreshSettings() {
  const about = await api.about();
  els.aboutVault.textContent = about.vault;
  els.aboutNotes.textContent = String(about.notes);
  els.aboutVersion.textContent = about.version;
  paintTrash(about.trash);
}

function paintTrash(count) {
  els.trashRestore.disabled = count === 0;
  els.trashSummary.textContent =
    count === 0
      ? 'nothing deleted yet. deleted notes move to a .trash folder inside your notes folder.'
      : `${count} deleted note${count === 1 ? '' : 's'} waiting in .trash, inside your notes folder.`;
}

/**
 * Put everything back at once.
 *
 * Nothing is overwritten doing it: a note whose name was taken since the
 * delete comes back as "note 2.md", the same walk-to-a-free-name that stops
 * two untitled notes colliding. Restoring can add files; it can never replace
 * one.
 */
async function restoreTrash() {
  els.trashRestore.disabled = true;
  els.trashSummary.textContent = 'restoring…';

  const result = await api.restoreTrash();
  const n = result.restored?.length ?? 0;

  await refreshList();
  clearUndo();
  await refreshSettings();

  const failed = result.failed?.length ?? 0;
  els.trashSummary.textContent =
    `restored ${n} note${n === 1 ? '' : 's'}` +
    (failed ? ` — ${failed} could not be read and are still in .trash.` : '.');

  // Nothing was open before if the vault was empty; show what just came back.
  if (!state.path && state.notes.length) await open(state.notes[0].path);
}

$('[data-open-settings]').addEventListener('click', openSettings);
$('[data-settings-close]').addEventListener('click', () => els.settings.close());
els.trashRestore.addEventListener('click', restoreTrash);
// Clicking the dimmed area closes it. Testing the coordinates rather than just
// the event target matters here: full screen on a phone, the dialog's own
// safe-area padding *is* the element, so a tap near the notch would otherwise
// count as "outside" and shut the panel.
els.settings.addEventListener('click', (e) => {
  if (e.target !== els.settings) return;
  const r = els.settings.getBoundingClientRect();
  const outside =
    e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if (outside) els.settings.close();
});

/** Say no visibly rather than doing nothing, which reads as a broken click. */
function nudgeConflict() {
  els.conflictBar.classList.remove('is-urgent');
  void els.conflictBar.offsetWidth; // restart the animation
  els.conflictBar.classList.add('is-urgent');
}

$('[data-conflict-keep]').addEventListener('click', keepMine);
$('[data-conflict-theirs]').addEventListener('click', takeTheirs);
$('[data-conflict-copy]').addEventListener('click', saveMineAsCopy);

const search = createSearch({
  root: $('[data-search]'),
  onOpen: (path) => open(path),
});
$('[data-open-search]').addEventListener('click', () => {
  shell.dataset.drawer = 'closed';
  search.open();
});

addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    e.stopPropagation();
    search.open();
    return;
  }
  if (e.key === 'Escape' && !search.isOpen) shell.dataset.drawer = 'closed';
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
}, true);

// Never leave an edit stranded in memory.
addEventListener('beforeunload', () => { if (state.dirty) save(); });

// ── boot ───────────────────────────────────────────────────────────────
try {
  const saved = localStorage.getItem('dap.theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* private mode */ }

shell.dataset.conflict = 'false';
trackKeyboard();
await refreshList();
if (state.notes.length) await open(state.notes[0].path);
else setSaveState('ready');
document.body.dataset.ready = 'true';
