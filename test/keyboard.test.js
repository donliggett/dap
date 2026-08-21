import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { keyboardInset, MIN_KEYBOARD, trackKeyboard } from '../web/keyboard.js';

/**
 * No browser here on purpose.
 *
 * A headless Chromium cannot raise an iOS keyboard, so the only part of this
 * that a browser test could check is the part that was never in doubt. The
 * arithmetic is where the bugs live — off-by-a-toolbar, pinch-zoom mistaken for
 * a keyboard — and it is plain numbers in, plain number out.
 */

// An iPhone 14 in Safari, portrait.
const PHONE = { innerHeight: 844, height: 844, offsetTop: 0, scale: 1 };

describe('measuring the keyboard', () => {
  test('nothing covered when it is down', () => {
    assert.equal(keyboardInset(PHONE), 0);
  });

  test('reports the covered strip when it is up', () => {
    assert.equal(keyboardInset({ ...PHONE, height: 508 }), 336);
  });

  test('a collapsing address bar is not a keyboard', () => {
    // Safari's toolbar slides away as you scroll and takes ~60px with it.
    assert.equal(keyboardInset({ ...PHONE, height: 784 }), 0);
  });

  test('the threshold sits below any real keyboard', () => {
    assert.equal(keyboardInset({ ...PHONE, height: 844 - MIN_KEYBOARD }), MIN_KEYBOARD);
    assert.equal(keyboardInset({ ...PHONE, height: 844 - MIN_KEYBOARD + 1 }), 0);
  });

  test('pinch-zoom is left alone', () => {
    // Zooming shrinks the visual viewport too. Reflowing mid-gesture fights it.
    assert.equal(keyboardInset({ ...PHONE, height: 400, scale: 2.5 }), 0);
  });

  test('a shifted viewport counts as covered, not as extra room', () => {
    // iOS scrolls the visual viewport instead of resizing when the focused
    // field is already low on the screen.
    assert.equal(keyboardInset({ ...PHONE, height: 508, offsetTop: 120 }), 216);
  });

  test('never negative, whatever the browser reports', () => {
    assert.equal(keyboardInset({ ...PHONE, height: 1200 }), 0);
    assert.equal(keyboardInset({ innerHeight: NaN, height: 508 }), 0);
    assert.equal(keyboardInset({ innerHeight: 844, height: undefined }), 0);
  });
});

describe('publishing it to the page', () => {
  /** The smallest stand-ins that let the tracker run outside a browser. */
  function fakeRoot() {
    return { style: { props: {}, setProperty(k, v) { this.props[k] = v; } }, dataset: {} };
  }
  function fakeViewport(height) {
    return {
      height, offsetTop: 0, scale: 1, listeners: {},
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
      removeEventListener(type, fn) {
        this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
      },
      emit(type) { for (const fn of this.listeners[type] ?? []) fn(); },
    };
  }

  test('writes --kb and a state flag', () => {
    const root = fakeRoot();
    const viewport = fakeViewport(508);
    trackKeyboard({ root, viewport, win: { innerHeight: 844 } });

    assert.equal(root.style.props['--kb'], '336px');
    assert.equal(root.dataset.keyboard, 'up');
  });

  test('follows the keyboard down again', () => {
    const root = fakeRoot();
    const viewport = fakeViewport(508);
    trackKeyboard({ root, viewport, win: { innerHeight: 844 } });

    viewport.height = 844;
    viewport.emit('resize');

    assert.equal(root.style.props['--kb'], '0px');
    assert.equal(root.dataset.keyboard, 'down');
  });

  test('listens for scroll as well as resize', () => {
    const root = fakeRoot();
    const viewport = fakeViewport(844);
    trackKeyboard({ root, viewport, win: { innerHeight: 844 } });

    viewport.height = 508;
    viewport.emit('scroll');

    assert.equal(root.style.props['--kb'], '336px');
  });

  test('stops when told to, and leaves nothing attached', () => {
    const root = fakeRoot();
    const viewport = fakeViewport(844);
    const stop = trackKeyboard({ root, viewport, win: { innerHeight: 844 } });
    stop();

    viewport.height = 508;
    viewport.emit('resize');

    assert.equal(root.style.props['--kb'], '0px', 'kept reacting after it was stopped');
    assert.equal(viewport.listeners.resize.length, 0);
    assert.equal(viewport.listeners.scroll.length, 0);
  });

  test('a browser without visualViewport still gets a usable value', () => {
    // Every desktop browser dap runs on has it, but --kb must resolve to
    // something or every calc() using it collapses.
    const root = fakeRoot();
    trackKeyboard({ root, viewport: undefined, win: { innerHeight: 844 } });

    assert.equal(root.style.props['--kb'], '0px');
    assert.equal(root.dataset.keyboard, 'down');
  });
});
