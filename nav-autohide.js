// Auto-hide the top nav while scrolling down; bring it back when scrolling stops
// or the reader scrolls up (2026-10-20, direct request). Loaded on all 7 main pages
// and the blog/policy pages. Works on the shared fixed `.nav`.
(function () {
  var TOP = 120;       // never hide this close to the top of the page
  var IDLE = 280;      // ms without scrolling before the nav comes back
  var MIN_DELTA = 4;   // ignore tiny jitters
  var css = document.createElement('style');
  css.textContent =
    '.nav{transition:transform .28s cubic-bezier(.2,.7,.2,1)}' +
    // Only transform while hidden: a transform on .nav would re-anchor its
    // position:fixed children (the mobile menu), so visible means transform:none.
    'body.nav-autohidden .nav{transform:translateY(-100%);pointer-events:none}' +
    '@media (prefers-reduced-motion: reduce){.nav{transition:none}}';
  document.head.appendChild(css);

  var lastY = window.scrollY, idleTimer = null, ticking = false;

  function nav() { return document.querySelector('.nav'); }
  function canHide() {
    var n = nav();
    if (!n) return false;
    if (n.classList.contains('menu-open')) return false;                  // React pages
    if (document.querySelector('.mobile-menu.open, .mobile-menu.active')) return false; // blog
    if (n.matches(':hover') || n.contains(document.activeElement)) return false;
    return true;
  }
  function show() { document.body.classList.remove('nav-autohidden'); }
  function hide() { if (canHide()) document.body.classList.add('nav-autohidden'); }

  function onScroll() {
    var y = window.scrollY, d = y - lastY;
    if (y < TOP) show();
    else if (d > MIN_DELTA) hide();
    else if (d < -MIN_DELTA) show();
    lastY = y;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(show, IDLE);
    ticking = false;
  }
  window.addEventListener('scroll', function () {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });
  // Keyboard users tabbing into the nav always get it back.
  document.addEventListener('focusin', function (e) { var n = nav(); if (n && n.contains(e.target)) show(); });
})();
