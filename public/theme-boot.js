// Paints the first frame in the saved theme (index.html loads this blocking,
// before the app's module script; CSP is script-src 'self', so it cannot be
// inline). Mirrors src/shell/theme.tsx, which stays the source of truth once
// it loads: same localStorage keys, 'system' resolves dark unless the OS asks
// for light, OLED only while dark, UI scale clamped to 0.9-1.25.
(function () {
  var html = document.documentElement;
  var meta = document.querySelector('meta[name="theme-color"]');
  var COLORS = { dark: '#0c1320', light: '#edf0f5', oled: '#000000' };
  function color(resolved, oled) {
    return resolved === 'light' ? COLORS.light : oled ? COLORS.oled : COLORS.dark;
  }
  try {
    var stored = localStorage.getItem('tsrust.theme');
    var prefersLight = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    var resolved = stored === 'light' || stored === 'dark' ? stored : prefersLight ? 'light' : 'dark';
    var a = {};
    try {
      a = JSON.parse(localStorage.getItem('tsrust.appearance') || '{}') || {};
    } catch (e) {
      a = {};
    }
    var oled = a.oledBlack === true && resolved === 'dark';
    html.setAttribute('data-theme', resolved);
    if (oled) html.setAttribute('data-oled', '');
    if (/^(amber|teal|violet|rose|lime|sky|coral)$/.test(a.accent)) html.setAttribute('data-accent', a.accent);
    if (a.density === 'comfortable' || a.density === 'compact') html.setAttribute('data-density', a.density);
    if (typeof a.uiScale === 'number' && isFinite(a.uiScale)) {
      html.style.setProperty('--ui-scale', String(Math.min(1.25, Math.max(0.9, a.uiScale))));
    }
    if (meta) meta.setAttribute('content', color(resolved, oled));
  } catch (e) {
    // Storage blocked: the dark default in index.html stands.
  }
  // Keeps the browser chrome colour in step when the theme changes later.
  if (meta && typeof MutationObserver === 'function') {
    new MutationObserver(function () {
      meta.setAttribute('content', color(html.getAttribute('data-theme'), html.hasAttribute('data-oled')));
    }).observe(html, { attributes: true, attributeFilter: ['data-theme', 'data-oled'] });
  }
})();
