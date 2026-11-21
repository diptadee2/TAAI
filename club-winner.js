// The 2 AM Club winners announcement, shared by the progress tracker, the
// courses page and the test series page (2026-11-21). Plain JS, no
// dependencies; brings its own stylesheet (/club-winner.css).
//
//   window.TAAIClub.show(winner, runners, opts)  open the popup
//   window.TAAIClub.confetti() / .fireworks()     the celebrations
//
// On the tracker, progress.js decides when to show it (twice per browser:
// checklist and Focus mode). On the courses and test series pages
// (<script src="/club-winner.js" data-auto defer>), it shows once to anyone
// who hasn't already seen it on the tracker, a few seconds after the page
// opens, with a link to the free tracker (mostly for new visitors).
//
// Phones get the winners as a Bumble-style card deck: one post on top, the
// others stacked behind; drag it left or right and it flies off to the back
// of the deck. Tapping a photo still opens it full screen.
(function () {
  'use strict';
  if (window.TAAIClub) return;

  var SEEN = 'taai_club_winner_seen_';
  var ORD = { 1: '1st', 2: '2nd', 3: '3rd' }, MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

  function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escA(str) { return esc(str).replace(/`/g, '&#96;'); }
  function reduced() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function isPhone() { try { return window.matchMedia('(max-width: 600px), (max-height: 500px)').matches; } catch (e) { return false; } }

  // The stylesheet, added once.
  function ensureCss() {
    if (document.getElementById('club-winner-css')) return;
    var l = document.createElement('link');
    l.id = 'club-winner-css'; l.rel = 'stylesheet'; l.href = '/club-winner.css?v=2';
    document.head.appendChild(l);
  }
  ensureCss();

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  // A person's photos (older rows had one `photo` instead of `photos`).
  function photosOf(p) {
    var list = p.photos && p.photos.length ? p.photos : (p.photo ? [p.photo] : []);
    return list.filter(function (x) { return x && x.src; }).slice(0, 2);
  }
  // One person's post as a LinkedIn-style card: profile picture, name, a few
  // lines fading to grey with "...see more", then the photos as framed prints
  // fanned over each other (never cropped).
  function liCardHtml(p, idx, month) {
    var photos = photosOf(p);
    if (!p.linkedin_text && !photos.length) return '';
    var role = p.headline || ((p.place === 1 ? 'Winner' : ORD[p.place] + ' place') + ', The 2 AM Club · ' + (month || ''));
    return '<div class="cw-li" data-card="' + idx + '">' +
      '<div class="cw-li-head">' +
        (p.avatar && p.avatar.src ? '<img class="cw-li-av" src="' + escA(p.avatar.src) + '" alt="">' : '<span class="cw-li-av cw-li-av-ini">' + esc(initials(p.name)) + '</span>') +
        '<div class="cw-li-who"><b>' + esc(p.name) + '</b><span>' + esc(role) + '</span><span class="cw-li-meta">Posted on LinkedIn</span></div>' +
      '</div>' +
      (p.linkedin_text ? '<div class="cw-li-textwrap"><p class="cw-li-text"></p>' +
        (p.linkedin_url ? '<a class="cw-li-more" hidden href="' + escA(p.linkedin_url) + '" target="_blank" rel="noopener">…see more</a>' : '<button type="button" class="cw-li-more" hidden>…see more</button>') +
      '</div>' : '') +
      (photos.length ? '<div class="cw-li-photos cw-li-photos-' + photos.length + '">' + photos.map(function (ph, i) {
        return '<button type="button" class="cw-li-frame" data-photo="' + i + '" aria-label="View ' + escA(p.name) + '\'s photos bigger"><img src="' + escA(ph.src) + '" alt="' + escA(p.name + '\'s photo ' + (i + 1)) + '" draggable="false"></button>';
      }).join('') + '</div>' : '') +
      '<div class="cw-li-bar" aria-hidden="true"><span>Like</span><span>Comment</span><span>Repost</span><span>Send</span></div>' +
    '</div>';
  }

  var keyHandler = null;
  function close() {
    var m = document.getElementById('club-winner-modal');
    if (!m) return;
    m.classList.add('is-leaving');
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    if (m._onResize) window.removeEventListener('resize', m._onResize);
    setTimeout(function () { if (m.parentNode) m.parentNode.removeChild(m); document.body.classList.remove('club-winner-open'); }, 220);
  }

  // All of a person's photos full screen, side by side; Esc, x or a tap
  // outside a photo closes only this viewer.
  function openPhotos(srcs) {
    if (!srcs.length || document.getElementById('cw-lightbox')) return;
    var back = document.activeElement;
    var lb = document.createElement('div');
    lb.id = 'cw-lightbox'; lb.className = 'cw-lb';
    lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', 'Photos');
    lb.innerHTML =
      '<div class="cw-lb-row n' + srcs.length + '">' + srcs.map(function (src, i) {
        return '<img class="cw-lb-img" src="' + escA(src) + '" alt="Photo ' + (i + 1) + ' of ' + srcs.length + '">';
      }).join('') + '</div>' +
      '<button type="button" class="cw-lb-x" aria-label="Close photos"><svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>';
    document.body.appendChild(lb);
    function shut() {
      document.removeEventListener('keydown', onKey, true);
      lb.classList.add('is-leaving');
      setTimeout(function () { if (lb.parentNode) lb.parentNode.removeChild(lb); }, 180);
      if (back && back.focus) back.focus({ preventScroll: true });
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); shut(); } }
    lb.addEventListener('click', function (e) { if (!(e.target.classList && e.target.classList.contains('cw-lb-img'))) shut(); });
    document.addEventListener('keydown', onKey, true);
    lb.querySelector('.cw-lb-x').focus({ preventScroll: true });
  }

  // ── Bumble-style deck (phones) ──────────────────────────────────────
  // The posts are stacked; the top one follows the finger (a little tilt),
  // and if thrown far or fast enough it flies off and goes to the back of
  // the deck, so nobody can lose a card. A tap (no drag) still works as a
  // tap: photos open, links open.
  function setupDeck(m) {
    var wrap = m.querySelector('.cw-cols');
    var cols = Array.prototype.slice.call(wrap.querySelectorAll('.cw-col'));
    if (cols.length < 2) return;
    var n = cols.length, order = cols.map(function (_, i) { return i; }); // order[0] = top card
    wrap.classList.add('cw-deck');
    var dots = document.createElement('div');
    dots.className = 'cw-deck-dots';
    dots.innerHTML = cols.map(function () { return '<i></i>'; }).join('') + '<span>Swipe to see the next winner</span>';
    wrap.parentNode.insertBefore(dots, wrap.nextSibling);
    var dotEls = dots.querySelectorAll('i');

    function layout(instant) {
      order.forEach(function (ci, pos) {
        var el = cols[ci];
        el.style.transition = instant ? 'none' : '';
        el.style.zIndex = String(n - pos);
        el.style.transform = pos === 0 ? 'none' : 'translateY(' + (pos * 12) + 'px) scale(' + (1 - pos * 0.05) + ')';
        el.style.opacity = pos > 2 ? '0' : '1';
        el.classList.toggle('is-top', pos === 0);
        el.setAttribute('aria-hidden', pos === 0 ? 'false' : 'true');
      });
      Array.prototype.forEach.call(dotEls, function (d, i) { d.classList.toggle('on', i === order[0]); });
    }
    function measure() {
      var h = 0;
      cols.forEach(function (el) { h = Math.max(h, el.offsetHeight); });
      wrap.style.height = (h + Math.min(n - 1, 2) * 12) + 'px';
    }
    layout(true); measure();
    // images arriving late change the card heights
    Array.prototype.forEach.call(wrap.querySelectorAll('img'), function (im) { if (!im.complete) im.addEventListener('load', measure); });
    m._onResize = measure;
    window.addEventListener('resize', measure);

    function next(dir) {
      var top = cols[order[0]];
      var W = wrap.offsetWidth || 320;
      if (reduced()) { order.push(order.shift()); layout(true); return; }
      top.style.transition = 'transform .32s cubic-bezier(.2,.7,.3,1), opacity .32s';
      top.style.transform = 'translateX(' + (dir * W * 1.25) + 'px) rotate(' + (dir * 18) + 'deg)';
      top.style.opacity = '0';
      setTimeout(function () {
        order.push(order.shift());
        layout(true);           // the old top card jumps to the back unseen...
        top.style.opacity = '0';
        requestAnimationFrame(function () { requestAnimationFrame(function () { layout(false); }); }); // ...then everything settles
      }, 300);
    }

    var sx = 0, sy = 0, dx = 0, t0 = 0, dragging = false, pid = null, moved = false;
    wrap.addEventListener('pointerdown', function (e) {
      var top = cols[order[0]];
      if (!top.contains(e.target) || (e.pointerType === 'mouse' && e.button !== 0)) return;
      sx = e.clientX; sy = e.clientY; dx = 0; t0 = Date.now(); dragging = false; moved = false; pid = e.pointerId;
    });
    wrap.addEventListener('pointermove', function (e) {
      if (pid !== e.pointerId) return;
      var mx = e.clientX - sx, my = e.clientY - sy;
      if (!dragging) {
        if (Math.abs(mx) < 8 || Math.abs(mx) < Math.abs(my)) { if (Math.abs(my) > 10) pid = null; return; }
        dragging = true; moved = true;
        try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      }
      dx = mx;
      var top = cols[order[0]];
      top.style.transition = 'none';
      top.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 22) + 'deg)';
      e.preventDefault();
    });
    function end(e) {
      if (pid !== e.pointerId) return;
      pid = null;
      if (!dragging) return;
      dragging = false;
      var v = Math.abs(dx) / Math.max(1, Date.now() - t0);
      if (Math.abs(dx) > 80 || (v > 0.5 && Math.abs(dx) > 30)) next(dx > 0 ? 1 : -1);
      else layout(false); // springs back
    }
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
    // a drag must not also count as a tap on a photo or link
    wrap.addEventListener('click', function (e) { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
    // tapping a card that is behind the top one brings the deck forward
    wrap.addEventListener('click', function (e) {
      var col = e.target.closest && e.target.closest('.cw-col');
      if (col && !col.classList.contains('is-top')) { e.preventDefault(); e.stopPropagation(); next(1); }
    }, true);
    Array.prototype.forEach.call(dotEls, function (d) { d.addEventListener('click', function () { next(1); }); });
  }

  // opts.cta: { href, text } adds a button next to Close (used on the sales pages).
  function show(w, runners, opts) {
    if (!w || !w.name || document.getElementById('club-winner-modal')) return false;
    ensureCss();
    opts = opts || {};
    var month = w.month || '';
    var first = Object.assign({}, w, { place: 1 });
    var others = (runners && runners.people || []).filter(function (p) { return p && p.name; }).slice(0, 3)
      .map(function (p, i) { return Object.assign({}, p, { place: p.place || (i < 2 ? 2 : 3) }); });
    var people = [first].concat(others);
    var combined = others.length > 0;
    var note = combined && runners.note ? runners.note : '';
    var head = combined
      ? '<div class="cw-tag">🏆 The 2 AM Club · ' + esc(month) + ' winners</div>' +
        '<h2 class="cw-title" id="cw-title">Congratulations to our <span class="cw-name">2 AM Club</span> winners!</h2>' +
        '<p class="cw-sub">The best stories of <span class="cw-month">' + esc(month) + '</span></p>'
      : '<div class="cw-tag">🏆 The 2 AM Club · ' + esc(month) + ' winner</div>' +
        '<h2 class="cw-title" id="cw-title">Congratulations, <span class="cw-name">' + esc(w.name) + '</span>!</h2>' +
        '<p class="cw-sub">Winner of The 2 AM Club for <span class="cw-month">' + esc(month) + '</span></p>';
    // No prize money anywhere in the announcement.
    var body = combined
      ? '<div class="cw-cols cw-cols-' + people.length + '">' +
          people.map(function (p, i) {
            return '<div class="cw-col cw-col-p' + p.place + '">' +
              '<div class="cw-place cw-place-' + p.place + '">' + MEDAL[p.place] + ' ' + ORD[p.place] + ' place</div>' +
              (liCardHtml(p, i, month) || '<div class="cw-li cw-li-nameonly"><b>' + esc(p.name) + '</b></div>') +
              (p.linkedin_url ? '<a class="cw-col-link" href="' + escA(p.linkedin_url) + '" target="_blank" rel="noopener">View on LinkedIn ↗</a>' : '') +
            '</div>';
          }).join('') +
        '</div>' +
        (note ? '<div class="cw-col-note"><div class="cw-soon"><b>🏅 Still to come:</b> <span></span></div></div>' : '')
      : liCardHtml(first, 0, month);
    var cta = opts.cta && opts.cta.href ? '<a class="cw-btn cw-btn-cta" href="' + escA(opts.cta.href) + '"><span class="cw-cta-full">' + esc(opts.cta.text || 'See the free progress tracker') + '</span><span class="cw-cta-short">' + esc(opts.cta.short || 'Free tracker') + '</span> →</a>' : '';
    var m = document.createElement('div');
    m.id = 'club-winner-modal';
    m.className = 'cw-backdrop';
    m.innerHTML =
      '<div class="cw-card' + (combined ? ' cw-card-multi cw-card-n' + people.length : '') + '" role="dialog" aria-modal="true" aria-labelledby="cw-title">' +
        // Moon top-left mirrors the close button top-right: same size, same inset.
        '<button type="button" class="cw-close" aria-label="Close"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>' +
        '<span class="cw-moon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg></span>' +
        head + body +
        '<div class="cw-actions' + (cta ? ' has-cta' : '') + '">' +
          (!combined && w.linkedin_url ? '<a class="cw-btn cw-btn-li" href="' + escA(w.linkedin_url) + '" target="_blank" rel="noopener">View on LinkedIn ↗</a>' : '') +
          cta +
          '<button type="button" class="cw-btn cw-btn-close">Close</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    document.body.classList.add('club-winner-open');
    if (note) m.querySelector('.cw-soon span').textContent = note;
    Array.prototype.forEach.call(m.querySelectorAll('.cw-li[data-card]'), function (card) {
      var p = people[+card.getAttribute('data-card')];
      var textEl = card.querySelector('.cw-li-text');
      if (textEl) {
        // blank lines between paragraphs become single breaks, so the
        // preview shows real text instead of gaps
        textEl.textContent = String(p.linkedin_text).replace(/\r/g, '').replace(/\n\s*\n+/g, '\n');
        var more = card.querySelector('.cw-li-more');
        requestAnimationFrame(function () {
          var clamped = textEl.scrollHeight > textEl.clientHeight + 4;
          textEl.classList.toggle('is-clamped', clamped);
          if (more) more.hidden = !clamped;
        });
        if (more && more.tagName === 'BUTTON') more.addEventListener('click', function () {
          textEl.classList.remove('is-clamped'); textEl.classList.add('is-open'); more.hidden = true;
        });
      }
      var srcs = photosOf(p).map(function (ph) { return ph.src; });
      Array.prototype.forEach.call(card.querySelectorAll('.cw-li-frame'), function (b) {
        b.addEventListener('click', function () { openPhotos(srcs); });
      });
    });
    if (combined && isPhone()) setupDeck(m);
    m.querySelector('.cw-close').addEventListener('click', close);
    m.querySelector('.cw-btn-close').addEventListener('click', close);
    m.addEventListener('click', function (e) { if (e.target === m) close(); });
    keyHandler = function (e) {
      if (document.getElementById('cw-lightbox')) return; // the photo viewer handles its own keys
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', keyHandler);
    var closeBtn = m.querySelector('.cw-btn-close');
    if (closeBtn) closeBtn.focus({ preventScroll: true });
    // Fireworks and confetti together; the confetti cannons fire once the
    // first rockets have burst.
    setTimeout(fireworks, 250);
    setTimeout(confetti, 900);
    return true;
  }

  // ── Confetti: two bursts from the bottom corners ────────────────────
  // Real gravity and air drag, paper that flips and flutters as it falls, a
  // mix of rectangles, dots and thin streamers, and a fade at the end. Sharp
  // on retina, frame-rate independent, finite (removes its canvas). Skipped
  // under reduced motion.
  function confetti() {
    if (reduced()) return;
    var W = window.innerWidth, H = window.innerHeight;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:9999;pointer-events:none;';
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    var colors = ['#8B5CF6', '#A78BFA', '#FF7FB7', '#4D8BFF', '#FBBF24', '#34D399', '#FFFFFF'];
    var particles = [];
    var GRAVITY = 0.36, DRAG = 0.985, MAX_FALL = 3.2;
    function burst(fromLeft, count) {
      for (var i = 0; i < count; i++) {
        var spread = (Math.random() - 0.5) * 34;
        // Aim up and in, steeper on narrow screens so pieces don't fly out the sides.
        var tilt = Math.atan((W * 0.5) / (H * 0.9)) * 180 / Math.PI;
        var aim = fromLeft ? -(90 - tilt) : -(90 + tilt);
        var ang = (aim + spread) * Math.PI / 180;
        var speed = Math.sqrt(2 * GRAVITY * H * (0.55 + Math.random() * 0.35)) * 1.45;
        var r = Math.random();
        var shape = r < 0.62 ? 'rect' : (r < 0.82 ? 'dot' : 'strip');
        particles.push({
          x: fromLeft ? -10 : W + 10, y: H + 10,
          vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
          shape: shape,
          w: shape === 'strip' ? 3 : 7 + Math.random() * 5,
          h: shape === 'strip' ? 14 + Math.random() * 8 : 4 + Math.random() * 4,
          color: colors[Math.floor(Math.random() * colors.length)],
          rot: Math.random() * Math.PI * 2, vrot: (Math.random() - 0.5) * 0.3,
          flip: Math.random() * Math.PI * 2, vflip: 0.08 + Math.random() * 0.14,
          wob: Math.random() * Math.PI * 2, vwob: 0.05 + Math.random() * 0.06,
          life: 0, ttl: 3800 + Math.random() * 1600,
        });
      }
    }
    burst(true, 70); burst(false, 70);
    setTimeout(function () { burst(true, 35); burst(false, 35); }, 220);
    var last = null, start = null, MAX_DURATION = 7500;
    function frame(ts) {
      if (start === null) { start = ts; last = ts; }
      var dt = Math.min(3, (ts - last) / 16.67);
      last = ts;
      ctx.clearRect(0, 0, W, H);
      particles = particles.filter(function (p) { return p.life < p.ttl && p.y < H + 60; });
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.life += dt * 16.67;
        p.vx *= Math.pow(DRAG, dt);
        p.vy = Math.min(MAX_FALL, p.vy * Math.pow(DRAG, dt) + GRAVITY * dt);
        p.wob += p.vwob * dt;
        var falling = p.vy > 0;
        p.x += (p.vx + (falling ? Math.sin(p.wob) * 1.1 : 0)) * dt;
        p.y += p.vy * dt;
        p.rot += p.vrot * dt;
        p.flip += p.vflip * dt;
        var fadeIn = Math.min(1, p.life / 120);
        var fadeOut = Math.min(1, (p.ttl - p.life) / 700);
        ctx.globalAlpha = Math.max(0, Math.min(fadeIn, fadeOut));
        ctx.fillStyle = p.color;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        if (p.shape === 'dot') {
          ctx.beginPath();
          ctx.ellipse(0, 0, 3.2, 3.2 * Math.max(0.25, Math.abs(Math.cos(p.flip))), 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          var sy = Math.cos(p.flip); // paper turning over: thin when edge-on
          ctx.scale(1, Math.abs(sy) < 0.12 ? 0.12 : Math.abs(sy));
          if (sy < 0) ctx.globalAlpha *= 0.82;
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      if ((particles.length > 0 || ts - start < 400) && ts - start < MAX_DURATION) requestAnimationFrame(frame);
      else canvas.remove();
    }
    requestAnimationFrame(frame);
  }

  // ── Fireworks: gold rockets bursting into sparks, then golden stars ─
  function fireworks() {
    if (reduced()) return;
    var W = window.innerWidth, H = window.innerHeight;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:9999;pointer-events:none;';
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    var GOLDS = ['#FDE68A', '#FBBF24', '#F59E0B', '#FFF7D6', '#FFFFFF', '#FCD34D'];
    var rockets = [], sparks = [], stars = [];
    var small = W < 600;
    // Five rockets, alternating sides; on wide screens they burst either side of the popup.
    var plan = W >= 900
      ? [[0.15, 0.28, 0], [0.85, 0.22, 380], [0.5, 0.07, 760], [0.2, 0.55, 1250], [0.8, 0.5, 1650]]
      : [[0.22, 0.2, 0], [0.78, 0.16, 380], [0.5, 0.1, 760], [0.3, 0.3, 1250], [0.7, 0.26, 1650]];
    plan.forEach(function (q) {
      rockets.push({ x: W * q[0] + (Math.random() - 0.5) * 40, y: H + 10, tx: W * q[0], ty: H * q[1], delay: q[2], done: false, trail: [] });
    });
    function burst(x, y) {
      var n = small ? 46 : 70;
      for (var i = 0; i < n; i++) {
        var a = (i / n) * Math.PI * 2 + Math.random() * 0.15;
        var sp = (small ? 2.4 : 3.1) + Math.random() * (small ? 2.2 : 3);
        sparks.push({ x: x, y: y, px: x, py: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, ttl: 1100 + Math.random() * 800, color: GOLDS[Math.floor(Math.random() * GOLDS.length)], r: 2.2 + Math.random() * 1.6 });
      }
      sparks.push({ flash: true, x: x, y: y, life: 0, ttl: 380 });
    }
    var starCount = small ? 26 : 44;
    for (var j = 0; j < starCount; j++) {
      stars.push({ x: Math.random() * W, y: -30 - Math.random() * H * 0.6, vy: 0.9 + Math.random() * 1.3, sway: Math.random() * Math.PI * 2, vs: 0.02 + Math.random() * 0.03,
        rot: Math.random() * Math.PI, vrot: (Math.random() - 0.5) * 0.05, size: 5 + Math.random() * 6, delay: 500 + Math.random() * 1500, life: 0, ttl: 5200 + Math.random() * 1500,
        color: GOLDS[Math.floor(Math.random() * 3) + 1] });
    }
    function starPath(r) {
      ctx.beginPath();
      for (var k = 0; k < 10; k++) {
        var rr = k % 2 ? r * 0.45 : r, ang = -Math.PI / 2 + k * Math.PI / 5;
        ctx[k ? 'lineTo' : 'moveTo'](Math.cos(ang) * rr, Math.sin(ang) * rr);
      }
      ctx.closePath();
    }
    var start = null, last = null, MAX = 8500;
    function frame(ts) {
      if (start === null) { start = ts; last = ts; }
      var t = ts - start, dt = Math.min(3, (ts - last) / 16.67), ms = dt * 16.67;
      last = ts;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      rockets.forEach(function (r) {
        if (r.done || t < r.delay) return;
        var dy = r.ty - r.y;
        r.y += dy * 0.075 * dt - 2.2 * dt;
        r.x += (r.tx - r.x) * 0.06 * dt;
        r.trail.push([r.x, r.y]); if (r.trail.length > 10) r.trail.shift();
        for (var i = 0; i < r.trail.length; i++) {
          ctx.globalAlpha = (i / r.trail.length) * 0.8;
          ctx.fillStyle = '#FDE68A';
          ctx.beginPath(); ctx.arc(r.trail[i][0], r.trail[i][1], 1.8, 0, Math.PI * 2); ctx.fill();
        }
        if (r.y <= r.ty + 4) { r.done = true; burst(r.x, r.y); }
      });
      sparks = sparks.filter(function (p) { return p.life < p.ttl; });
      sparks.forEach(function (p) {
        p.life += ms;
        var k = 1 - p.life / p.ttl;
        if (p.flash) {
          var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 60);
          g.addColorStop(0, 'rgba(255,240,200,' + (0.55 * k) + ')'); g.addColorStop(1, 'rgba(255,200,80,0)');
          ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, 60, 0, Math.PI * 2); ctx.fill();
          return;
        }
        p.px = p.x; p.py = p.y;
        p.vx *= Math.pow(0.965, dt); p.vy = p.vy * Math.pow(0.965, dt) + 0.045 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        ctx.globalAlpha = Math.max(0, Math.min(1, k * 1.4));
        ctx.strokeStyle = p.color; ctx.lineWidth = p.r; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(p.px - p.vx * 4.5, p.py - p.vy * 4.5); ctx.lineTo(p.x, p.y); ctx.stroke();
        if (k < 0.35 && Math.random() < 0.3) { ctx.fillStyle = '#FFFFFF'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 0.9, 0, Math.PI * 2); ctx.fill(); }
      });
      ctx.globalCompositeOperation = 'source-over';
      stars = stars.filter(function (st) { return st.life < st.ttl && st.y < H + 30; });
      stars.forEach(function (st) {
        if (t < st.delay) return;
        st.life += ms;
        st.sway += st.vs * dt; st.rot += st.vrot * dt;
        st.y += st.vy * dt; st.x += Math.sin(st.sway) * 0.6 * dt;
        var fade = Math.min(1, st.life / 300, (st.ttl - st.life) / 800);
        ctx.globalAlpha = Math.max(0, fade);
        ctx.save(); ctx.translate(st.x, st.y); ctx.rotate(st.rot);
        ctx.shadowColor = 'rgba(251,191,36,0.8)'; ctx.shadowBlur = 8;
        ctx.fillStyle = st.color; starPath(st.size); ctx.fill();
        ctx.restore();
      });
      ctx.globalAlpha = 1;
      var busy = rockets.some(function (r) { return !r.done; }) || sparks.length || stars.length;
      if (busy && t < MAX) requestAnimationFrame(frame); else canvas.remove();
    }
    requestAnimationFrame(frame);
  }

  window.TAAIClub = { show: show, close: close, confetti: confetti, fireworks: fireworks };

  // ── Sales pages: show it once to someone who hasn't seen it ─────────
  var me = document.currentScript;
  if (!me || !me.hasAttribute('data-auto')) return;
  function seenAnywhere(key) {
    try { return ['list', 'focus', 'site'].some(function (k) { return localStorage.getItem(SEEN + key + ':' + k) === '1'; }); } catch (e) { return true; }
  }
  // Don't open on top of another dialog (enrol notes, the challenge form,
  // the mobile menu) or while the tab is hidden; try again shortly.
  function pageBusy() {
    if (document.hidden) return true;
    if (document.querySelector('.mobile-menu.open')) return true;
    var dlg = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
    for (var i = 0; i < dlg.length; i++) {
      var d = dlg[i];
      if (d.getClientRects().length && getComputedStyle(d).visibility !== 'hidden' && getComputedStyle(d).display !== 'none') return true;
    }
    return false;
  }
  var cta = { href: '/gate-da-progress-tracker', text: 'See the free progress tracker', short: 'Free tracker' };
  function whenFree(fn, tries) {
    if (!pageBusy()) return fn();
    if ((tries || 0) < 24) setTimeout(function () { whenFree(fn, (tries || 0) + 1); }, 5000);
  }
  function start() {
    var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    // Local preview: ?winner-preview shows what /team has saved (netlify dev
    // lets the admin endpoints through), switched on or not.
    if (isLocal && /[?&]winner-preview\b/.test(location.search)) {
      Promise.all([
        fetch('/api/team-club-winner').then(function (r) { return r.ok ? r.json() : {}; }),
        fetch('/api/team-club-winner?slot=runners').then(function (r) { return r.ok ? r.json() : {}; }),
      ]).then(function (res) {
        if (res[0] && res[0].winner) setTimeout(function () { show(res[0].winner, res[1] && res[1].runners, { cta: cta }); }, 1200);
      }).catch(function () {});
      return;
    }
    fetch('/api/club-winner-public').then(function (r) { return r.ok ? r.json() : { active: false }; }).then(function (meta) {
      if (!meta || !meta.active || seenAnywhere(meta.key)) return;
      return Promise.all([
        fetch('/api/club-winner-public?full=1').then(function (r) { return r.json(); }),
        meta.runners ? fetch('/api/club-winner-public?full=1&kind=runners').then(function (r) { return r.json(); }).catch(function () { return null; }) : null,
      ]).then(function (res) {
        if (!res[0] || !res[0].winner) return;
        // a few seconds in, so the page itself is seen first
        setTimeout(function () {
          whenFree(function () {
            if (seenAnywhere(meta.key)) return;
            if (show(res[0].winner, res[1] && res[1].runners, { cta: cta })) {
              try { localStorage.setItem(SEEN + meta.key + ':site', '1'); } catch (e) { /* fine */ }
            }
          });
        }, 6000);
      });
    }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
