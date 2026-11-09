// Web build: asks the server for the settings and the source list as soon as the page starts,
// while the browser is still downloading and compiling the app's modules. Every first screen
// reads both (the startup redirect, the rail, Home), and main.tsx asks for them first thing; it
// takes these answers instead of sending its own requests (`takeEarlyRpc` in src/api/transport.ts),
// which saves one round trip to the server before the first screen's code and data can start.
// index.html loads it as a blocking script after theme-boot.js: a deferred one was fetched at low
// priority behind the module preloads, which sent these requests about 270 ms later over a 60 ms
// link. The desktop app talks to its core over IPC and skips it. A file of its own, not inline
// code, because the CSP is script-src 'self'.
(function () {
  if ('__TAURI_INTERNALS__' in window || typeof fetch !== 'function') return;
  var early = {};
  ['settings.get', 'sources.list'].forEach(function (cmd) {
    early[cmd] = fetch('/api/rpc/' + cmd, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    }).catch(function () {
      // A failed early request is retried by the app with its own error handling.
      return null;
    });
  });
  window.__tsrustEarlyRpc = early;
})();
