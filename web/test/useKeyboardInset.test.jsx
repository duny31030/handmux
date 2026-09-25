import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { softKeyboardUp, useKeyboardInset } from '../src/hooks/useKeyboardInset.js';

function Probe() {
  const inset = useKeyboardInset();
  return `inset:${inset}`;
}

let container;
let root;
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  if ('visualViewport' in window) delete window.visualViewport;
  if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight);
});

describe('useKeyboardInset', () => {
  it('returns 0 when visualViewport is unavailable', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Probe />));
    expect(container.textContent).toBe('inset:0');
  });

  it('keeps iOS keyboard presence independent from offsetTop focus scrolling', () => {
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    Object.defineProperty(window, 'visualViewport', {
      value: { height: 400, offsetTop: 368 },
      configurable: true,
    });
    expect(softKeyboardUp()).toBe(true);
  });

  it('uses the keyboard-down baseline when both mobile viewports shrink together', () => {
    Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });
    Object.defineProperty(window, 'visualViewport', {
      value: { height: 400, offsetTop: 0 },
      configurable: true,
    });
    expect(softKeyboardUp()).toBe(false);    // old/current-only signal
    expect(softKeyboardUp(768)).toBe(true); // stable keyboard-down baseline
  });

  it('keeps the app lift stable while iOS scrolls the focused field', () => {
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    const listeners = { resize: new Set(), scroll: new Set() };
    const vv = {
      width: 390,
      height: 768,
      offsetTop: 0,
      addEventListener: (type, fn) => listeners[type].add(fn),
      removeEventListener: (type, fn) => listeners[type].delete(fn),
    };
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Probe />));
    const emit = (type) => listeners[type].forEach((fn) => fn());
    const update = (height, offsetTop) => act(() => {
      vv.height = height;
      vv.offsetTop = offsetTop;
      emit('resize');
    });

    update(400, 0);
    expect(container.textContent).toBe('inset:368');
    act(() => { vv.offsetTop = 368; emit('scroll'); });
    expect(container.textContent).toBe('inset:368');
    update(768, 120);
    expect(container.textContent).toBe('inset:0');
    update(400, 240);
    expect(container.textContent).toBe('inset:368');
    update(768, 0);
    expect(container.textContent).toBe('inset:0');
  });

  it('does not double-lift Android when both layout and visual viewports resize', () => {
    Object.defineProperty(window, 'innerHeight', { value: 768, writable: true, configurable: true });
    const listeners = new Set();
    const vv = {
      width: 390,
      height: 768,
      offsetTop: 0,
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
    };
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Probe />));
    const resize = (height) => act(() => {
      window.innerHeight = height;
      vv.height = height;
      listeners.forEach((fn) => fn());
    });

    resize(400);
    expect(container.textContent).toBe('inset:0');
    resize(330); // a taller keyboard panel still resizes the layout; it must not add another app lift
    expect(container.textContent).toBe('inset:0');
  });
});
