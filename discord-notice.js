// Shows a short "what to do after joining" notice before any Discord invite
// link on the site opens (footer icons, contact card, tracker button, blog
// footer). Loaded as a plain <script> on every page; one delegated click
// listener, so links rendered later by React or progress.js are covered too.
// "Continue to Discord" opens the invite in a new tab.
(function () {
  if (window.__discordNotice) return;
  window.__discordNotice = true;

  var MATCH = /(^|\.)discord\.(com\/invite|gg)\//i;
  var css = '' +
    '.dn-backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(10,8,20,.55);display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;transition:opacity .2s ease}' +
    '.dn-backdrop.dn-open{opacity:1}' +
    '.dn-card{width:min(440px,100%);background:#fff;color:#14102B;border-radius:16px;padding:22px 22px 18px;box-shadow:0 24px 60px -20px rgba(20,16,43,.45);font:inherit;font-family:inherit;transform:translateY(8px);transition:transform .25s cubic-bezier(.22,1,.36,1)}' +
    '.dn-open .dn-card{transform:none}' +
    '.dn-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}' +
    '.dn-icon{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:rgba(88,101,242,.12);color:#5865F2;flex-shrink:0}' +
    '.dn-title{font-size:17px;font-weight:700;line-height:1.3;margin:0}' +
    '.dn-body{font-size:14.5px;line-height:1.6;color:#4A4270;margin:0 0 18px}' +
    '.dn-body code{font-family:inherit;font-weight:700;color:#5865F2;background:rgba(88,101,242,.1);padding:1px 6px;border-radius:6px;white-space:nowrap}' +
    '.dn-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}' +
    '.dn-btn{font:inherit;font-size:14px;font-weight:600;border-radius:10px;padding:10px 16px;cursor:pointer;border:1px solid transparent}' +
    '.dn-cancel{background:transparent;border-color:#E3DCF5;color:#4A4270}' +
    '.dn-cancel:hover{background:#F6F2FF}' +
    '.dn-go{background:#5865F2;color:#fff}' +
    '.dn-go:hover{background:#4752C4}' +
    '.dn-btn:focus-visible{outline:2px solid #5865F2;outline-offset:2px}' +
    '@media (max-width:420px){.dn-actions{flex-direction:column-reverse}.dn-btn{width:100%}}' +
    '@media (prefers-reduced-motion:reduce){.dn-backdrop,.dn-card{transition:none}}';

  var ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.031.057a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>';

  function addStyle() {
    if (document.getElementById('dn-style')) return;
    var s = document.createElement('style');
    s.id = 'dn-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  var lastFocus = null;
  function close(back) {
    var el = document.querySelector('.dn-backdrop');
    if (!el) return;
    el.classList.remove('dn-open');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
    if (back && lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
  }

  function open(href) {
    addStyle();
    close(false);
    lastFocus = document.activeElement;
    var wrap = document.createElement('div');
    wrap.className = 'dn-backdrop';
    wrap.innerHTML =
      '<div class="dn-card" role="dialog" aria-modal="true" aria-labelledby="dn-title">' +
        '<div class="dn-head"><span class="dn-icon">' + ICON + '</span><h2 class="dn-title" id="dn-title">Before you join</h2></div>' +
        '<p class="dn-body">After joining, kindly post your email address and enrollment type in the <code>#introduce-yourself</code> channel. Our team will then grant you access to the relevant private discussion channels.</p>' +
        '<div class="dn-actions"><button type="button" class="dn-btn dn-cancel">Cancel</button><button type="button" class="dn-btn dn-go">Continue to Discord</button></div>' +
      '</div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(true); });
    wrap.querySelector('.dn-cancel').addEventListener('click', function () { close(true); });
    wrap.querySelector('.dn-go').addEventListener('click', function () {
      window.open(href, '_blank', 'noopener');
      close(false);
    });
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(function () { wrap.classList.add('dn-open'); });
    wrap.querySelector('.dn-go').focus();
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || !MATCH.test(a.getAttribute('href').replace(/^https?:\/\//i, ''))) return;
    e.preventDefault();
    open(a.href);
  }, true);
})();
