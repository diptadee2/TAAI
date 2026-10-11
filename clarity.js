// Microsoft Clarity: heatmaps, scroll depth and session recordings
// (added 2026-10-11). One file, loaded with a plain <script defer> on every
// page next to discord-notice.js, so the project id lives in one place.
//
// - Only runs on the real site (taai.live), so local testing doesn't
//   pollute the data.
// - Never runs on /team or /admin (internal pages with student data).
// - Typed input is masked by Clarity's default mode; student names,
//   leaderboards and About text on the tracker carry data-clarity-mask
//   (see progress.js).
// - Tags a few key clicks as Clarity events, so recordings can be
//   filtered by them.
(function () {
  var host = location.hostname;
  if (!/(^|\.)taai\.live$/.test(host)) return;
  if (/^\/(team|admin)(\/|$)/.test(location.pathname)) return;

  (function (c, l, a, r, i, t, y) {
    c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
    t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
    y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
  })(window, document, 'clarity', 'script', 'yvy7ty3hth');

  function ev(name) { try { window.clarity('event', name); } catch (e) {} }

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('a, button') : null;
    if (!el) return;
    var href = el.getAttribute('href') || '';
    var text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (/^\/discord\b/.test(href) || /discord\.(com|gg)\//.test(href)) return ev('discord_click');
    if (/\/refund-policy\b/.test(href)) return ev('refund_policy_open');
    if (/\/gate-da-progress-tracker\b/.test(href)) ev('tracker_link_click');
    if (el.id === 'focus-toggle') return ev('focus_mode_open');
    if (el.id === 'pomo-toggle' && /start|resume/.test(text)) return ev('pomo_start');
    if (/learn\.taai\.live/.test(href) || /^enrol|^enroll|continue to enrol/.test(text)) {
      ev('enrol_click');
      var card = el.closest('.combo-card, .course-card, .ts-plan, [class*="plan-card"]');
      var title = card && card.querySelector('h3, .combo-title, .course-title');
      if (title) { try { window.clarity('set', 'enrol_course', title.textContent.trim().slice(0, 60)); } catch (er) {} }
    }
  }, true);
})();
