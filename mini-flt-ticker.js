// Rolling announcement strip at the very top of the page, in place of the
// thin scroll progress bar (2026-11-23, direct request). Shows the Mini FLT
// by default, or any message set in /team > Site data > Settings > Top strip.
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
    url: 'https://learn.taai.live/learn/home/Mixed-Subject-Wise-Test/section/766425/lesson/4936517?embedPlayer=1&disableLessonChange=true&visitorFlow=true',
    minutes: 90
  };
  var TOP_STRIP_DEFAULT = { enabled: true, mode: 'mini_flt', message: '', button: '', url: '', style: 'light' }; // copy of lib/mini-flt.js
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
    // Dark version for the progress tracker (2026-11-23): <script ... data-dark>
    '.mft.mft-dark{background:#15121f;color:rgba(255,255,255,.86);border-bottom:1px solid rgba(255,255,255,.1)}' +
    '.mft-dark .mft-live{background:#0b0a12;color:#FCD34D;border-right:1px solid rgba(255,255,255,.08)}' +
    '.mft-dark .mft-item b{color:#FCD34D}' +
    '.mft-dark .mft-item em{background:#FCD34D;color:#15121f;border-radius:4px}' +
    '.mft-dark .mft-item .mft-sep{opacity:.35}' +
    '.mft-live.mft-live-dot{padding-right:10px}' +
    '@media (prefers-reduced-motion:reduce){.mft-track{animation:none}.mft-live i{animation:none}.mft{transition:none}}';

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function usable(m) { return m && m.enabled && m.url && m.topics && m.topics.length; }
  function remember(on, darkStyle) {
    try { localStorage.setItem(ON_KEY, on ? '1' : '0'); localStorage.setItem(STYLE_KEY, darkStyle ? 'dark' : 'light'); } catch (e) { /* fine */ }
  }
  var STYLE_KEY = 'taai_mft_style'; // so the <head> placeholder strip has the right colour too

  // What the strip shows, from the two /team settings (2026-11-23):
  //   topStrip.mode 'mini_flt' -> built from the Mini FLT setting, a tap opens the Mini FLT card
  //   topStrip.mode 'custom'   -> your message + button text, a tap goes to your link
  // Returns null when there's nothing to show.
  function content(mf, ts) {
    if (!ts || !ts.enabled) return null;
    if (ts.mode === 'custom') {
      if (!ts.message || !ts.url) return null;
      return {
        custom: true, url: ts.url, label: ts.message,
        item: '<span class="mft-item"><b>' + esc(ts.message) + '</b>' + (ts.button ? '<em>' + esc(ts.button) + ' →</em>' : '') + '</span>'
      };
    }
    if (!usable(mf)) return null;
    var mins = (mf.minutes >= 10 && mf.minutes <= 300) ? Math.round(mf.minutes) : 90;
    return {
      custom: false, url: mf.url, label: 'Free All India Mini FLT is live: ' + mf.topics.join(', ') + '. Take the free test',
      item: '<span class="mft-item"><b>Free All India Mini FLT</b><span class="mft-sep">·</span>' +
        esc(mf.topics.join(', ')) + '<span class="mft-sep">·</span>' + mins + ' minutes<span class="mft-sep">·</span>Open to every GATE DA aspirant' +
        '<em>Take the free test →</em></span>'
    };
  }

  var bar = null, cur = null;
  function render() {
    var c = content(lastMf, lastTs);
    var darkStyle = dark || (lastTs && lastTs.style === 'dark');
    if (!c) {
      if (bar) { bar.remove(); bar = null; }
      document.documentElement.classList.remove('has-mft', 'has-mft-dark');
      remember(false, darkStyle);
      return;
    }
    remember(true, darkStyle);
    cur = c;
    if (!document.getElementById('mft-css')) {
      var st = document.createElement('style'); st.id = 'mft-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    document.documentElement.classList.add('has-mft');
    document.documentElement.classList.toggle('has-mft-dark', !!darkStyle);
    if (!bar) {
      bar = document.createElement('a');
      document.body.insertBefore(bar, document.body.firstChild);
      // Mini FLT mode: a tap opens the Mini FLT card full screen first; its
      // "Take the free test" button then goes to the test. Custom mode: a
      // plain link. Ctrl/Cmd/middle clicks always follow the link.
      bar.addEventListener('click', function (e) {
        if (!cur || cur.custom) return;
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (!window.TAAIMiniFlt || !window.TAAIMiniFlt.show) return;
        e.preventDefault();
        window.TAAIMiniFlt.show(lastMf);
      });
    }
    bar.className = 'mft' + (darkStyle ? ' mft-dark' : '');
    bar.href = c.url;
    bar.setAttribute('aria-label', c.label);
    if (c.custom && /^https?:/.test(c.url) && c.url.indexOf(location.origin) !== 0) { bar.target = '_blank'; bar.rel = 'noopener'; }
    else { bar.removeAttribute('target'); bar.removeAttribute('rel'); }
    // "Live now" only for the Mini FLT; a custom message gets a plain dot.
    var lead = c.custom ? '<span class="mft-live mft-live-dot"><i aria-hidden="true"></i></span>' : '<span class="mft-live"><i aria-hidden="true"></i>Live now</span>';
    bar.innerHTML = lead + '<span class="mft-view" aria-hidden="true"><span class="mft-track">' + c.item + '</span></span>';
    // Enough copies to fill twice the screen width, so the loop never shows a gap.
    var track = bar.querySelector('.mft-track');
    var w = track.firstChild.getBoundingClientRect().width || 600;
    var copies = Math.max(1, Math.ceil(window.innerWidth / w));
    var half = '';
    for (var i = 0; i < copies; i++) half += c.item;
    track.innerHTML = half + half;
    // about 60px a second, whatever the screen width
    track.style.setProperty('--mft-dur', Math.max(8, Math.round((w * copies) / 60)) + 's');
  }

  var me = document.currentScript;
  var dark = !!(me && me.hasAttribute('data-dark'));
  // Not in the installed app (Home Screen / Android app): it hides the nav
  // and runs edge to edge under the status bar.
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  if (standalone) { document.documentElement.classList.remove('has-mft', 'has-mft-dark'); return; }
  var lastMf = MINI_FLT_DEFAULT, lastTs = TOP_STRIP_DEFAULT;
  var on = true;
  try { on = localStorage.getItem(ON_KEY) !== '0'; } catch (e) { /* fine */ }
  // Draw the last known/default strip straight away only if it was on last
  // time (the <head> already reserved its space), then the real settings.
  if (on) render();
  fetch('/api/site-settings-public').then(function (r) { return r.json(); })
    .then(function (d) { if (d && d.miniFlt) lastMf = d.miniFlt; if (d && d.topStrip) lastTs = d.topStrip; render(); })
    .catch(function () { if (on) render(); });
  var rt;
  window.addEventListener('resize', function () {
    if (!bar) return;
    clearTimeout(rt);
    rt = setTimeout(render, 300);
  });
})();
