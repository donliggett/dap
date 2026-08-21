/**
 * The search overlay.
 *
 * Imperative and self-contained: it owns its own DOM, exposes open/close, and
 * tells the app which note to open through one callback. Nothing else reaches
 * into it.
 *
 * Deliberately one field rather than the prefix-modes pattern (`>` commands,
 * `#` tags). The nav promises one thing, so this does one thing; prefixes can
 * come back when there is something to prefix.
 */

const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
};

export function createSearch({ root, onOpen }) {
  const input = root.querySelector('[data-search-input]');
  const list = root.querySelector('[data-search-results]');
  const status = root.querySelector('[data-search-status]');

  let results = [];
  let selected = 0;
  let seq = 0;
  let debounce = null;

  function show(open) {
    root.hidden = !open;
    if (open) {
      input.value = '';
      results = [];
      render();
      input.focus();
    }
  }

  /**
   * Every query carries a sequence number and stale replies are dropped.
   *
   * Typing fast puts several requests in flight and they do not come back in
   * order — a slow "b" can land after a fast "budget" and repaint the older
   * results over the newer ones. Debouncing alone only makes that rarer.
   */
  function query(text) {
    const q = text.trim();
    clearTimeout(debounce);

    if (!q) {
      results = [];
      seq++;
      render();
      return;
    }

    status.textContent = 'searching…';
    debounce = setTimeout(async () => {
      const mine = ++seq;
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const body = await res.json();
        if (mine !== seq) return;
        results = body.results ?? [];
        selected = 0;
        render(body.terms ?? []);
      } catch {
        if (mine === seq) {
          results = [];
          render();
        }
      }
    }, 140);
  }

  function render(terms = []) {
    list.replaceChildren();

    if (!results.length) {
      status.textContent = input.value.trim() ? 'nothing found' : '';
      return;
    }
    status.textContent = `${results.length} note${results.length === 1 ? '' : 's'}`;

    results.forEach((hit, i) => {
      const row = el('button', 'search-row');
      row.type = 'button';
      row.setAttribute('role', 'option');
      if (i === selected) {
        row.classList.add('on');
        row.setAttribute('aria-selected', 'true');
      }
      row.append(el('span', 'search-path', hit.path));
      if (hit.snippet) row.append(highlight(hit.snippet, terms));
      row.addEventListener('mousemove', () => {
        if (selected === i) return;
        selected = i;
        paint();
      });
      row.addEventListener('click', () => choose(i));
      list.append(row);
    });
  }

  /** Built as text nodes and elements, never innerHTML — note content is data. */
  function highlight(text, terms) {
    const wrap = el('span', 'search-snippet');
    if (!terms.length) {
      wrap.textContent = text;
      return wrap;
    }
    const lower = text.toLowerCase();
    let at = 0;

    while (at < text.length) {
      let next = null;
      for (const t of terms) {
        const i = lower.indexOf(t, at);
        if (i !== -1 && (!next || i < next.i)) next = { i, len: t.length };
      }
      if (!next) break;
      if (next.i > at) wrap.append(document.createTextNode(text.slice(at, next.i)));
      wrap.append(el('mark', null, text.slice(next.i, next.i + next.len)));
      at = next.i + next.len;
    }
    if (at < text.length) wrap.append(document.createTextNode(text.slice(at)));
    return wrap;
  }

  function paint() {
    [...list.children].forEach((row, i) => {
      row.classList.toggle('on', i === selected);
      row.setAttribute('aria-selected', String(i === selected));
    });
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
  }

  function move(delta) {
    if (!results.length) return;
    selected = (selected + delta + results.length) % results.length;
    paint();
  }

  function choose(i = selected) {
    const hit = results[i];
    if (!hit) return;
    show(false);
    onOpen(hit.path);
  }

  input.addEventListener('input', () => query(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); show(false); }
  });
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) show(false);
  });

  return {
    open: () => show(true),
    close: () => show(false),
    get isOpen() { return !root.hidden; },
  };
}
