// =============================================================================
// site/theme.js: light, dark, or follow the system, for the front page.
//
// site/style.css defines both palettes: html[data-theme] picks one, no attribute follows the operating
// system (prefers-color-scheme). The choice is stored under the same key as the labs (web/theme.js), so
// picking "light" here also opens the labs in light.
//
// Loaded as a classic script in <head> so the page never flashes the wrong colours. When the colours change
// (the switch, or the system flipping between day and night) it fires a `sixfold:theme` event on window, so
// the canvases and the 3D hero, which copy colours out of CSS, can repaint.
// =============================================================================
(() => {
  const KEY = 'sixfold.theme', ORDER = ['system', 'light', 'dark'];
  const NAME = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };
  let mode = 'system';
  try { const m = localStorage.getItem(KEY); if (ORDER.includes(m)) mode = m; } catch { /* storage unavailable */ }

  // a sun, a moon, and a half-filled circle for "follow the system"
  const ICON = {
    light: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.6" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 1.8v2.1M10 16.1v2.1M1.8 10h2.1M16.1 10h2.1M4.2 4.2l1.5 1.5M14.3 14.3l1.5 1.5M4.2 15.8l1.5-1.5M14.3 5.7l1.5-1.5"/></g></svg>',
    dark: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.6 12.6A6.6 6.6 0 0 1 7.4 4.4a6.6 6.6 0 1 0 8.2 8.2Z" fill="currentColor"/></svg>',
    system: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 3a7 7 0 0 1 0 14Z" fill="currentColor"/></svg>',
  };

  const changed = () => dispatchEvent(new CustomEvent('sixfold:theme'));
  const apply = () => {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    const b = document.getElementById('theme');
    if (b) {
      b.innerHTML = ICON[mode];
      const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
      b.setAttribute('aria-label', `${NAME[mode]}. Switch to ${NAME[next].toLowerCase()}`);
      b.title = NAME[mode];
    }
  };
  apply();
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (mode === 'system') changed(); });

  addEventListener('DOMContentLoaded', () => {
    const slot = document.getElementById('theme-slot');
    if (!slot) return;
    const b = Object.assign(document.createElement('button'), { type: 'button', id: 'theme', className: 'themebtn' });
    b.onclick = () => {
      mode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
      try { localStorage.setItem(KEY, mode); } catch { /* the choice lasts this visit */ }
      apply(); changed();
    };
    slot.replaceWith(b);
    apply();
  });
})();
