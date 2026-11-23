// Free All India Mini FLT popup (2026-11-23).
//
// Shared by the home page, the test series page and the progress tracker.
//   <script src="/mini-flt-popup.js" data-auto defer></script>
//     data-auto: fetch the settings and open the popup on EVERY page load
//     (home and test series, by request).
//   window.TAAIMiniFlt.show(settings) / .close()
//     the tracker decides when to show it itself (progress.js: once on the
//     checklist and once in Focus mode, after the 2 AM Club winners).
//
// Topics, the test link and the on/off switch come from /team (Site data >
// Settings) via /api/site-settings-public. MINI_FLT_DEFAULT is a hand copy of
// netlify/functions/lib/mini-flt.js, used if that request fails.
(function () {
  'use strict';
  var MINI_FLT_DEFAULT = {
    enabled: true,
    topics: ['Linear Algebra', 'Python', 'Machine Learning'],
    url: 'https://learn.taai.live/learn/home/Mixed-Subject-Wise-Test/section/766425/lesson/4936517?embedPlayer=1&disableLessonChange=true&visitorFlow=true',
    minutes: 90
  };
  var TONES = ['pink', 'sky', 'lime', 'orange', 'lilac', 'yellow'];
  var LINES = [[78, 52], [64], [82, 40], [58], [70, 46], [75]];
  var STAR = 'polygon(50.0% 0.0%,57.3% 8.6%,67.1% 3.0%,70.8% 13.6%,82.1% 11.7%,82.2% 23.0%,93.3% 25.0%,89.5% 35.6%,99.2% 41.3%,91.6% 50.0%,99.2% 58.7%,89.5% 64.4%,93.3% 75.0%,82.2% 77.0%,82.1% 88.3%,70.8% 86.4%,67.1% 97.0%,57.3% 91.4%,50.0% 100.0%,42.7% 91.4%,32.9% 97.0%,29.2% 86.4%,17.9% 88.3%,17.8% 77.0%,6.7% 75.0%,10.5% 64.4%,0.8% 58.7%,8.4% 50.0%,0.8% 41.3%,10.5% 35.6%,6.7% 25.0%,17.8% 23.0%,17.9% 11.7%,29.2% 13.6%,32.9% 3.0%,42.7% 8.6%)';

  var CSS =
    '.mfp-backdrop{position:fixed;inset:0;z-index:3100;background:rgba(10,8,20,.55);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:44px max(16px,env(safe-area-inset-right,0px)) 24px max(16px,env(safe-area-inset-left,0px));opacity:0;transition:opacity .22s ease}' +
    '.mfp-backdrop.mfp-in{opacity:1}' +
    '.mfp{position:relative;width:min(960px,100%);max-height:calc(100dvh - 72px);overflow-y:auto;overscroll-behavior:contain;background:#FFE14D;border:3px solid #111;box-shadow:8px 8px 0 #111;color:#111;font-family:Poppins,Arial,sans-serif;text-align:left;box-sizing:border-box;transform:translateY(14px) scale(.98);transition:transform .26s cubic-bezier(.34,1.4,.64,1)}' +
    '.mfp-in .mfp{transform:none}' +
    '.mfp *{box-sizing:border-box}' +
    '.mfp:focus{outline:none}' +
    '.mfp-body{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:32px;align-items:center;padding:34px 34px 30px}' +
    '.mfp-tag{align-self:flex-start;display:inline-flex;gap:8px;align-items:center;background:#111;color:#FFE14D;font-family:"DM Mono",ui-monospace,Menlo,monospace;font-size:12px;letter-spacing:.06em;text-transform:uppercase;padding:5px 10px}' +
    '.mfp-tag i{width:8px;height:8px;border-radius:50%;background:#E5372C;animation:mfp-blink 1.4s infinite}' +
    '@keyframes mfp-blink{50%{opacity:.25}}' +
    '.mfp-h{font-size:clamp(26px,3.4vw,40px);line-height:1.08;margin:14px 0 14px;font-weight:700;letter-spacing:-.01em;max-width:17ch;color:#111}' +
    '.mfp-h span{background:#fff;border:3px solid #111;padding:0 8px;display:inline-block;transform:rotate(-1.5deg)}' +
    '.mfp-lede{font-size:15.5px;line-height:1.55;font-weight:500;max-width:46ch;margin:0 0 22px;color:#111}' +
    '.mfp-cta{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px}' +
    '.mfp-btn{display:inline-flex;align-items:center;gap:10px;background:#111;color:#fff !important;text-decoration:none;font-weight:700;font-size:16px;padding:14px 22px;border:3px solid #111;box-shadow:4px 4px 0 #fff;transition:transform .12s,box-shadow .12s}' +
    '.mfp-btn:hover{transform:translate(2px,2px);box-shadow:2px 2px 0 #fff}' +
    '.mfp-btn:focus-visible,.mfp-later:focus-visible,.mfp-x:focus-visible{outline:3px solid #FF4F9A;outline-offset:3px}' +
    '.mfp-later{background:none;border:0;padding:6px 2px;font:600 14px Poppins,Arial,sans-serif;color:#111;text-decoration:underline;text-underline-offset:3px;cursor:pointer}' +
    '.mfp-paper{background:#fff;border:3px solid #111;box-shadow:6px 6px 0 #111;padding:16px 18px 18px;transform:rotate(1.5deg);min-width:0}' +
    '.mfp-head{display:flex;gap:10px;align-items:center;padding-right:64px;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:6px}' +
    '.mfp-head b{font-size:17px;font-weight:700}' +
    '.mfp-head span{font-family:"DM Mono",ui-monospace,Menlo,monospace;font-size:12px;border:2px solid #111;padding:2px 8px}' +
    '.mfp-head em{font-style:normal;font-family:"DM Mono",ui-monospace,Menlo,monospace;font-size:11px;text-transform:uppercase;color:#D42E22;letter-spacing:.06em}' +
    '.mfp-qs{list-style:none;margin:0 0 14px;padding:0}' +
    '.mfp-qs li{display:grid;grid-template-columns:28px 128px minmax(0,1fr);gap:10px;align-items:center;padding:6px 0;border-bottom:1px dashed #bbb}' +
    '.mfp-qn{font-family:"DM Mono",ui-monospace,Menlo,monospace;font-size:12px}' +
    '.mfp-qt{font-size:11.5px;font-weight:700;border:2px solid #111;padding:2px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}' +
    '.mfp-ql{display:flex;flex-direction:column;gap:5px;min-width:0}' +
    '.mfp-ql i{display:block;height:6px;background:#e3e3e3;border-radius:3px}' +
    '.mfp-pink{background:#FF9EC7}.mfp-sky{background:#9ED8FF}.mfp-lime{background:#C8F169}.mfp-orange{background:#FFB36B}.mfp-lilac{background:#C9B6FF}.mfp-yellow{background:#FFE14D}' +
    '.mfp-th{margin:0 0 8px;font-family:"DM Mono",ui-monospace,Menlo,monospace;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#111}' +
    '.mfp-topics{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}' +
    '.mfp-topics li{display:inline-flex;align-items:center;gap:7px;background:#fff;border:2px solid #111;padding:4px 9px;font-size:13px;font-weight:700;color:#111}' +
    '.mfp-topics i{width:12px;height:12px;border:1.5px solid #111}' +
    '.mfp-topics-out{display:none;margin:0 0 20px}' +
    '.mfp-free{position:absolute;top:-30px;right:-18px;width:130px;height:130px;transform:rotate(12deg);z-index:2;pointer-events:none}' +
    '.mfp-free>span{position:absolute;inset:0;clip-path:' + STAR + '}' +
    '.mfp-fs{background:#111;transform:translate(5px,5px)}.mfp-fb{background:#111}' +
    '.mfp-free .mfp-fi{inset:5px;background:#FF9EC7;display:flex;align-items:center;justify-content:center;font:700 35px Poppins,Arial,sans-serif;color:#111}' +
    '.mfp-x{position:absolute;top:10px;left:10px;z-index:3;width:38px;height:38px;border:2px solid #111;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;box-shadow:2px 2px 0 #111}' +
    '.mfp-x:hover{background:#FFF6DE}' +
    '.mfp-wrap{position:relative;width:min(960px,100%)}' +
    // Phones and narrow tablets: no paper drawing (it made the popup far too
    // tall); the topics show as chips under the text instead.
    '@media (max-width:860px){.mfp-free{right:-4px}}' +
    // Phones (upright or sideways) and narrow tablets: no paper drawing (it
    // made the popup far too tall); the button comes right after the text and
    // the topics show as chips under it.
    '@media (max-width:760px),(max-height:500px){.mfp-body{grid-template-columns:1fr;padding:58px 22px 22px;gap:0}.mfp-paper{display:none}' +
      '.mfp-main{display:flex;flex-direction:column}.mfp-topics-out{display:block;order:5;margin:18px 0 0}' +
      '.mfp-free{width:96px;height:96px;top:-26px;right:-4px}.mfp-free .mfp-fi{font-size:25px}' +
      '.mfp-lede{font-size:15px;margin-bottom:18px}}' +
    '@media (max-width:760px){.mfp-btn{width:100%;justify-content:center}.mfp-cta{flex-direction:column;align-items:stretch;text-align:center}}' +
    '@media (max-height:500px){.mfp-body{padding:62px 24px 18px}.mfp-h{font-size:24px;max-width:none;margin:10px 0}.mfp-lede{margin-bottom:14px}}' +
    '@media (max-width:360px),(max-height:600px) and (max-width:760px){.mfp-h{font-size:23px;margin:10px 0}.mfp-lede{font-size:14px;line-height:1.5}}' +
    '@media (max-height:620px) and (min-height:501px) and (min-width:761px){.mfp-body{padding:26px 30px 22px}.mfp-qs li{padding:4px 0}.mfp-h{font-size:28px}}' +
    '@media (prefers-reduced-motion:reduce){.mfp-backdrop,.mfp,.mfp-btn{transition:none}.mfp-tag i{animation:none}}';

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function usable(m) { return m && m.enabled && m.url && m.topics && m.topics.length; }

  var el = null, lastFocus = null, prevOverflow = '';
  function onKey(e) { if (e.key === 'Escape') close(); }

  function close() {
    if (!el) return;
    var node = el; el = null;
    document.removeEventListener('keydown', onKey);
    document.documentElement.style.overflow = prevOverflow;
    node.classList.remove('mfp-in');
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 230);
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* fine */ } }
  }

  function show(m) {
    m = m || MINI_FLT_DEFAULT;
    if (!usable(m) || el) return false;
    if (!document.getElementById('mfp-css')) {
      var st = document.createElement('style'); st.id = 'mfp-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    var mins = (m.minutes >= 10 && m.minutes <= 300) ? Math.round(m.minutes) : 90;
    var n = m.topics.length;
    var rows = LINES.map(function (lines, i) {
      var t = (i * (n > 2 ? 2 : 1) + Math.floor(i / n)) % n;
      return '<li><span class="mfp-qn">Q' + (i + 1) + '</span><span class="mfp-qt mfp-' + TONES[t % TONES.length] + '">' + esc(m.topics[t]) + '</span>' +
        '<span class="mfp-ql">' + lines.map(function (w) { return '<i style="width:' + w + '%"></i>'; }).join('') + '</span></li>';
    }).join('');
    var chips = m.topics.map(function (t, i) { return '<li><i class="mfp-' + TONES[i % TONES.length] + '"></i>' + esc(t) + '</li>'; }).join('');
    var topics = '<p class="mfp-th">Topics in the live test</p><ul class="mfp-topics">' + chips + '</ul>';
    lastFocus = document.activeElement;
    el = document.createElement('div');
    el.className = 'mfp-backdrop';
    el.innerHTML =
      '<div class="mfp-wrap">' +
        '<div class="mfp" role="dialog" aria-modal="true" aria-labelledby="mfp-title" tabindex="-1">' +
          '<button type="button" class="mfp-x" aria-label="Close"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></button>' +
          '<div class="mfp-body">' +
            '<div class="mfp-main">' +
              '<span class="mfp-tag"><i aria-hidden="true"></i>Live now · All India · Free</span>' +
              '<h2 class="mfp-h" id="mfp-title">Take the <span>Mini FLT</span> free, and see where you stand.</h2>' +
              '<p class="mfp-lede">Every Mini FLT is one ' + mins + '-minute paper that mixes questions from a few subjects, the way the real GATE DA paper does. More are on the way, each with its own mix of subjects.</p>' +
              '<div class="mfp-topics-out">' + topics + '</div>' +
              '<div class="mfp-cta"><a class="mfp-btn" href="' + esc(m.url) + '">Take the free test <span aria-hidden="true">→</span></a>' +
                '<button type="button" class="mfp-later">Maybe later</button></div>' +
            '</div>' +
            '<div class="mfp-paper" aria-hidden="true">' +
              '<div class="mfp-head"><b>Mini FLT</b><span>' + mins + ' min</span><em>Live now</em></div>' +
              '<ol class="mfp-qs">' + rows + '</ol>' + topics +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="mfp-free" aria-hidden="true"><span class="mfp-fs"></span><span class="mfp-fb"></span><span class="mfp-fi">FREE</span></div>' +
      '</div>';
    document.body.appendChild(el);
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    el.addEventListener('mousedown', function (e) { if (e.target === el) close(); });
    el.querySelector('.mfp-x').addEventListener('click', close);
    el.querySelector('.mfp-later').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    var node = el;
    requestAnimationFrame(function () { requestAnimationFrame(function () { node.classList.add('mfp-in'); }); });
    try { node.querySelector('.mfp').focus({ preventScroll: true }); } catch (e) { /* fine */ }
    return true;
  }

  function fetchSettings() {
    return fetch('/api/site-settings-public').then(function (r) { return r.json(); })
      .then(function (d) { return (d && d.miniFlt) || MINI_FLT_DEFAULT; })
      .catch(function () { return MINI_FLT_DEFAULT; });
  }

  // "Seen" is remembered per place AND per test (2026-11-23): the key carries
  // a short hash of the test link, so changing the link in /team shows the
  // popup once more everywhere. A "seen" saved before this (no hash) counts
  // for the original test only, so nobody sees that one twice.
  function testId(m) {
    var u = String((m && m.url) || ''), h = 5381;
    for (var i = 0; i < u.length; i++) h = ((h << 5) + h + u.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  var SEEN = 'taai_mini_flt_popup_seen:';
  function isSeen(place, m) {
    try {
      if (localStorage.getItem(SEEN + place + ':' + testId(m)) === '1') return true;
      return m && m.url === MINI_FLT_DEFAULT.url && localStorage.getItem(SEEN + place) === '1';
    } catch (e) { return false; }
  }
  function markSeen(place, m) { try { localStorage.setItem(SEEN + place + ':' + testId(m), '1'); } catch (e) { /* fine */ } }

  window.TAAIMiniFlt = { show: show, close: close, fetchSettings: fetchSettings, isSeen: isSeen, markSeen: markSeen, DEFAULT: MINI_FLT_DEFAULT };

  // data-auto: 1.8s after the page opens; waits while the phone menu or
  // another dialog is open, or the tab is in the background.
  // data-once="name" (home): shown only once per browser on that page for
  // each test (see isSeen); without it, every page load.
  var me = document.currentScript;
  var place = me && me.getAttribute('data-once');
  if (me && me.hasAttribute('data-auto')) {
    fetchSettings().then(function (m) {
      if (!usable(m) || (place && isSeen(place, m))) return;
      var tries = 0;
      function attempt() {
        var busy = document.hidden || document.querySelector('.mobile-menu.open, [aria-modal="true"]');
        if (busy && tries++ < 120) { setTimeout(attempt, 1000); return; }
        if (!busy && !(place && isSeen(place, m)) && show(m) && place) markSeen(place, m);
      }
      setTimeout(attempt, 1800);
    });
  }
})();
