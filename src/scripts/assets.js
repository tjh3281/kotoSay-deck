/* ==========================================================================
   Shared assets
   build.py embeds a file used on more than one slide (the demo videos on
   slides 3 and 14) only once, in window.DECK_ASSETS, and marks each use with
   data-asset-src / data-asset-poster. This fills those in before deck.js runs.
   ========================================================================== */
(() => {
  "use strict";

  const shared = window.DECK_ASSETS || {};
  ["src", "poster"].forEach((attr) => {
    document.querySelectorAll(`[data-asset-${attr}]`).forEach((el) => {
      const uri = shared[el.getAttribute(`data-asset-${attr}`)];
      if (uri) el.setAttribute(attr, uri);
    });
  });
})();
