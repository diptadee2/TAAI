// Auto-hide the top nav while scrolling down; bring it back when scrolling stops
// or the reader scrolls up (2026-10-20, direct request). Loaded on all 7 main pages
// and the blog/policy pages. Works on the shared fixed `.nav`.
(function () {
  var TOP = 120;       // never hide this close to the top of the page
  var IDLE = 900;      // ms without scrolling before the nav comes back (was 280, felt too instant)
  var MIN_DELTA = 4;   // ignore tiny jitters
  var css = document.createElement('style');
  css.textContent =
    // Coming back is slower and softer than going away, so it eases in rather than snapping.
    '.nav{transition:transform .5s cubic-bezier(.22,1,.36,1)}' +
    'body.nav-autohidden .nav{transition-duration:.28s;transition-timing-function:cubic-bezier(.4,0,1,1)}' +
    // Only transform while hidden: a transform on .nav would re-anchor its
    // position:fixed children (the mobile menu), so visible means transform:none.
    'body.nav-autohidden .nav{transform:translateY(-100%);pointer-events:none}' +
    '@media (prefers-reduced-motion: reduce){.nav,body.nav-autohidden .nav{transition:none}}';
  document.head.appendChild(css);

  var lastY = window.scrollY, idleTimer = null, ticking = false;

  function nav() { return document.querySelector('.nav'); }
  function canHide() {
    var n = nav();
    if (!n) return false;
    if (n.classList.contains('menu-open')) return false;                  // React pages
    if (document.querySelector('.mobile-menu.open, .mobile-menu.active')) return false; // blog
    if (document.querySelector('.nav-dropdown-wrap.dd-open')) return false;
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
  // Touch screens: the desktop nav's Resources dropdown only opened on mouse
  // hover, so on a wide touch screen (e.g. iPad Pro landscape, which keeps the
  // full nav) it couldn't be reached. A tap on its label now opens it (a second
  // tap follows the label's own link, if it has one); a tap elsewhere closes it.
  var ddCss = document.createElement('style');
  ddCss.textContent =
    '.nav-dropdown-wrap.dd-open .nav-dropdown{opacity:1;transform:translateY(12px) scaleY(1);pointer-events:auto}' +
    '.nav-dropdown-wrap.dd-open .nav-dd-item{opacity:1;transform:translateY(0)}' +
    '.nav-dropdown-wrap.dd-open .nav-dd-divider{opacity:1}';
  document.head.appendChild(ddCss);
  var lastTouch = false, downTarget = null;
  document.addEventListener('pointerdown', function (e) { lastTouch = e.pointerType !== 'mouse'; downTarget = e.target; }, true);
  document.addEventListener('click', function (e) {
    var open = document.querySelectorAll('.nav-dropdown-wrap.dd-open');
    // Judge a tap by where the finger went down: the fake hover a tap triggers
    // can slide the dropdown under the finger before the click lands.
    var tgt = (lastTouch && downTarget && downTarget.closest) ? downTarget : e.target;
    var wrap = tgt.closest && tgt.closest('.nav-dropdown-wrap');
    if (wrap && lastTouch && !tgt.closest('.nav-dropdown') && !wrap.classList.contains('dd-open')) {
      e.preventDefault();
      for (var i = 0; i < open.length; i++) open[i].classList.remove('dd-open');
      wrap.classList.add('dd-open');
      return;
    }
    for (var j = 0; j < open.length; j++) if (open[j] !== wrap) open[j].classList.remove('dd-open');
  }, true);
  window.addEventListener('scroll', function () {
    var open = document.querySelectorAll('.nav-dropdown-wrap.dd-open');
    for (var i = 0; i < open.length; i++) open[i].classList.remove('dd-open');
  }, { passive: true });

  // Keyboard users tabbing into the nav always get it back.
  document.addEventListener('focusin', function (e) { var n = nav(); if (n && n.contains(e.target)) show(); });
})();
