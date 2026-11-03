// =============================================================================
// web/theme.js: light, dark, or follow the system, for the three lab pages (style.css defines both palettes;
// html[data-theme] picks one, no attribute follows prefers-color-scheme). The choice is kept in this browser.
// Loaded as a classic script in <head> so the page never flashes the wrong colours.
// =============================================================================
(() => {
  const KEY = 'sixfold.theme', ORDER = ['system', 'light', 'dark'];
  const LABEL = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };
  let mode = 'system';
  try { const m = localStorage.getItem(KEY); if (ORDER.includes(m)) mode = m; } catch { /* storage unavailable */ }
  const apply = () => {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    const b = document.getElementById('theme');
    if (b) { b.textContent = LABEL[mode]; b.setAttribute('aria-label', `${LABEL[mode]}. Change the colour theme`); }
  };
  apply();
  addEventListener('DOMContentLoaded', () => {
    const home = document.querySelector('.home');
    if (!home) return;
    const b = Object.assign(document.createElement('button'), { type: 'button', id: 'theme', className: 'themebtn' });
    b.onclick = () => {
      mode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
      try { localStorage.setItem(KEY, mode); } catch { /* the choice lasts this visit */ }
      apply();
    };
    home.append(' · ', b);
    apply();
  });
})();
