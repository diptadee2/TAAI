// Rolling Mini FLT announcement strip at the very top of the page, in place
// of the thin scroll progress bar (2026-11-23, direct request).
//
// Loaded on the six main pages (home, courses, test series, testimonials,
// contact, free notes) with <script src="/mini-flt-ticker.js" defer>, plus a
// one-line inline script in <head> that adds html.has-mft before the page
// paints (so the page doesn't jump down when the strip appears). The whole
// strip is one link to the test. Topics, link and on/off come from /team
// (Site data > Settings > Free Mini FLT promo) via /api/site-settings-public;
// A tap opens the Mini FLT card (/mini-flt-popup.js, loaded on all six pages).
// switched off, the strip is removed and the scroll progress bar is back.
// MINI_FLT_DEFAULT is a hand copy of netlify/functions/lib/mini-flt.js.
(function () {
  'use strict';
  var MINI_FLT_DEFAULT = {
    enabled: true,
    topics: ['Linear Algebra', 'Python', 'Machine Learning'],
    url: 'https://learn.taai.live/learn/home/Mixed-Subject-Wise-Test/section/766425/lesson/4936517?embedPlayer=1&disableLessonChange=true&visitorFlow=true'
  };
  var ON_KEY = 'taai_mft_on'; // remembered so the <head> script reserves the space only when it'll show
  var H = 34;
  var CSS =
    // (the html.has-mft layout rules that move the nav down live in each
    // page's <head>, so the space is there from the first paint)
    '.mft{position:fixed;top:0;left:0;right:0;z-index:60;height:' + H + 'px;display:flex;align-items:stretch;background:#FFE14D;color:#111;border-bottom:2px solid #111;text-decoration:none;font-family:Poppins,Arial,sans-serif;overflow:hidden;transition:transform .28s cubic-bezier(.4,0,1,1)}' +
    'body.nav-autohidden .mft{transform:translateY(-100%)}' +
    '.mft-live{flex:none;display:flex;align-items:center;gap:7px;background:#111;color:#FFE14D;padding:0 12px 0 max(12px,env(safe-area-inset-left,0px));font:500 11px "DM Mono",ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;z-index:1}' +
    '.mft-live i{width:7px;height:7px;border-radius:50%;background:#E5372C;animation:mft-blink 1.4s infinite}' +
    '@keyframes mft-blink{50%{opacity:.25}}' +
    '.mft-view{flex:1;min-width:0;overflow:hidden;display:flex;align-items:center;-webkit-mask-image:linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent);mask-image:linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent)}' +
    '.mft-track{display:flex;flex:none;white-space:nowrap;animation:mft-roll var(--mft-dur,30s) linear infinite;will-change:transform}' +
    '.mft:hover .mft-track,.mft:focus-visible .mft-track{animation-play-state:paused}' +
    '@keyframes mft-roll{from{transform:translateX(0)}to{transform:translateX(-50%)}}' +
    '.mft-item{display:inline-flex;align-items:center;gap:10px;padding-right:42px;font-size:13.5px;font-weight:500}' +
    '.mft-item b{font-weight:700}' +
    '.mft-item em{font-style:normal;font-weight:700;background:#111;color:#FFE14D;padding:2px 9px}' +
    '.mft-item .mft-sep{opacity:.45}' +
    '.mft:focus-visible{outline:3px solid #FF4F9A;outline-offset:-3px}' +
    '@media (max-width:600px){.mft-item{font-size:12.5px;padding-right:32px}.mft-live{padding-right:10px;font-size:10px}}' +
    '@media (prefers-reduced-motion:reduce){.mft-track{animation:none}.mft-live i{animation:none}.mft{transition:none}}';

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function usable(m) { return m && m.enabled && m.url && m.topics && m.topics.length; }
  function remember(on) { try { localStorage.setItem(ON_KEY, on ? '1' : '0'); } catch (e) { /* fine */ } }

  var bar = null;
  function itemHtml(m) {
    return '<span class="mft-item"><b>Free All India Mini FLT</b><span class="mft-sep">·</span>' +
      esc(m.topics.join(', ')) + '<span class="mft-sep">·</span>90 minutes<span class="mft-sep">·</span>No payment needed' +
      '<em>Take the free test →</em></span>';
  }
  function render(m) {
    if (!usable(m)) {
      if (bar) { bar.remove(); bar = null; }
      document.documentElement.classList.remove('has-mft');
      remember(false);
      return;
    }
    remember(true);
    if (!document.getElementById('mft-css')) {
      var st = document.createElement('style'); st.id = 'mft-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    document.documentElement.classList.add('has-mft');
    if (!bar) {
      bar = document.createElement('a');
      bar.className = 'mft';
      bar.setAttribute('aria-label', 'Free All India Mini FLT is live: ' + m.topics.join(', ') + '. Take the free test');
      document.body.insertBefore(bar, document.body.firstChild);
      // A tap opens the Mini FLT card full screen first (2026-11-23, direct
      // request); its "Take the free test" button then goes to the test.
      // Ctrl/Cmd/middle clicks, or no popup script on the page, still follow
      // the link directly.
      bar.addEventListener('click', function (e) {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (!window.TAAIMiniFlt || !window.TAAIMiniFlt.show) return;
        e.preventDefault();
        window.TAAIMiniFlt.show(last);
      });
    }
    bar.href = m.url;
    // Enough copies to fill twice the screen width, so the loop never shows a gap.
    var one = itemHtml(m);
    bar.innerHTML = '<span class="mft-live"><i aria-hidden="true"></i>Live now</span><span class="mft-view" aria-hidden="true"><span class="mft-track">' + one + '</span></span>';
    var track = bar.querySelector('.mft-track');
    var w = track.firstChild.getBoundingClientRect().width || 600;
    var copies = Math.max(1, Math.ceil(window.innerWidth / w));
    var half = '';
    for (var i = 0; i < copies; i++) half += one;
    track.innerHTML = half + half;
    // about 60px a second, whatever the screen width
    track.style.setProperty('--mft-dur', Math.round((w * copies) / 60) + 's');
  }

  var last = MINI_FLT_DEFAULT;
  var on = true;
  try { on = localStorage.getItem(ON_KEY) !== '0'; } catch (e) { /* fine */ }
  if (on) render(last);
  fetch('/api/site-settings-public').then(function (r) { return r.json(); })
    .then(function (d) { last = (d && d.miniFlt) || last; render(last); })
    .catch(function () { if (on) render(last); });
  var rt;
  window.addEventListener('resize', function () {
    if (!bar) return;
    clearTimeout(rt);
    rt = setTimeout(function () { render(last); }, 300);
  });
})();
