import { useEffect, useState } from 'react';

// True while the on-screen keyboard is up. `fullHeight` is the last keyboard-down viewport height:
// some mobile browsers shrink window.innerHeight together with visualViewport.height, so comparing only
// those two CURRENT values can incorrectly produce zero. offsetTop stays deliberately excluded because
// iOS focus scrolling changes it while the keyboard remains open.
export function softKeyboardUp(fullHeight = window.innerHeight): boolean {
  const viewport = window.visualViewport;
  if (!viewport) return false;
  return Math.max(fullHeight, window.innerHeight) - viewport.height > 120;
}

// Pixels the on-screen keyboard overlaps the layout viewport's bottom. iOS Safari shrinks the
// visual viewport (not the layout viewport) when the keyboard opens, leaving bottom-docked UI
// hidden behind it; we read that overlap so the caller can shrink the app to the visible area
// (height: calc(100% - inset)), lifting the whole column above the keyboard.
// Returns 0 when there's no keyboard or when visualViewport is unsupported (safe fallback).
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    // Keep a keyboard-down height for the lifetime of this viewport. iOS changes offsetTop while it
    // scrolls a focused textarea into view; that is page motion, not a new keyboard height. Recomputing
    // the app transform from every scroll event made hydration produce 368 -> 0 -> 368px and handed
    // focus back to Safari as if the keyboard had been dismissed.
    const baseline = {
      width: viewport.width,
      fullHeight: Math.max(window.innerHeight, viewport.height),
    };
    const update = (): void => {
      if (Math.abs(viewport.width - baseline.width) > 40) {
        baseline.width = viewport.width;
        baseline.fullHeight = Math.max(window.innerHeight, viewport.height);
      } else {
        baseline.fullHeight = Math.max(baseline.fullHeight, window.innerHeight, viewport.height);
      }
      const keyboardHeight = baseline.fullHeight - viewport.height;
      // Android commonly shrinks both the layout and visual viewports together. In that case the page
      // already fits above the keyboard and applying the same height as a transform would double-lift it.
      const layoutAlreadyFits = baseline.fullHeight - window.innerHeight > 120
        && Math.abs((baseline.fullHeight - window.innerHeight) - keyboardHeight) < 80;
      const next = keyboardHeight > 120 && !layoutAlreadyFits ? Math.round(keyboardHeight) : 0;
      setInset((current) => current === next ? current : next);
    };
    update();
    viewport.addEventListener('resize', update);
    // Deliberately do not subscribe to visualViewport.scroll. offsetTop churn during focus scrolling
    // must not move the whole app or change keyboard geometry.
    return () => {
      viewport.removeEventListener('resize', update);
    };
  }, []);
  return inset;
}
