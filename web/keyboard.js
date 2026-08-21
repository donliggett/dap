/**
 * Where the on-screen keyboard is, so nothing important hides behind it.
 *
 * On iOS the layout viewport does not shrink when the keyboard comes up. The
 * page is still told it is 844px tall while only about 500px of it can be seen,
 * so anything anchored to the bottom — the status bar, and more painfully the
 * search results — is rendered underneath the keys. `visualViewport` is the
 * only thing that knows the difference.
 *
 * The measurement lives in a pure function on purpose. There is no way to raise
 * a real keyboard in a headless browser, so if the arithmetic were tangled up
 * with the event listener it could only ever be tested by hand on a phone —
 * which is exactly how it would come to be wrong and stay wrong.
 */

/**
 * Pixels of the layout viewport currently covered from below.
 *
 * @param {object} v
 * @param {number} v.innerHeight  window.innerHeight (the layout viewport)
 * @param {number} v.height       visualViewport.height (what can be seen)
 * @param {number} v.offsetTop    visualViewport.offsetTop
 * @param {number} [v.scale]      visualViewport.scale
 */
export function keyboardInset({ innerHeight, height, offsetTop = 0, scale = 1 }) {
  if (!Number.isFinite(innerHeight) || !Number.isFinite(height)) return 0;

  // Pinch-zoom shrinks the visual viewport too, and that is not a keyboard.
  // Reflowing the page mid-zoom would fight the gesture.
  if (scale > 1.01) return 0;

  const covered = innerHeight - height - offsetTop;

  // Safari's collapsing address bar moves this by 50-90px as you scroll. A
  // keyboard is far bigger, and treating every toolbar twitch as one would
  // make the layout jump while reading.
  return covered >= MIN_KEYBOARD ? Math.round(covered) : 0;
}

/** Smaller than any real keyboard, larger than any browser chrome. */
export const MIN_KEYBOARD = 110;

/**
 * Publish the inset as `--kb` and `data-keyboard` on the root element, so the
 * layout can respond in CSS rather than through more JavaScript.
 *
 * Returns a function that stops tracking.
 */
export function trackKeyboard({
  root = document.documentElement,
  viewport = globalThis.visualViewport,
  win = globalThis,
} = {}) {
  const apply = () => {
    const px = viewport
      ? keyboardInset({
          innerHeight: win.innerHeight,
          height: viewport.height,
          offsetTop: viewport.offsetTop,
          scale: viewport.scale,
        })
      : 0;
    root.style.setProperty('--kb', `${px}px`);
    root.dataset.keyboard = px > 0 ? 'up' : 'down';
  };

  apply();
  if (!viewport) return () => {};

  // scroll matters as much as resize: iOS shifts the visual viewport rather
  // than resizing it when the focused field is already near the bottom.
  viewport.addEventListener('resize', apply);
  viewport.addEventListener('scroll', apply);
  return () => {
    viewport.removeEventListener('resize', apply);
    viewport.removeEventListener('scroll', apply);
  };
}
