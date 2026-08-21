import { createEditor } from './editor/index.js';
import { splitFrontmatter, joinFrontmatter } from './frontmatter.js';

const $ = (sel) => document.querySelector(sel);
const shell = $('.shell');

const els = {
  list: $('[data-note-list]'),
  count: $('[data-note-count]'),
  docName: $('[data-doc-name]'),
  statusPath: $('[data-status-path]'),
  saveDot: $('[data-save-dot]'),
  saveText: $('[data-save-text]'),
  words: $('[data-word-count]'),
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
};

const { engine, editor: engineImpl, reason } = await createEditor();
const editor = engineImpl.mount(els.editorHost);
document.body.dataset.engine = engine;
if (reason) console.info(`dap: using the plain editor — ${reason}`);

// Whichever engine mounted, its editable is the single [data-editor].
els.editor = document.querySelector('[data-editor]');

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
  setSaveState('editing');
  clearTimeout(idle);
  idle = setTimeout(save, 500);
  if (!ceiling) ceiling = setTimeout(save, 2000);
}

async function save() {
  clearTimeout(idle);
  clearTimeout(ceiling);
  idle = ceiling = null;
  if (!state.path || !state.dirty) return;

  const content = joinFrontmatter(state.front, editor.getMarkdown());
  setSaveState('saving');

  const { status, body } = await api.write(state.path, content, state.baseHash);

  if (status === 409) {
    setSaveState('conflict');
    return;
  }
  state.baseHash = body.hash;
  state.dirty = false;
  setSaveState('saved');
  refreshList();
}

function setSaveState(kind) {
  const text = { editing: 'editing', saving: 'saving…', saved: 'saved', conflict: 'changed on disk', ready: 'ready' }[kind];
  els.saveText.textContent = text;
  els.saveDot.style.background =
    kind === 'conflict' ? 'var(--danger)' : kind === 'saved' || kind === 'ready' ? 'var(--accent-lit)' : 'var(--ink-faint)';
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
  if (state.dirty) await save();
  const note = await api.read(path);
  state.path = note.path;
  state.baseHash = note.hash;
  state.dirty = false;

  const { front, body } = splitFrontmatter(note.content);
  state.front = front;
  editor.setMarkdown(body);
  els.source.textContent = note.content;
  els.docName.textContent = note.path;
  els.statusPath.textContent = note.path;
  updateWords();
  setSaveState('ready');
  shell.dataset.drawer = 'closed';
  refreshList();
  editor.focus();
}

function updateWords() {
  const n = editor.getMarkdown().trim().split(/\s+/).filter(Boolean).length;
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
  els.source.textContent = joinFrontmatter(state.front, editor.getMarkdown());
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
      els.source.textContent = joinFrontmatter(state.front, editor.getMarkdown());
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
 * New notes are created immediately rather than behind a prompt() — a modal is
 * a poor first interaction, and naming a note before writing it is backwards.
 * The name walks to the first free slot; renaming comes later.
 */
async function newNote() {
  const taken = new Set(state.notes.map((n) => n.path));
  let path = 'untitled.md';
  for (let n = 2; taken.has(path); n++) path = `untitled ${n}.md`;
  await api.write(path, '', null);
  await refreshList();
  await open(path);
  editor.focus();
}
for (const b of document.querySelectorAll('[data-new]')) b.addEventListener('click', newNote);

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') shell.dataset.drawer = 'closed';
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
}, true);

// Never leave an edit stranded in memory.
addEventListener('beforeunload', () => { if (state.dirty) save(); });

// ── boot ───────────────────────────────────────────────────────────────
try {
  const saved = localStorage.getItem('dap.theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* private mode */ }

await refreshList();
if (state.notes.length) await open(state.notes[0].path);
else setSaveState('ready');
document.body.dataset.ready = 'true';
