(function () {
  'use strict';

  // Confirmed official GATE DA 2027 exam date.
  var EXAM_DATE = '2027-02-06';

  // Day 1 of the 180-day program — same Aug 1 start as the schedule
  // itself (DEMO_TODAY_FLOOR/SCHEDULE_START_MONTH below), for the "X/180
  // days" badge on the main checklist page.
  var PROGRAM_START_DATE = '2026-08-01';
  var PROGRAM_LENGTH_DAYS = 180;

  // Launch floor — the schedule starts Aug 1, so "today" (and the default
  // opening month) is clamped up to Aug 1 for anyone visiting before then,
  // instead of showing a real "today" with nothing scheduled yet. Self-
  // expiring: once the real date reaches Aug 1, max() has no effect and
  // this stops doing anything — remove this block after 2026-08-01 rather
  // than leaving a permanently-clamped date behind. Declared this early
  // (not next to todayIso() below) because state's initializer calls
  // currentMonthStr() -> todayIso() immediately, before that point in the
  // file would otherwise have run.
  var DEMO_TODAY_FLOOR = '2026-08-01';

  // Earliest month with any schedule content — unlike DEMO_TODAY_FLOOR
  // above, this doesn't self-expire with the real date; July has no data
  // and never will, so month-nav's "previous" arrow stays disabled on
  // this month regardless of what today's date is.
  var SCHEDULE_START_MONTH = '2026-08';

  var COOKIE_NAME = 'taai_user';
  var COOKIE_DAYS = 365;

  // Full GATE DA syllabus — shown in "Progress by subject" even before a
  // schedule for that subject has been uploaded (0% until then). "AI" is
  // deliberately separate from "AI (Logic)" — Logic is just the portion
  // of AI already scheduled, not the whole subject, so they're two
  // distinct rows, not one to merge. Names that already appear in real
  // schedule data ("Linear Algebra") match that data's exact spelling so
  // they merge into one row instead of duplicating; the rest are
  // best-guess names — if a future month's sheet uses a different header
  // for one of these, it'll show up as an extra row until the names match.
  var CANONICAL_SUBJECTS = [
    'Linear Algebra', 'Probability', 'Statistics', 'Calculus',
    'Machine Learning', 'AI', 'DBMS', 'Python', 'Data Structures', 'Algorithms',
  ];

  // ── Pomodoro timer (Focus Mode only) ──────────────────────────────
  var POMO_SETTINGS_KEY = 'taai_pomo_settings';
  var DEFAULT_POMO_SETTINGS = { work: 25, shortBreak: 5, longBreak: 15, cycle: 4 };
  var POMO_RING_R = 90;
  var POMO_RING_CIRCUMFERENCE = 2 * Math.PI * POMO_RING_R;

  function clampMinutes(val, fallback, min, max) {
    var n = Number(val);
    if (!isFinite(n) || n < min || n > max) return fallback;
    return Math.round(n);
  }

  function loadPomoSettings() {
    try {
      var raw = localStorage.getItem(POMO_SETTINGS_KEY);
      if (!raw) return Object.assign({}, DEFAULT_POMO_SETTINGS);
      var parsed = JSON.parse(raw);
      return {
        work: clampMinutes(parsed.work, DEFAULT_POMO_SETTINGS.work, 1, 180),
        shortBreak: clampMinutes(parsed.shortBreak, DEFAULT_POMO_SETTINGS.shortBreak, 1, 60),
        longBreak: clampMinutes(parsed.longBreak, DEFAULT_POMO_SETTINGS.longBreak, 1, 90),
        cycle: clampMinutes(parsed.cycle, DEFAULT_POMO_SETTINGS.cycle, 1, 12),
      };
    } catch (e) { return Object.assign({}, DEFAULT_POMO_SETTINGS); }
  }

  function savePomoSettings() {
    localStorage.setItem(POMO_SETTINGS_KEY, JSON.stringify(pomoSettings));
  }

  var pomoSettings = loadPomoSettings();

  // Persists the *currently running/paused* timer itself (not the saved
  // duration settings above) — so a refresh mid-session doesn't silently
  // discard the countdown back to a fresh 25:00. Deliberately keyed
  // separately from pomoSettings since this is transient session state,
  // not a preference. While running, phaseEndAt (a wall-clock deadline) is
  // the authoritative field on restore — the same reasoning as the
  // background-tab-throttling fix, recomputing real elapsed time rather
  // than trusting a stale secondsLeft snapshot. While paused, secondsLeft
  // is authoritative instead, since there's no ticking deadline to measure
  // against. completedSessions is included too, mainly so a guest (who has
  // no server-side sync for this) doesn't lose today's count on refresh
  // either — a student's is already covered by loadMonth's Math.max merge,
  // but persisting it here doesn't conflict with that.
  var POMO_ACTIVE_KEY = 'taai_pomo_active';
  // Tracks the freshness (epoch ms) of whatever's currently applied to
  // `pomo`, whether it came from this device's own localStorage or a sync
  // from the server (see applyPomoActiveState/loadMonth) — lets the
  // cross-device reconciliation below tell "the server has something
  // newer than what I already have" apart from "the server's write from
  // my OWN last action just hasn't landed yet," without which a slightly
  // stale response arriving right after a fresh local click could
  // overwrite it with old data.
  var pomoStateAsOf = 0;
  function buildPomoActivePayload() {
    return {
      mode: pomo.mode,
      running: pomo.running,
      secondsLeft: pomo.secondsLeft,
      totalSeconds: pomo.totalSeconds,
      phaseEndAt: pomo.phaseEndAt,
      completedSessions: pomo.completedSessions,
      savedAt: Date.now(),
    };
  }
  // Local-only half of persistence — no network call. Used by
  // applyPomoActiveState too (see below), including for state that just
  // arrived FROM the server, where posting it straight back would be a
  // pointless network round-trip for data the server already has.
  function savePomoActiveLocalOnly() {
    var payload = buildPomoActivePayload();
    pomoStateAsOf = payload.savedAt;
    try {
      localStorage.setItem(POMO_ACTIVE_KEY, JSON.stringify(payload));
    } catch (e) { /* localStorage unavailable — refresh just won't resume, not critical */ }
    return payload;
  }
  function savePomoActiveState() {
    savePomoActiveRemote(savePomoActiveLocalOnly());
  }
  function loadPomoActiveState() {
    try {
      var raw = localStorage.getItem(POMO_ACTIVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  // Cross-device counterpart to the localStorage write above — see
  // pomo-active.js. Fire-and-forget: a lost write just means another
  // device's view of this session goes stale until the next successful
  // one, not that anything breaks on this device. Guests have no server
  // identity to sync against, so this is a no-op for them, same guard
  // used elsewhere (e.g. recordPomodoroCompletion).
  function savePomoActiveRemote(payload) {
    if (!state.student) return;
    api('/pomo-active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: state.student.email,
        mode: payload.mode,
        running: payload.running,
        secondsLeft: payload.secondsLeft,
        totalSeconds: payload.totalSeconds,
        phaseEndAt: payload.phaseEndAt,
        completedSessions: payload.completedSessions,
      }),
    }).catch(function () { /* non-critical — see comment above */ });
  }

  // Notifications are mandatory to use the Focus Timer at all (not just an
  // opt-in extra) — mainly a Safari fallback: WebKit blocks a webpage from
  // starting *new* audio from an unattended timer (only audio started
  // synchronously inside a real click/tap is allowed), so the chime alone
  // is unreliable there no matter how the AudioContext is managed. A
  // Notification isn't subject to that same audio-autoplay rule, so
  // requiring it up front guarantees every student actually gets alerted
  // when a phase ends, not just the ones who happen to have the tab
  // focused. renderPomodoro() gates the whole card on this — no Start
  // button exists at all until it returns 'granted'. Deliberately no
  // "unsupported browser" exception: a browser with no Notification API at
  // all (e.g. iOS Safari outside an installed home-screen app) simply
  // can't use the Focus Timer, by explicit choice, not oversight.
  function pomoNotifyState() {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission; // 'default' | 'denied' | 'granted'
  }

  // Created lazily, only inside a real click handler (see pomoToggleRun) —
  // browsers auto-suspend an AudioContext instantiated outside a genuine
  // user gesture, and a chime fired later from setInterval doesn't count as
  // one, so a fresh `new AudioContext()` per tick silently never plays.
  // Reusing one context created at Start-click time and resuming it avoids
  // that.
  var pomoAudioCtx = null;

  var pomo = {
    mode: 'work', // 'work' | 'break'
    secondsLeft: pomoSettings.work * 60,
    totalSeconds: pomoSettings.work * 60,
    running: false,
    timerId: null,
    completedSessions: 0,
    // Wall-clock deadline (Date.now() + secondsLeft*1000) set whenever the
    // timer starts/resumes. pomoTick derives secondsLeft from this rather
    // than decrementing per-tick, because background tabs get their
    // setInterval throttled (Chrome clamps a hidden tab's timers to ~once/
    // minute after it's been backgrounded a while) — a pure decrement would
    // silently fall behind real elapsed time whenever the student switches
    // tabs. Deriving from a deadline means whatever tick eventually does
    // fire always reports the true remaining time.
    phaseEndAt: null,
  };

  var app = document.getElementById('app');
  var state = {
    student: null,
    month: currentMonthStr(),
    days: [], // [{ date, tasks: [{subject, task_text, position, completed}] }]
    latestScheduledMonth: null, // 'YYYY-MM' with any schedule data at all, from schedule.js — caps month-nav's "next" arrow
    lastWeekLeaders: [], // [{ display_name, total_minutes, is_me }] — top 5 by focus minutes last week, shown outside Focus Mode
    lastWeekViewerRank: null, // { rank, total_minutes } — set only when the viewer isn't in that top 5
    streak: null,
    subjectProgress: [], // [{ subject, done, total }] — global, independent of viewed month
    expanded: new Set(), // dates whose day-card is open, non-native accordion
    collapsedWeeks: new Set(), // week keys (Monday date) currently collapsed
    initializedWeeks: new Set(), // week keys already given their one-time default collapse state
    // Starts false on every fresh visit/navigation — a real browser reload
    // while already in Focus Mode is the one case that restores it (see
    // FOCUS_ACTIVE_KEY / init() below), not this initial value.
    focus: false,
    leaderboard: [], // [{ display_name, total_minutes, total_sessions }] — Focus Mode only
    viewerRank: null, // { rank, total_minutes, total_sessions } — set only when the viewer is logged in but didn't make the top 20
    renaming: false, // showing the inline rename form in place of the name + Rename/Not you? line
    renameError: null,
    pomoBlockedReason: null, // null | 'denied' | 'unsupported' — set when Start needed notification permission and didn't get it
  };

  // Set when a signed-out visitor tries to check a task — captured so
  // registration can complete it automatically instead of the tick being
  // silently dropped once they're signed in.
  var pendingTask = null;

  // Same idea, for a guest clicking "Focus mode" — captured so registration
  // can drop them straight into Focus Mode afterward instead of just back
  // on the main checklist.
  var pendingFocusMode = false;

  // No cookie just means browsing as a guest, not "show the login screen" —
  // the schedule itself (schedule.js) needs no email, so anyone can view and
  // navigate the roadmap. Only actions tied to a specific student (ticking a
  // task) require signing in, prompted at the point of that action.
  // Applies a saved { mode, running, secondsLeft, totalSeconds, phaseEndAt,
  // completedSessions } blob to the live pomo object and, if it was
  // running, (re)starts the interval — shared by two callers: the
  // synchronous localStorage restore at init() (instant, same-device,
  // works for guests too since it needs no server round-trip) and the
  // async cross-device reconciliation once tracker-data resolves (see
  // loadMonth) for a session that was started on a different browser/
  // device. Deliberately restarts the interval right here regardless of
  // whether Focus Mode happens to be open — so the timer keeps counting
  // down, completing phases, and crediting sessions in the background
  // exactly as if nothing had happened; Focus Mode just displays whatever
  // it finds whenever it's next opened. One limitation that can't be
  // worked around: the chime needs a fresh user gesture to unlock audio
  // (see ensurePomoAudioCtx), which neither a page load nor a background
  // sync provides, so a phase that completes before the next click will
  // only notify, not chime — the notification is what's mandatory instead.
  function applyPomoActiveState(saved) {
    if (!saved) return;
    if (pomo.timerId) clearInterval(pomo.timerId);
    pomo.mode = saved.mode;
    pomo.totalSeconds = saved.totalSeconds;
    // Math.max, not a straight overwrite — the cross-device reconciliation
    // call can run after this device has already advanced further (e.g.
    // completed another session while the sync from elsewhere was still in
    // flight), and a lower count from that stale response shouldn't erase
    // progress this device already knows really happened.
    pomo.completedSessions = Math.max(pomo.completedSessions, saved.completedSessions || 0);
    if (saved.running) {
      pomo.phaseEndAt = saved.phaseEndAt;
      pomo.running = true;
      pomoTick(); // catches up immediately if time already ran out while away
      if (pomo.running) pomo.timerId = setInterval(pomoTick, 1000);
    } else {
      pomo.secondsLeft = saved.secondsLeft;
      pomo.running = false;
    }
    // Real bug, caught before shipping: without this, adopting a session
    // from the server (see loadMonth's reconciliation) updated the live
    // `pomo` object and the on-screen display for this page view only —
    // nothing actually persisted it back to localStorage, so a same-device
    // reload right after found nothing locally and flickered back to a
    // blank/default state until the network reconciliation ran again. This
    // also correctly bumps pomoStateAsOf to now regardless of which
    // caller this is — for the local-restore-from-localStorage path
    // that's a harmless no-op re-save of identical data; for the
    // cross-device path it's what makes this device the freshest known
    // copy going forward.
    savePomoActiveLocalOnly();
    updatePomoDisplay();
  }

  function restorePomoActiveState() {
    applyPomoActiveState(loadPomoActiveState());
  }

  // Focus Mode is intentionally NOT restored on a fresh visit or a real
  // navigation (typing the URL, clicking "Progress Tracker" in the nav,
  // even to this exact same page) — those should always land on the main
  // checklist. The one exception a student actually wants is refreshing
  // the page while already inside Focus Mode (F5/Cmd+R) — they're
  // mid-session, not starting fresh.
  //
  // history.state alone can't tell these apart: Chromium reuses/preserves
  // the current session-history entry (and its pushState'd state) not just
  // for an actual reload, but also for a fresh navigation to the exact
  // same URL — confirmed empirically, not assumed. The Navigation Timing
  // API's entry type is the one signal that's specific to the real reload
  // action (F5/Cmd+R/the reload button) versus any other navigation cause,
  // so that's paired with a small localStorage flag (set/cleared wherever
  // state.focus actually changes — see enterFocus/exitFocus/popstate below)
  // to know *whether* a reload should restore Focus Mode at all.
  var FOCUS_ACTIVE_KEY = 'taai_focus_active';
  function saveFocusActive(active) {
    try {
      if (active) localStorage.setItem(FOCUS_ACTIVE_KEY, '1');
      else localStorage.removeItem(FOCUS_ACTIVE_KEY);
    } catch (e) { /* localStorage unavailable — reload just won't restore Focus Mode, not critical */ }
  }
  function loadFocusActive() {
    try { return localStorage.getItem(FOCUS_ACTIVE_KEY) === '1'; } catch (e) { return false; }
  }
  function wasHardReload() {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      return !!nav && nav.type === 'reload';
    } catch (e) { return false; }
  }

  function init() {
    state.student = readCookie();
    restorePomoActiveState();
    loadMonth(state.month);
    if (wasHardReload() && loadFocusActive()) {
      state.focus = true;
      // replaceState, not enterFocus()'s pushState — a correct {focus:true}
      // entry already exists from before the reload (reload re-executes
      // the current entry in place, it doesn't create a new one), so
      // pushing another on top would leave a stale duplicate behind that
      // the Back button would land on instead of truly exiting Focus Mode.
      history.replaceState({ focus: true }, '');
      refreshLeaderboard();
      startLeaderboardTimerTick();
      startLeaderboardPoll();
    }
  }

  // ── Scroll progress + back-to-top — same pattern as blog.js ──────────
  function setupScrollEffects() {
    var bar = document.getElementById('scroll-progress-bar');
    function updateProgress() {
      if (!bar) return;
      var total = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = (total > 0 ? (window.scrollY / total) * 100 : 0) + '%';
    }
    window.addEventListener('scroll', updateProgress, { passive: true });
    updateProgress();

    var backToTop = document.getElementById('back-to-top');
    if (backToTop) {
      window.addEventListener('scroll', function () {
        backToTop.classList.toggle('visible', window.scrollY > 400);
      }, { passive: true });
      backToTop.addEventListener('click', function () {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  }

  // Fade-in reveal — content is swapped via innerHTML on every render, so
  // re-observe the current .fade-in elements each time rather than once.
  var fadeObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        fadeObserver.unobserve(e.target);
      }
    });
  }, { threshold: 0.05, rootMargin: '0px 0px -40px 0px' });
  function observeFadeIns() {
    Array.prototype.forEach.call(document.querySelectorAll('.fade-in:not(.visible)'), function (el) {
      fadeObserver.observe(el);
    });
  }

  // ── Leaderboard confetti — once per student per week, only for someone
  // who actually placed (appears in the top list or has a viewerRank),
  // and only once the relevant card is actually scrolled into view rather
  // than the instant it's rendered. The top-20 card in particular is
  // nested inside Focus Mode and often below the fold on open ("a bit
  // scroll down away") — firing on render would frequently fire on an
  // invisible element nobody's looking at yet. Self-contained Canvas2D,
  // not a library — a brief, finite burst that cancels its own rAF loop
  // and removes its canvas when done, not the continuous-ticker pattern
  // CLAUDE.md flags as expensive (DotField's zero-dependency, no-external-
  // ticker approach is the one already proven cheap in this codebase).
  var CONFETTI_KEY_PREFIX = 'taai_confetti_shown_';
  function confettiAlreadyShown(key) {
    try { return localStorage.getItem(CONFETTI_KEY_PREFIX + key) === '1'; }
    catch (e) { return true; } // localStorage unavailable — fail toward "don't spam", not "always fire"
  }
  function markConfettiShown(key) {
    try { localStorage.setItem(CONFETTI_KEY_PREFIX + key, '1'); } catch (e) { /* non-critical */ }
  }

  function fireConfetti() {
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;z-index:9999;pointer-events:none;';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var colors = ['#8B5CF6', '#FF7FB7', '#4D8BFF', '#FBBF24', '#34D399'];
    var particles = [];
    for (var i = 0; i < 140; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: -20 - Math.random() * canvas.height * 0.3,
        w: 6 + Math.random() * 5,
        h: 4 + Math.random() * 4,
        color: colors[i % colors.length],
        vy: 2.5 + Math.random() * 3,
        vx: (Math.random() - 0.5) * 2.5,
        rot: Math.random() * 360,
        vrot: (Math.random() - 0.5) * 14,
      });
    }
    var start = null;
    // A flat duration doesn't account for how far a particle actually needs
    // to fall — real bug, confirmed visually: at vy 2.5-5.5px/frame, a lot
    // of particles were nowhere near the bottom of the screen yet at a
    // fixed 2.6s cutoff, so they got yanked away mid-fall instead of
    // finishing naturally. Each particle now exits (is dropped from the
    // array) only once it's actually below the viewport; MAX_DURATION is
    // just a safety cap in case a stray particle's vy/start position would
    // otherwise keep this running unreasonably long.
    var MAX_DURATION = 6000;
    function frame(ts) {
      if (!start) start = ts;
      var elapsed = ts - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles = particles.filter(function (p) { return p.y < canvas.height + 30; });
      particles.forEach(function (p) {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vrot;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rot * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      if (particles.length > 0 && elapsed < MAX_DURATION) {
        requestAnimationFrame(frame);
      } else {
        canvas.remove(); // finite burst — no lingering ticker, unlike the effects CLAUDE.md warns about
      }
    }
    requestAnimationFrame(frame);
  }

  // threshold: 0 — fires the moment ANY part of the card is visible, not
  // once a percentage of it is. Real bug, caught in testing: an earlier
  // 0.4 (40%) threshold was too strict for the top-20 card, which can be
  // quite tall (20 rows + a "You" row) — confirmed directly, right after
  // a fresh Start->completion cycle the card was only ~3% visible at the
  // moment it got observed (scrolling a tall element "into view" often
  // only clears its top edge, not 40% of its full height), so
  // isIntersecting correctly evaluated false and confetti silently never
  // fired even though the student had just earned it and was looking at
  // the screen. Tried matching fadeObserver's 0.05 next, but that's still
  // uncomfortably close to the 0.03 ratio actually measured — 0 is the
  // only threshold that can't have this same problem for an element of
  // any height.
  var confettiObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      confettiObserver.unobserve(e.target);
      var key = e.target.dataset.confettiKey;
      if (key && !confettiAlreadyShown(key)) {
        fireConfetti();
        markConfettiShown(key);
      }
    });
  }, { threshold: 0 });

  // Arms confetti for one element if the student actually has something
  // to celebrate — never for an empty/no-placement card. weekKey scopes
  // the "already shown" flag to the current week (Monday-start, IST-
  // equivalent via mondayOf/todayIso, same convention used everywhere
  // else in this file) so it naturally re-arms every Monday without a
  // separate reset mechanism.
  // key is passed in directly (not built from a scope here) so callers can
  // choose weekly-scoped keys (leaderboards, reset every Monday) or a
  // permanent one (the first-ever streak celebration — see below).
  function armConfetti(elementId, key, hasPlacement) {
    if (!hasPlacement) return;
    var el = document.getElementById(elementId);
    if (!el) return;
    if (confettiAlreadyShown(key)) return;
    el.dataset.confettiKey = key;
    confettiObserver.observe(el);
  }

  // ── "NEW" badge — a general "this leaderboard just refreshed" signal,
  // unlike confetti it's for every viewer, not only students who placed
  // (someone who didn't place this week still benefits from noticing the
  // list changed).
  //
  // Visibility is purely a function of calendar date, not "have you
  // dwelled on this card yet" — shows for the entire day it was first
  // encountered (any number of reloads that same day still show it),
  // then stops appearing from the next calendar day onward, still within
  // the same week. Originally dismissed after ~1.2s of continuous
  // visibility instead, but that was too fleeting — a single glance
  // shouldn't use up the only chance to notice it. Computed directly at
  // render time (no IntersectionObserver/dwell-timer machinery needed
  // anymore, unlike confetti which genuinely needs to know when a card
  // scrolls into view) since presence only depends on two localStorage
  // reads, both knowable immediately.
  var NEW_BADGE_KEY_PREFIX = 'taai_leaderboard_first_seen_';
  // Split from the HTML-building step below so callers can also use the
  // same true/false to reserve layout space for the badge on
  // .leaderboard-title (see the has-badge class at each call site) —
  // computed once and reused, rather than checking (and re-triggering the
  // "mark as shown" side effect) twice for one render.
  function newBadgeVisible(scope) {
    var key = scope + '-' + mondayOf(todayIso());
    var today = todayIso();
    var firstSeenDate = null;
    try { firstSeenDate = localStorage.getItem(NEW_BADGE_KEY_PREFIX + key); } catch (e) { /* localStorage unavailable — badge just won't show, not critical */ }
    if (firstSeenDate && firstSeenDate !== today) return false; // already had its day, some earlier day this week
    if (!firstSeenDate) {
      try { localStorage.setItem(NEW_BADGE_KEY_PREFIX + key, today); } catch (e) { /* non-critical */ }
    }
    return true;
  }
  function newBadgeHtml(visible) {
    return visible ? ' <span class="new-badge-wrap"><span class="new-badge">New</span></span>' : '';
  }

  // ── Cookie helpers ──────────────────────────────────────────────────
  function b64Encode(str) { return btoa(unescape(encodeURIComponent(str))); }
  function b64Decode(str) { return decodeURIComponent(escape(atob(str))); }

  function readCookie() {
    var match = document.cookie.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]*)'));
    if (!match) return null;
    try {
      return JSON.parse(b64Decode(decodeURIComponent(match[1])));
    } catch (e) {
      return null;
    }
  }

  function writeCookie(student) {
    var value = encodeURIComponent(b64Encode(JSON.stringify(student)));
    var expires = new Date(Date.now() + COOKIE_DAYS * 864e5).toUTCString();
    document.cookie = COOKIE_NAME + '=' + value + '; expires=' + expires + '; path=/; SameSite=Lax';
  }

  function clearCookie() {
    document.cookie = COOKIE_NAME + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax';
  }

  // ── Date helpers ────────────────────────────────────────────────────
  function pad(n) { return String(n).padStart(2, '0'); }
  // Postgres `timestamp` (no timezone) columns — like pomo_active_
  // session.updated_at, relayed straight through tracker-data.js as
  // remoteActive.updatedAt below — come back with no trailing "Z" (the
  // column has no tz info to include), even though they were written as
  // genuine UTC (`.toISOString()` server-side). Plain `new Date(...)`
  // treats a timezone-less string as local time to whatever device
  // parses it — for this site's IST audience, that silently shifted a
  // genuinely-newer cross-device session 5.5 hours into the past,
  // making it look older than the local state and never getting
  // adopted. Confirmed as a real, live bug (not just theoretical) while
  // investigating a "last seen 6h ago" that should have said minutes —
  // same fix as parseUtcTimestamp in netlify/functions/lib/supabase.js.
  function parseUtcTimestamp(pgTimestamp) {
    return new Date(pgTimestamp.charAt(pgTimestamp.length - 1) === 'Z' ? pgTimestamp : pgTimestamp + 'Z');
  }
  // The actual calendar date, never floored — for anything that should
  // keep ticking every real day regardless of the schedule's Aug-1 start
  // (the exam countdown; todayIso() below is deliberately NOT this, since
  // the calendar/streak genuinely need the floor).
  function realTodayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function todayIso() {
    var real = realTodayIso();
    return real > DEMO_TODAY_FLOOR ? real : DEMO_TODAY_FLOOR;
  }
  function currentMonthStr() {
    return todayIso().slice(0, 7);
  }
  function shiftMonth(monthStr, delta) {
    var parts = monthStr.split('-').map(Number);
    var d = new Date(parts[0], parts[1] - 1 + delta, 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }
  function monthLabel(monthStr) {
    var parts = monthStr.split('-').map(Number);
    var d = new Date(parts[0], parts[1] - 1, 1);
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  function dayLabel(dateStr) {
    var d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function mondayOf(dateStr) {
    var d = new Date(dateStr + 'T00:00:00');
    var day = d.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // ── API ─────────────────────────────────────────────────────────────
  function api(path, opts) {
    return fetch('/api' + path, opts).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || 'request failed');
        return data;
      });
    });
  }

  function refreshStreak() {
    return api('/streak?email=' + encodeURIComponent(state.student.email))
      .then(function (r) {
        var changed = state.streak !== null && r.streak !== state.streak;
        state.streak = r.streak;
        // The task-toggle path to a first-ever streak of 1 — the initial
        // page-load arming in renderCalendar only catches the case where
        // the student already had a streak of 1 when the page loaded, not
        // a toggle that makes it 1 during this same session. #streak-panel
        // itself isn't re-rendered here (only #streak-number's text is,
        // below), so it's still the same DOM node armConfetti already
        // knows about if this fires a second time — harmless no-op via
        // confettiAlreadyShown once it's actually fired once.
        armConfetti('streak-panel', 'first-streak', state.streak === 1);
        var el = document.getElementById('streak-number');
        if (!el) return;
        el.textContent = state.streak;
        if (changed) {
          // Restart the bump animation even if it's already mid-run from a
          // rapid previous toggle — force a reflow between remove/add so
          // the browser treats it as a fresh animation, not a no-op.
          el.classList.remove('bump');
          void el.offsetWidth;
          el.classList.add('bump');
        }
      })
      .catch(function () { /* non-critical — leave last known value on screen */ });
  }

  // ── Registration ────────────────────────────────────────────────────
  function renderRegisterForm(errorMsg) {
    var hasPending = pendingTask || pendingFocusMode;
    var promptText = pendingTask
      ? 'Sign up to save your progress. It only takes a few seconds.'
      : pendingFocusMode
        ? 'Sign up to use Focus Mode. It only takes a few seconds.'
        : 'Enter your details once. We’ll remember you on this browser.';
    app.innerHTML =
      '<div class="reg-card fade-in">' +
      '<h1>TAAI BATCH C - MISSION IIT <span class="roadmap-emoji">🎯</span></h1>' +
      '<p>' + promptText + '</p>' +
      '<form id="reg-form">' +
      '<div class="reg-field"><label for="reg-email">Your email</label>' +
      '<input id="reg-email" type="email" required autocomplete="email"></div>' +
      '<div class="reg-field"><label for="reg-name">Your display name</label>' +
      '<input id="reg-name" type="text" required autocomplete="name"></div>' +
      (errorMsg ? '<p class="form-error">' + escapeHtml(errorMsg) + '</p>' : '') +
      '<button class="btn-primary" type="submit">Start Tracking</button>' +
      (hasPending ? '<button type="button" class="reg-cancel-link" id="reg-cancel">← Keep browsing without an account</button>' : '') +
      '</form></div>';

    document.getElementById('reg-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = e.target.querySelector('button');
      var email = document.getElementById('reg-email').value.trim();
      var name = document.getElementById('reg-name').value.trim();
      btn.disabled = true;
      btn.textContent = 'Starting…';
      api('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, display_name: name }),
      })
        .then(function (student) {
          writeCookie(student);
          state.student = student;
          var task = pendingTask;
          pendingTask = null;
          var wantsFocus = pendingFocusMode;
          pendingFocusMode = false;
          if (task) {
            api('/complete-task', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: student.email, date: task.date, subject: task.subject, task_text: task.task_text, completed: task.completed }),
            })
              .catch(function () { /* non-critical — task just won't be pre-ticked */ })
              .then(function () { loadMonth(state.month); });
          } else {
            loadMonth(state.month);
          }
          // Renders immediately using whatever schedule data is already
          // loaded from browsing as a guest — loadMonth's own renderCalendar
          // (once its fetch resolves) will refresh it again with the
          // now-available streak/settings, still in focus mode since
          // state.focus is already true by then.
          if (wantsFocus) enterFocus();
        })
        .catch(function (err) {
          renderRegisterForm(err.message);
        });
    });

    var cancelBtn = document.getElementById('reg-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function () {
      pendingTask = null;
      pendingFocusMode = false;
      renderCalendar();
    });

    observeFadeIns();
  }

  // ── Calendar ────────────────────────────────────────────────────────
  function loadMonth(monthStr) {
    state.month = monthStr;
    app.innerHTML = '<p class="center-note">Loading your roadmap…</p>';

    // Guests (no student yet) only need the public schedule/leaders piece —
    // tracker-data.js omits the per-student pieces server-side when email
    // is absent, same effective behavior as before when those endpoints
    // were separate and simply weren't called for a guest. One request
    // instead of up to 7 separate Netlify Functions, each of which was its
    // own independent Lambda paying its own cold-start cost — see
    // tracker-data.js for why that mattered.
    var url = '/tracker-data?month=' + monthStr + (state.student ? '&email=' + encodeURIComponent(state.student.email) : '');

    api(url)
      .then(function (data) {
        var scheduleDays = data.schedule.days || [];
        state.latestScheduledMonth = data.schedule.latestMonth || null;
        state.lastWeekLeaders = data.lastWeekLeaders.leaders || [];
        state.lastWeekViewerRank = data.lastWeekLeaders.viewerRank || null;
        var progressRows = state.student ? (data.progress.progress || []) : [];
        state.streak = state.student ? data.streak.streak : null;
        state.subjectProgress = state.student ? (data.subjectProgress.subjects || []) : [];

        // Only present once a student has actually saved custom durations
        // somewhere before (see applyPomoSettings) — merge in place of
        // whatever localStorage/defaults loaded at module-init time, so a
        // student's setup follows them to a new device/browser instead of
        // only living in the one that saved it.
        var savedPomo = state.student ? data.pomoSettings : null;
        if (savedPomo && savedPomo.work != null) {
          pomoSettings = {
            work: savedPomo.work,
            shortBreak: savedPomo.shortBreak,
            longBreak: savedPomo.longBreak,
            cycle: savedPomo.cycle,
          };
          savePomoSettings(); // cache locally too, so a later guest-mode reload isn't stuck back on defaults
          if (!pomo.running) {
            pomo.totalSeconds = pomoDurationFor(pomo.mode);
            pomo.secondsLeft = pomo.totalSeconds;
          }
        }

        // Math.max, not a straight overwrite: loadMonth can re-run mid-Focus-
        // session (e.g. a guest registers via the pending-task flow while a
        // pomodoro they started as a guest is still running) — a lower
        // server count in that moment (a fresh account has no history yet)
        // shouldn't erase sessions already completed earlier in this same
        // page load.
        var dailySessions = state.student ? data.pomoSessions : null;
        if (dailySessions) {
          pomo.completedSessions = Math.max(pomo.completedSessions, dailySessions.sessionsCompleted || 0);
        }

        // Cross-device pomodoro sync: if a session was started on a
        // different browser/device, this device's own localStorage (used
        // by the synchronous restore at init()) knows nothing about it —
        // pomoActive is that session's server-side mirror (see
        // pomo-active.js). Only adopt it if it's actually newer than
        // whatever's already applied here (pomoStateAsOf), so a slightly
        // stale response doesn't undo a fresh local action (e.g. clicking
        // Start right as this request was in flight).
        var remoteActive = state.student ? data.pomoActive : null;
        if (remoteActive && remoteActive.updatedAt) {
          var remoteAsOf = parseUtcTimestamp(remoteActive.updatedAt).getTime();
          if (remoteAsOf > pomoStateAsOf) applyPomoActiveState(remoteActive);
        }

        var completedSet = new Set(
          progressRows.filter(function (r) { return r.completed; })
            .map(function (r) { return r.date + '|' + r.subject + '|' + r.task_text; })
        );

        state.days = scheduleDays
          .map(function (day) {
            var tasks = day.tasks.map(function (t) {
              return {
                subject: t.subject,
                task_text: t.task_text,
                completed: completedSet.has(day.date + '|' + t.subject + '|' + t.task_text),
              };
            });
            return { date: day.date, tasks: tasks };
          })
          .sort(function (a, b) { return a.date < b.date ? -1 : 1; });

        // Any day with something left to tick starts expanded, not just past
        // ones — with pre-ticking allowed, a fully-future month (nothing
        // "missed" yet) would otherwise render with every checkbox hidden
        // behind a collapsed row, which just looks like nothing is clickable.
        state.days.forEach(function (d) {
          var allDone = d.tasks.length > 0 && d.tasks.every(function (t) { return t.completed; });
          if (!allDone) state.expanded.add(d.date);
        });

        // Every week collapses by default except the one containing today,
        // so the page isn't a huge wall of past/future weeks on load — but
        // only the first time a given week is ever seen, so a week the
        // student has manually expanded/collapsed stays that way across
        // month navigation and reloads instead of resetting.
        var todayWk = mondayOf(todayIso());
        state.days.forEach(function (d) {
          var wk = mondayOf(d.date);
          if (state.initializedWeeks.has(wk)) return;
          state.initializedWeeks.add(wk);
          if (wk !== todayWk) state.collapsedWeeks.add(wk);
        });

        renderCalendar();
      })
      .catch(function (err) {
        app.innerHTML = '<p class="center-note">Couldn’t load your roadmap: ' + escapeHtml(err.message) + '</p>';
      });
  }

  function dayStatus(day) {
    var today = todayIso();
    if (day.date === today) return 'today';
    var allDone = day.tasks.length > 0 && day.tasks.every(function (t) { return t.completed; });
    if (allDone) return 'complete';
    // A guest has no completion history at all, so every past day would
    // otherwise show as "missed" no matter when they show up — not
    // meaningful without an account to actually track against, so it only
    // ever shows for a signed-in student.
    return (day.date < today && state.student) ? 'missed' : 'upcoming';
  }

  // Summarizes a whole week (excluding today, which renders separately —
  // see renderCalendar) so a returning/catch-up student can see at a
  // glance whether a past week still needs attention without expanding
  // it. Same color vocabulary as dayStatus/day-status: green once every
  // task in the week is done, amber if any day in it is genuinely missed,
  // grey otherwise (untouched or in-progress future week).
  function weekStatusInfo(weekDays) {
    var today = todayIso();
    var totalTasks = 0, doneTasks = 0, hasMissed = false;
    weekDays.forEach(function (d) {
      totalTasks += d.tasks.length;
      doneTasks += d.tasks.filter(function (t) { return t.completed; }).length;
      if (state.student && d.date < today && dayStatus(d) === 'missed') hasMissed = true;
    });
    if (totalTasks > 0 && doneTasks === totalTasks) return { cls: 'complete', label: '✅ Complete' };
    if (hasMissed) return { cls: 'missed', label: '⚠️ ' + doneTasks + '/' + totalTasks + ' done' };
    if (doneTasks === 0) return { cls: 'upcoming', label: 'Upcoming' };
    return { cls: 'upcoming', label: doneTasks + '/' + totalTasks + ' done' };
  }

  // Same idea as patchDayStatus — a single task toggle can flip a week
  // between "some missed" and "✅ Complete" (or change its X/Y count),
  // and that's exactly the signal a catch-up student relies on without
  // expanding every week to check.
  function patchWeekStatus(date) {
    var wk = mondayOf(date);
    var today = todayIso();
    var weekDays = state.days.filter(function (d) { return d.date !== today && mondayOf(d.date) === wk; });
    if (!weekDays.length) return;
    var el = document.querySelector('.week[data-week="' + wk + '"] .week-status');
    if (!el) return;
    var status = weekStatusInfo(weekDays);
    el.className = 'week-status ' + status.cls;
    el.textContent = status.label;
  }

  // ── Streak hero ────────────────────────────────────────────────────
  function renderStreakHero() {
    var n = state.streak;
    var label = n === 1 ? 'day streak' : 'day streak';
    // The gradient-clipped-text style below makes any short flat glyph
    // (like the guest placeholder "-") render as a solid colored block
    // instead of reading as a dash — streak-number--empty turns that
    // effect off just for this state so it actually looks like a dash.
    return '<div class="streak-hero fade-in">' +
      '<div class="streak-flame">🔥</div>' +
      '<div class="streak-number' + (n === null ? ' streak-number--empty' : '') + '" id="streak-number">' + (n === null ? '–' : n) + '</div>' +
      '<div class="streak-label">' + label + '</div>' +
      '</div>';
  }

  // ── Per-subject breakdown — global across the whole schedule (see
  // netlify/functions/subject-progress.js), not scoped to the viewed
  // month or to elapsed days. A subject can span many months, so
  // month-scoping it would make progress look like it resets every time
  // the student navigates months.
  function isAssessment(name) {
    return /quiz|test series/i.test(name);
  }

  function renderSubjectBreakdown() {
    // Keep whatever's already come back from real schedule data, then
    // append any canonical GATE DA subject not already represented —
    // those show at 0% until a schedule with that subject gets uploaded
    // and synced, at which point they start progressing with each tick
    // like any other row.
    var subjects = (state.subjectProgress || []).slice();
    var present = {};
    subjects.forEach(function (s) { present[s.subject] = true; });
    CANONICAL_SUBJECTS.forEach(function (name) {
      if (!present[name]) subjects.push({ subject: name, done: 0, total: 0 });
    });

    // Quizzes/test series aren't a syllabus subject — sort them after
    // everything else instead of wherever they happen to fall.
    var syllabus = subjects.filter(function (s) { return !isAssessment(s.subject); });
    var assessments = subjects.filter(function (s) { return isAssessment(s.subject); });
    var ordered = syllabus.concat(assessments);

    var rows = ordered.map(function (s) {
      var pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
      var rowClass = 'subject-row' + (isAssessment(s.subject) ? ' subject-row--assessment' : '');
      return '<div class="' + rowClass + '" data-subject="' + escapeAttr(s.subject) + '">' +
        '<div class="subject-row-name">' + escapeHtml(s.subject) + '</div>' +
        '<div class="subject-row-line"><div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="subject-row-pct">' + pct + '%</div></div>' +
        '</div>';
    }).join('');

    return '<div class="subject-breakdown fade-in"><div class="subject-breakdown-title">Progress by subject</div>' + rows + '</div>';
  }

  // ── Last week's top 5 by focus minutes — a section inside the shared
  // streak-champions-card (see renderCalendar), not its own separate card,
  // so it's visible immediately, not below the fold. Public/unpersonalized
  // like the live weekly leaderboard, so this shows for guests too.
  // Renders nothing at all if last week had no data yet (a brand new week,
  // or nobody used the timer) rather than showing an empty-looking
  // section — the streak section's flex:1 then naturally claims the
  // whole card alone.
  function renderLastWeekChampions() {
    var leaders = state.lastWeekLeaders || [];
    if (!leaders.length) return '';
    var rows = leaders.map(function (l, i) {
      var rank = LEADERBOARD_MEDALS[i] || (i + 1);
      // Same up/down arrow as the top-20 board (rankMovementHtml), just
      // compared against last week's rank in the week before it rather
      // than the previous poll — see previous_week_rank in
      // tracker-data.js's fetchLastWeekLeaders.
      return '<div class="leaderboard-row' + (i < 3 ? ' leaderboard-row--top' : '') + (l.is_me ? ' leaderboard-row--me' : '') + '">' +
        '<span class="leaderboard-rank">' + rank + rankMovementHtml(i + 1, l.previous_week_rank) + '</span>' +
        '<span class="leaderboard-name">' + escapeHtml(l.display_name) + (l.is_me ? ' <span class="leaderboard-you">You</span>' : '') + '</span>' +
        '<span class="leaderboard-time">' + l.total_minutes + 'm</span>' +
        '</div>';
    }).join('');
    // Same "gap + own row" pattern as the in-Focus-Mode leaderboard (see
    // renderLeaderboardRows) — a viewer outside last week's top 5
    // otherwise has zero visibility into their own standing here either.
    if (state.lastWeekViewerRank) {
      rows += '<div class="leaderboard-gap">···</div>' +
        '<div class="leaderboard-row leaderboard-row--me">' +
        '<span class="leaderboard-rank">' + state.lastWeekViewerRank.rank + rankMovementHtml(state.lastWeekViewerRank.rank, state.lastWeekViewerRank.previous_week_rank) + '</span>' +
        '<span class="leaderboard-name">You</span>' +
        '<span class="leaderboard-time">' + state.lastWeekViewerRank.total_minutes + 'm</span>' +
        '</div>';
    }
    // Clicking anywhere on the card jumps to Focus Mode (see
    // bindCalendarEvents) — role/tabindex so it's actually reachable and
    // announced as a control, not just a div with a click listener nobody
    // but a mouse user could trigger.
    var showBadge5 = newBadgeVisible('top5');
    return '<div class="leaderboard-card champions-section clickable-card" id="champions-card" role="button" tabindex="0">' +
      '<div class="leaderboard-title' + (showBadge5 ? ' has-badge' : '') + '">Mission IIT Leaderboard</div>' +
      newBadgeHtml(showBadge5) +
      '<div class="leaderboard-subtitle">Top 5 by minutes logged, last week</div>' +
      rows +
      '</div>';
  }

  // ── Completion heatmap for the visible month — compact, secondary,
  // placed at the bottom of the page rather than up top. ────────────
  function heatLevel(day) {
    if (!day || !day.tasks.length) return 0;
    var total = day.tasks.length;
    var done = day.tasks.filter(function (t) { return t.completed; }).length;
    // Untouched (nothing ticked yet) renders the same dotted "0" state as a
    // day with nothing scheduled — color only appears once real progress
    // has been made, not just because content exists for that day.
    if (done === 0) return 0;
    if (done === total) return 4;
    return done / total < 0.5 ? 2 : 3;
  }

  function renderHeatmap() {
    var parts = state.month.split('-').map(Number);
    var year = parts[0], month = parts[1];
    var daysInMonth = new Date(year, month, 0).getDate();
    var firstDow = new Date(year, month - 1, 1).getDay();
    var leadBlanks = firstDow === 0 ? 6 : firstDow - 1;
    var today = todayIso();
    var byDate = {};
    state.days.forEach(function (d) { byDate[d.date] = d; });

    var cells = '';
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(function (l) { cells += '<div class="heatmap-dow">' + l + '</div>'; });
    for (var i = 0; i < leadBlanks; i++) cells += '<div class="heatmap-cell" style="visibility:hidden"></div>';
    for (var day = 1; day <= daysInMonth; day++) {
      var dateStr = year + '-' + pad(month) + '-' + pad(day);
      var level = heatLevel(byDate[dateStr]);
      var isToday = dateStr === today ? ' is-today' : '';
      cells += '<div class="heatmap-cell' + isToday + '" data-level="' + level + '" data-date="' + dateStr + '" title="' + dateStr + '"></div>';
    }

    return '<div class="heatmap-card fade-in">' +
      '<div class="heatmap-head"><span class="heatmap-title">' + monthLabel(state.month) + ' at a glance</span>' +
      '<span class="heatmap-legend">Less <span class="heatmap-cell" data-level="0"></span><span class="heatmap-cell" data-level="1"></span><span class="heatmap-cell" data-level="2"></span><span class="heatmap-cell" data-level="3"></span><span class="heatmap-cell" data-level="4"></span> More</span></div>' +
      '<div class="heatmap-grid">' + cells + '</div></div>';
  }

  // Exam countdown + subject breakdown. Streak lives in its own separate
  // #streak-panel (see renderCalendar) rather than being rebuilt here —
  // it's driven by its own async fetch (refreshStreak), and regenerating
  // its whole card on every task toggle meant the entire streak-hero
  // (flame, glow, label) replayed its fade-in-from-nothing entrance every
  // single tick, instead of just the number changing.
  function buildStatsPanelHtml() {
    var html = '';

    if (EXAM_DATE) {
      // Real date, not the Aug-1-floored todayIso() — this countdown has no
      // reason to sit frozen just because the demo schedule clamp hasn't
      // expired yet; it should tick down every actual calendar day.
      var today = realTodayIso();
      var daysLeft = Math.max(0, Math.ceil((new Date(EXAM_DATE) - new Date(today)) / 864e5));
      html += '<div class="exam-countdown fade-in">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.7"/><path d="M3 9.5h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>' +
        '<span class="exam-countdown-num">' + daysLeft + '</span> days till GATE</div>';
    }

    return html;
  }

  // "Day X/180" badge for the main checklist page — day 1 is Aug 1, same
  // start as the schedule itself. A big gradient stat (same visual
  // language as .streak-number) rather than a pill, since the whole
  // point is for it to read as the page's headline number, not a small
  // status chip. Same reasoning for using realTodayIso() over the
  // Aug-1-floored todayIso(): this should tick forward on every actual
  // calendar day, not sit frozen at "Day 1" for a visitor arriving before
  // the schedule technically starts.
  function renderProgramDayBadge() {
    var today = realTodayIso();
    var dayNum = Math.max(1, Math.round((new Date(today) - new Date(PROGRAM_START_DATE)) / 864e5) + 1);
    return '<div class="program-day-badge fade-in">' +
      '<div class="program-day-num">' + dayNum + '</div>' +
      '<div class="program-day-label">Day of ' + PROGRAM_LENGTH_DAYS + '</div></div>';
  }

  // Re-fetches the global per-subject totals (a tick anywhere in the
  // schedule, not just this month, can change them) and patches each
  // row's bar/percentage in place — no innerHTML replace, so the
  // .subject-breakdown card (which carries .fade-in) never gets
  // recreated and never replays its entrance animation.
  function refreshSubjectProgress() {
    return api('/subject-progress?email=' + encodeURIComponent(state.student.email))
      .then(function (r) {
        state.subjectProgress = r.subjects || [];
        state.subjectProgress.forEach(function (s) {
          var row = document.querySelector('.subject-row[data-subject="' + CSS.escape(s.subject) + '"]');
          if (!row) return;
          var pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
          var fill = row.querySelector('.progress-fill');
          var label = row.querySelector('.subject-row-pct');
          if (fill) fill.style.width = pct + '%';
          if (label) label.textContent = pct + '%';
        });
      })
      .catch(function () { /* non-critical — leave last known values on screen */ });
  }

  // Same idea for a single heatmap cell — just flip its data-level
  // attribute (CSS handles the color via the existing [data-level="n"]
  // selectors) instead of rebuilding the whole grid.
  function patchHeatmapCell(date) {
    var day = state.days.find(function (d) { return d.date === date; });
    var cell = document.querySelector('.heatmap-cell[data-date="' + date + '"]');
    if (cell) cell.setAttribute('data-level', String(heatLevel(day)));
  }

  // Updates one day card's status badge in place (e.g. Missed → Complete
  // once its last task is ticked) without touching its open/closed state
  // or any other day card on the page.
  function patchDayStatus(date) {
    var day = state.days.find(function (d) { return d.date === date; });
    if (!day) return;
    var el = document.querySelector('.day[data-date="' + date + '"] .day-status');
    if (!el) return;
    var status = dayStatus(day);
    if (status === 'today') return;
    var label = status === 'complete' ? '✅ Complete' : status === 'missed' ? '⚠️ Missed' : 'Upcoming';
    el.className = 'day-status ' + status;
    el.textContent = label;
  }

  // Recomputes the "N days incomplete before today" banner and patches it
  // in place — ticking a missed day's task changes this count but doesn't
  // touch the today-card itself otherwise, so it was going stale until the
  // next full re-render (month nav or reload).
  function refreshCatchupWarn() {
    var today = todayIso();
    var count = state.days.filter(function (d) { return d.date < today && dayStatus(d) === 'missed'; }).length;
    var card = document.querySelector('.today-card');
    if (!card) return;
    var warn = card.querySelector('.catchup-warn');
    if (count > 0) {
      var text = '⚠️ ' + count + ' day' + (count === 1 ? '' : 's') +
        ' incomplete before today. Today’s content builds on those, so consider catching up first.';
      if (warn) {
        warn.textContent = text;
      } else {
        warn = document.createElement('div');
        warn.className = 'catchup-warn';
        warn.textContent = text;
        var dateEl = card.querySelector('.today-date');
        if (dateEl) dateEl.insertAdjacentElement('afterend', warn);
      }
    } else if (warn) {
      warn.remove();
    }
  }

  // Explicit rename only, via the "Rename" link below — separate from
  // registration, which recognizes a returning student by email and
  // deliberately ignores a differently-typed name (see register.js).
  function renderIdentityLine() {
    if (!state.student) return 'Browsing as guest, tick a task to save your progress';
    if (state.renaming) {
      return '<form id="rename-form" class="rename-form">' +
        '<input id="rename-input" type="text" value="' + escapeAttr(state.student.display_name) + '" maxlength="60" required autocomplete="name">' +
        '<button type="submit" class="rename-save">Save</button>' +
        '<button type="button" id="rename-cancel" class="rename-cancel">Cancel</button>' +
        (state.renameError ? '<span class="rename-error">' + escapeHtml(state.renameError) + '</span>' : '') +
        '</form>';
    }
    return escapeHtml(state.student.display_name) + ' &middot; <button id="rename-toggle">Rename</button> &middot; <button id="not-you">Not you?</button>';
  }

  function renderCalendar() {
    var today = todayIso();
    var todayDay = state.days.find(function (d) { return d.date === today; });
    // dayStatus() itself already only ever returns 'missed' for a
    // signed-in student (see its guest guard), so this is naturally empty
    // for guests without needing a separate check here too.
    var missedBefore = state.days.filter(function (d) { return d.date < today && dayStatus(d) === 'missed'; });

    var html = '';
    html += '<div class="roadmap-head"><h1>TAAI BATCH C - MISSION IIT <span class="roadmap-emoji">🎯</span></h1></div>';
    // Exit Focus sits in the same row as the identity line (not floating
    // alone in the blank space above the timer card) — .roadmap-sub is
    // already a space-between flex row, so it lands opposite the name/
    // rename/streak text for free.
    html += '<div class="roadmap-sub">' +
      '<div class="roadmap-sub-left">' + renderIdentityLine() + '</div>' +
      (state.focus ?
        '<button id="focus-toggle" class="focus-toggle active">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>' +
        ' Exit Focus</button>' : '') +
      '</div>';

    if (!state.focus) html += '<div class="page-grid"><div class="main-col">';

    if (!state.focus) {
      // Was centered relative to the whole page-grid width (including
      // .side-col's space) before this moved inside .main-col — visibly
      // drifted right of the heading/Focus button above it, which are
      // both constrained to .main-col's narrower width. Centering here
      // instead actually lines it up with them.
      html += '<div class="program-day-badge-wrap">' + renderProgramDayBadge() + '</div>';
      html += '<div class="focus-toggle-wrap"><button id="focus-toggle" class="focus-toggle">◎ Focus mode</button></div>';
      // One shared card, not two side by side — same pattern as Focus
      // Mode's own unified card (countdown/timer/today/leaderboard as
      // sections with a divider, not stacked separate floating cards).
      // Visible immediately without scrolling, instead of all the way
      // down in .side-col. Renders nothing at all (see
      // renderLastWeekChampions) when there's no data, in which case
      // #streak-panel's flex:1 just naturally claims the whole card alone.
      html += '<div class="streak-champions-card fade-in">' +
        '<div id="streak-panel">' + renderStreakHero() + '</div>' +
        renderLastWeekChampions() +
        '</div>';

      html += '<div class="month-nav"><button id="prev-month" aria-label="Previous month"' +
        (state.month <= SCHEDULE_START_MONTH ? ' disabled' : '') + '>&larr;</button>' +
        '<span class="month-label">' + monthLabel(state.month) + '</span>' +
        '<button id="next-month" aria-label="Next month"' +
        (state.latestScheduledMonth && state.month >= state.latestScheduledMonth ? ' disabled' : '') + '>&rarr;</button></div>';
    }

    if (state.focus) {
      html += '<div class="focus-card fade-in" id="focus-card">';
      html += buildStatsPanelHtml();
      html += renderPomodoro();
      html += '<div class="focus-divider"></div>';
      if (todayDay) {
        html += renderTodayCard(todayDay, missedBefore.length);
      } else {
        html += '<p class="center-note">Nothing scheduled for today.</p>';
      }
      html += '<div class="focus-divider"></div>';
      html += renderLeaderboardCard();
      html += '</div>'; // focus-card
    } else if (todayDay) {
      html += renderTodayCard(todayDay, missedBefore.length);
    }

    if (!state.focus) {
      var otherDays = state.days.filter(function (d) { return d.date !== today; });
      // Pre-grouped into weeks (rather than opening/closing the wrapping
      // divs inline as each day streams past) so each week's status badge
      // can be computed from its full day list before that week's markup
      // is written out.
      var weeks = [];
      otherDays.forEach(function (day) {
        var wk = mondayOf(day.date);
        var lastWeek = weeks[weeks.length - 1];
        if (!lastWeek || lastWeek.key !== wk) weeks.push({ key: wk, days: [day] });
        else lastWeek.days.push(day);
      });
      weeks.forEach(function (week, idx) {
        var weekOpen = !state.collapsedWeeks.has(week.key);
        var status = weekStatusInfo(week.days);
        html += '<div class="week" data-week="' + week.key + '">' +
          '<div class="week-label" role="button" tabindex="0" aria-expanded="' + weekOpen + '">' +
          '<svg class="week-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 6L15 12L9 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '<span>Week ' + (idx + 1) + '</span>' +
          '<span class="week-status ' + status.cls + '">' + status.label + '</span></div>' +
          '<div class="week-body-wrap' + (weekOpen ? ' expanded' : '') + '"><div class="week-body-inner">' +
          week.days.map(renderDay).join('') +
          '</div></div></div>';
      });

      if (!state.days.length) {
        html += '<p class="center-note">Nothing scheduled for ' + monthLabel(state.month) + ' yet.</p>';
      }

      html += '</div>'; // main-col
      html += '<div class="side-col">' +
        '<div id="heatmap-panel">' + renderHeatmap() + '</div>' +
        '<div id="subject-panel">' + renderSubjectBreakdown() + '</div>' +
        '</div>'; // side-col
      html += '</div>'; // page-grid
    }

    app.innerHTML = html;
    bindCalendarEvents();
    observeFadeIns();
    // state.lastWeekLeaders/lastWeekViewerRank are already fresh at this
    // point (set earlier in loadMonth's resolve, before renderCalendar is
    // called) — unlike the top-20 card in Focus Mode, this one doesn't
    // need a separate post-fetch hook (see refreshLeaderboard).
    // Only for an actual top-5 finish, not just "logged some minutes last
    // week" — narrower than the confetti trigger used to be (that also
    // covered lastWeekViewerRank, i.e. any placement at all).
    armConfetti('champions-card', 'top5-' + mondayOf(todayIso()),
      state.lastWeekLeaders.some(function (l) { return l.is_me; }));
    // The "NEW" badge itself needs no post-render arming anymore — see
    // newBadgeHtml, called directly from renderLastWeekChampions/
    // renderLeaderboardCard as part of building the HTML string.
    // First-ever streak celebration — a true one-time thing (permanent
    // key, not scoped to the current week like the leaderboards above),
    // fires the first time this student's streak is ever seen at exactly
    // 1. Armed here for the initial page-load case; refreshStreak below
    // handles the case where a task toggle is what makes it 1.
    armConfetti('streak-panel', 'first-streak', state.streak === 1);
  }

  function pomoDurationFor(mode) {
    if (mode === 'work') return pomoSettings.work * 60;
    var isLongBreak = pomo.completedSessions > 0 && pomo.completedSessions % pomoSettings.cycle === 0;
    return (isLongBreak ? pomoSettings.longBreak : pomoSettings.shortBreak) * 60;
  }

  function formatPomoTime(totalSeconds) {
    var m = Math.floor(totalSeconds / 60), s = totalSeconds % 60;
    return pad(m) + ':' + pad(s);
  }

  function pomoDotsText() {
    var filled = pomo.completedSessions % pomoSettings.cycle;
    var dots = '';
    for (var i = 0; i < pomoSettings.cycle; i++) dots += (i < filled ? '🍅' : '⚪');
    return dots;
  }

  // The dots alone are easy to miss/misread at a glance (tiny, same shape,
  // color is the only distinguishing signal) — this spells out the same
  // count as text underneath.
  function pomoSessionLabel() {
    var filled = pomo.completedSessions % pomoSettings.cycle;
    return filled + ' / ' + pomoSettings.cycle + ' sessions';
  }

  // Created lazily on the first real click of Start, Skip, or the settings
  // panel's test-sound button — any of those is a genuine user gesture, and
  // creating the context inside one is what makes the browser start it
  // "running" instead of auto-suspended. Called from every place that can
  // trigger a chime (not just Start) because Skip can fire a chime without
  // Start ever having been pressed first.
  function ensurePomoAudioCtx() {
    try {
      if (!pomoAudioCtx) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        pomoAudioCtx = new Ctx();
      } else if (pomoAudioCtx.state === 'suspended') {
        pomoAudioCtx.resume();
      }
    } catch (e) { /* Web Audio unsupported — chime just won't play */ }
  }

  // Two-tone chime via Web Audio — no audio asset to manage, and it's a
  // one-shot synthesized tone rather than a decoded/streamed file, so
  // there's nothing to preload or fail to load. Gain peaks at 0.5 (up from
  // an initial 0.25, which several people testing on laptop speakers
  // reported as inaudible) — still calling ensurePomoAudioCtx() defensively
  // here too, in case this ever gets called before any gesture has fired.
  //
  // finishedMode picks which phase just ended: an ascending pair for a
  // finished work session (entering a break — the "reward" chime) vs. a
  // descending pair for a finished break (back to work), so the two are
  // tellable apart by ear alone. Defaults to the work-session chime when
  // called with no argument (the Test sound button plays both explicitly).
  function playPomoChime(finishedMode) {
    try {
      ensurePomoAudioCtx();
      var ctx = pomoAudioCtx;
      if (!ctx) return;
      var freqs = finishedMode === 'break' ? [784, 659] : [660, 880];
      freqs.forEach(function (freq, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        var start = ctx.currentTime + i * 0.18;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.5, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
        osc.start(start);
        osc.stop(start + 0.45);
      });
    } catch (e) { /* Web Audio unsupported/blocked — not critical */ }
  }

  // Only fires on a genuine tick-to-zero finish (called from pomoTick, not
  // pomoAdvance directly) — same reasoning as the leaderboard credit gating,
  // so skipping a phase doesn't also spam a notification.
  function maybeSendPomoNotification(finishedMode) {
    // Defensive, not the primary gate — the Start button can't even be
    // reached unless permission was already 'granted' (see renderPomodoro),
    // but a student could revoke it mid-session via browser settings, so
    // this still checks fresh rather than assuming.
    if (pomoNotifyState() !== 'granted') return;
    var title = finishedMode === 'work' ? 'Focus session complete 🎉' : "Break's over ⏰";
    var progress = pomoSessionLabel() + ' today';
    var body = finishedMode === 'work'
      ? 'Nice work — time for a break. ' + progress + '.'
      : 'Come back and hit Start to keep going. ' + progress + '.';
    try {
      // tag replaces any notification already showing instead of stacking
      // them, in case several phases finish while the tab is untouched.
      new Notification(title, { body: body, tag: 'taai-pomo', icon: '/favicon-32.png' });
    } catch (e) { /* not critical */ }
  }

  // Patches the existing DOM in place — never regenerates the pomodoro
  // card's innerHTML, so a once-a-second tick never touches (and never
  // replays the entrance animation of) a .fade-in ancestor.
  function updatePomoDisplay() {
    var card = document.getElementById('pomo-card');
    if (!card) return;
    card.classList.toggle('on-break', pomo.mode === 'break');
    var modeEl = document.getElementById('pomo-mode');
    if (modeEl) modeEl.textContent = pomo.mode === 'work' ? 'Focus' : 'Break';
    var timeEl = document.getElementById('pomo-time');
    if (timeEl) timeEl.textContent = formatPomoTime(pomo.secondsLeft);
    var dotsEl = document.getElementById('pomo-dots');
    if (dotsEl) dotsEl.textContent = pomoDotsText();
    var sessionLabelEl = document.getElementById('pomo-session-label');
    if (sessionLabelEl) sessionLabelEl.textContent = pomoSessionLabel();
    var toggleBtn = document.getElementById('pomo-toggle');
    if (toggleBtn) toggleBtn.textContent = pomo.running ? 'Pause' : 'Start';
    var ring = document.getElementById('pomo-ring-progress');
    if (ring) {
      var frac = pomo.totalSeconds > 0 ? pomo.secondsLeft / pomo.totalSeconds : 0;
      ring.style.strokeDashoffset = String(POMO_RING_CIRCUMFERENCE * (1 - frac));
    }
  }

  function pomoAdvance() {
    // Captured before pomo.mode flips below, so playPomoChime knows which
    // phase just ended (also correct when called from pomoSkip, which
    // skips straight to this — the mode being left is still whatever
    // pomo.mode was a moment ago).
    var finishedMode = pomo.mode;
    var oldPhaseEndAt = pomo.phaseEndAt;
    if (pomo.mode === 'work') pomo.completedSessions++;
    pomo.mode = pomo.mode === 'work' ? 'break' : 'work';
    pomo.totalSeconds = pomoDurationFor(pomo.mode);
    // Cascades from whichever is earlier: the phase that just ended's own
    // deadline, or right now. Matters after a long gap (closed tab, OS
    // sleep) where multiple phases' worth of time may have already
    // elapsed — anchoring the next phase to "now" would make it look
    // freshly started even if IT had also already elapsed during the same
    // gap, silently skipping past a break that should have triggered the
    // mandatory pause. Anchoring to the old deadline instead lets this
    // next phase's own remaining time come out zero-or-negative too, so
    // pomoTick's loop below can catch that and keep cascading. This still
    // behaves correctly for a manual Skip, where the old deadline is still
    // in the *future* — Math.min just picks "now" in that case, same as
    // before.
    pomo.phaseEndAt = Math.min(Date.now(), oldPhaseEndAt) + pomo.totalSeconds * 1000;
    pomo.secondsLeft = Math.max(0, Math.round((pomo.phaseEndAt - Date.now()) / 1000));
    playPomoChime(finishedMode);
    updatePomoDisplay();
    savePomoActiveState();
  }

  function pomoTick() {
    // A loop, not a single check — after a long gap (closed tab, OS sleep)
    // more than one phase can have already elapsed (e.g. a whole work+break
    // cycle), and each needs its own credit/notification/pause handling
    // rather than silently collapsing into one. Bounded naturally: pause-
    // after-break always halts this within at most two iterations (a work
    // finish followed immediately by a break finish), never runaway.
    while (pomo.running) {
      pomo.secondsLeft = Math.max(0, Math.round((pomo.phaseEndAt - Date.now()) / 1000));
      if (pomo.secondsLeft > 0) break;
      // Only a genuine tick-to-zero finish counts toward the leaderboard —
      // checked here (before pomoAdvance flips the mode), not inside
      // pomoAdvance itself, since pomoSkip also calls that and shouldn't
      // award credit for a session that wasn't actually completed.
      var finishedMode = pomo.mode;
      if (finishedMode === 'work') recordPomodoroCompletion(pomoSettings.work);
      // pomoAdvance first, not after — it's what increments
      // completedSessions, and the notification body wants that already
      // updated rather than showing the pre-completion count.
      pomoAdvance();
      maybeSendPomoNotification(finishedMode);
      if (finishedMode === 'break') {
        // A break just ended — pause here and require a manual Start for
        // the next work session, instead of auto-continuing. This is what
        // actually stops a forgotten-but-open tab from racking up
        // leaderboard credit indefinitely: it just sits paused after the
        // first break, earning nothing further, until someone clicks Start.
        clearInterval(pomo.timerId);
        pomo.running = false;
        // The work phase pomoAdvance just set up hasn't actually started
        // counting down (Start hasn't been clicked yet), so its
        // secondsLeft shouldn't be the cascaded-from-the-past value —
        // after a long catch-up that value can itself already be 0,
        // which would incorrectly show a paused "00:00" instead of the
        // full fresh duration waiting to begin.
        pomo.secondsLeft = pomo.totalSeconds;
        // Real bug, confirmed in production: pomoAdvance() above already
        // called savePomoActiveState() while pomo.running was still true,
        // so without this, localStorage is left permanently saying
        // "running" even though it just paused. Every future page load's
        // restorePomoActiveState() would then see running:true, resume,
        // find the phase already long expired (nobody clicked Start), and
        // instantly complete+credit another phantom work+break cycle
        // before pausing again — itself failing to persist that pause the
        // same way, so it kept happening on every single revisit. Only a
        // genuine Start click should ever be able to earn credit again.
        savePomoActiveState();
      }
    }
    updatePomoDisplay();
  }

  // The actual "begin counting down" logic, split out so both the
  // synchronous (already granted) and asynchronous (just granted via the
  // prompt below) paths in pomoToggleRun share it instead of duplicating it.
  function pomoActuallyStart() {
    ensurePomoAudioCtx(); // real click — unlocks audio for the chime that fires later, unattended
    pomo.phaseEndAt = Date.now() + pomo.secondsLeft * 1000;
    pomo.running = true;
    pomo.timerId = setInterval(pomoTick, 1000);
    savePomoActiveState();
  }

  function pomoToggleRun() {
    if (pomo.running) {
      clearInterval(pomo.timerId);
      pomo.running = false;
      updatePomoDisplay();
      savePomoActiveState();
      return;
    }

    var notifyState = pomoNotifyState();
    if (notifyState === 'granted') {
      pomoActuallyStart();
      updatePomoDisplay();
      return;
    }
    if (notifyState === 'unsupported' || notifyState === 'denied') {
      // Nothing left to ask — either there's no Notification API at all, or
      // the browser already recorded "denied" and won't re-prompt. Surface
      // why Start didn't do anything instead of silently doing nothing.
      state.pomoBlockedReason = notifyState;
      renderCalendar();
      return;
    }
    // 'default' — this click is the real user gesture the permission
    // prompt requires; requesting it from anywhere else gets auto-denied
    // or silently ignored by modern browsers. Whatever the student decides
    // here, this is what actually presses "Start" on their behalf.
    Notification.requestPermission().then(function (perm) {
      if (perm === 'granted') {
        pomoActuallyStart();
      } else {
        state.pomoBlockedReason = 'denied';
      }
      renderCalendar();
    });
  }

  function pomoReset() {
    clearInterval(pomo.timerId);
    pomo.running = false;
    pomo.mode = 'work';
    pomo.totalSeconds = pomoDurationFor('work');
    pomo.secondsLeft = pomo.totalSeconds;
    updatePomoDisplay();
    savePomoActiveState();
  }

  function pomoSkip() {
    ensurePomoAudioCtx(); // real click — Skip can fire a chime even if Start was never pressed
    clearInterval(pomo.timerId);
    pomoAdvance();
    if (pomo.running) pomo.timerId = setInterval(pomoTick, 1000);
  }

  // Guests have no identity to save durations against — localStorage (see
  // savePomoSettings) is all they get, same as before this existed. For a
  // signed-in student this is what makes a customized setup follow them to
  // a different device/browser instead of only living in the one that
  // saved it (see loadMonth's pomo-settings fetch for the read side).
  function saveRemotePomoSettings() {
    if (!state.student) return;
    api('/pomo-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: state.student.email, work: pomoSettings.work, shortBreak: pomoSettings.shortBreak, longBreak: pomoSettings.longBreak, cycle: pomoSettings.cycle }),
    }).catch(function () { /* non-critical — localStorage on this device still has it */ });
  }

  // Reads the settings form, clamps/validates, persists, and — only if the
  // timer isn't currently mid-countdown — applies immediately to the
  // current phase. A running timer keeps counting down on the old
  // duration; new settings take effect starting next phase, so changing
  // "Focus minutes" mid-focus-session can't yank time out from under you.
  function applyPomoSettings() {
    var work = clampMinutes(document.getElementById('pomo-set-work').value, pomoSettings.work, 1, 180);
    var shortBreak = clampMinutes(document.getElementById('pomo-set-short').value, pomoSettings.shortBreak, 1, 60);
    var longBreak = clampMinutes(document.getElementById('pomo-set-long').value, pomoSettings.longBreak, 1, 90);
    var cycle = clampMinutes(document.getElementById('pomo-set-cycle').value, pomoSettings.cycle, 1, 12);
    pomoSettings = { work: work, shortBreak: shortBreak, longBreak: longBreak, cycle: cycle };
    savePomoSettings();
    saveRemotePomoSettings();

    document.getElementById('pomo-set-work').value = work;
    document.getElementById('pomo-set-short').value = shortBreak;
    document.getElementById('pomo-set-long').value = longBreak;
    document.getElementById('pomo-set-cycle').value = cycle;

    if (!pomo.running) {
      pomo.totalSeconds = pomoDurationFor(pomo.mode);
      pomo.secondsLeft = pomo.totalSeconds;
    }
    updatePomoDisplay();

    var panel = document.getElementById('pomo-settings');
    if (panel) panel.hidden = true;
  }

  // The gate shown in place of the real timer until notifications are
  // granted (see renderPomodoro). Not a full-featured card — no settings,
  // no Start/Reset/Skip — since nothing about the timer is usable yet.
  // Only appears after a Start click actually needed notification
  // permission and didn't get it (see pomoToggleRun, which sets
  // state.pomoBlockedReason) — never shown just because permission
  // happens to not be granted yet, so the clock/dots/Start button stay
  // fully visible the whole time, before anyone's clicked anything.
  function renderPomoNotifyNotice() {
    if (!state.pomoBlockedReason) return '';
    var html = '<div class="pomo-notify-notice fade-in" id="pomo-notify-notice">';
    if (state.pomoBlockedReason === 'unsupported') {
      html += '<div class="pomo-gate-title">Focus Timer isn’t available here</div>' +
        '<p class="pomo-gate-body">This browser doesn’t support notifications, which the Focus Timer requires. Try a different browser to use it.</p>';
    } else {
      // requestPermission() can never re-show the prompt once a browser has
      // recorded "denied" for this origin — it just silently returns
      // "denied" again immediately, no dialog, no matter how it's called.
      // Only the student flipping it in their own browser's site settings
      // can undo that, so the instructions have to be specific enough to
      // actually follow rather than a vague "check your settings".
      html += '<div class="pomo-gate-title">Notifications are blocked</div>' +
        '<p class="pomo-gate-body">Your browser saved a “Block” choice for this site, so it can’t prompt you again automatically. To fix it:</p>' +
        '<ol class="pomo-gate-steps">' +
        '<li>Click the 🔒 or ⓘ icon next to this page’s address (on Safari: the <strong>Safari</strong> menu → Settings → Websites → Notifications)</li>' +
        '<li>Set Notifications for this site to <strong>Allow</strong></li>' +
        '<li>Come back here and reload</li>' +
        '</ol>' +
        '<button class="pomo-btn pomo-btn-primary" id="pomo-gate-reload" type="button">I’ve updated it — Reload</button>';
    }
    html += '</div>';
    return html;
  }

  function renderPomodoro() {
    var frac = pomo.totalSeconds > 0 ? pomo.secondsLeft / pomo.totalSeconds : 1;
    var offset = POMO_RING_CIRCUMFERENCE * (1 - frac);

    return '<div class="pomodoro-card fade-in' + (pomo.mode === 'break' ? ' on-break' : '') + '" id="pomo-card">' +
      '<button class="pomo-settings-toggle" id="pomo-settings-toggle" aria-label="Timer settings" type="button">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z"/><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>' +
      '</button>' +
      '<div class="pomodoro-ring-wrap">' +
      '<svg class="pomodoro-ring" viewBox="0 0 200 200">' +
      '<circle class="pomo-ring-track" cx="100" cy="100" r="' + POMO_RING_R + '"></circle>' +
      '<circle class="pomo-ring-progress" id="pomo-ring-progress" cx="100" cy="100" r="' + POMO_RING_R + '" ' +
      'stroke-dasharray="' + POMO_RING_CIRCUMFERENCE + '" stroke-dashoffset="' + offset + '"></circle>' +
      '</svg>' +
      '<div class="pomodoro-ring-center">' +
      '<div class="pomodoro-mode" id="pomo-mode">' + (pomo.mode === 'work' ? 'Focus' : 'Break') + '</div>' +
      '<div class="pomodoro-time" id="pomo-time">' + formatPomoTime(pomo.secondsLeft) + '</div>' +
      '</div></div>' +
      '<div class="pomodoro-dots" id="pomo-dots">' + pomoDotsText() + '</div>' +
      '<div class="pomodoro-session-label" id="pomo-session-label">' + pomoSessionLabel() + '</div>' +
      '<div class="pomodoro-controls">' +
      '<button id="pomo-toggle" class="pomo-btn pomo-btn-primary">' + (pomo.running ? 'Pause' : 'Start') + '</button>' +
      '<button id="pomo-reset" class="pomo-btn pomo-btn-secondary">Reset</button>' +
      '<button id="pomo-skip" class="pomo-btn pomo-btn-secondary">Skip</button>' +
      '</div>' +
      '<p class="pomo-notify-permanent-tip">🔔 Notifications need your computer’s permission too, not just this site’s — check your OS’s own notification settings for this browser if they don’t show up.</p>' +
      renderPomoNotifyNotice() +
      '<div class="pomo-settings" id="pomo-settings" hidden>' +
      '<div class="pomo-setting-row"><label for="pomo-set-work">Focus</label><input type="number" id="pomo-set-work" min="1" max="180" value="' + pomoSettings.work + '"><span>min</span></div>' +
      '<div class="pomo-setting-row"><label for="pomo-set-short">Short break</label><input type="number" id="pomo-set-short" min="1" max="60" value="' + pomoSettings.shortBreak + '"><span>min</span></div>' +
      '<div class="pomo-setting-row"><label for="pomo-set-long">Long break</label><input type="number" id="pomo-set-long" min="1" max="90" value="' + pomoSettings.longBreak + '"><span>min</span></div>' +
      '<div class="pomo-setting-row"><label for="pomo-set-cycle">Sessions / long break</label><input type="number" id="pomo-set-cycle" min="1" max="12" value="' + pomoSettings.cycle + '"><span></span></div>' +
      '<button class="pomo-test-sound" id="pomo-test-sound" type="button">🔊 Test sound</button>' +
      '<button class="pomo-test-sound" id="pomo-test-notify" type="button">🔔 Test notification</button>' +
      '<p class="pomo-notify-tip">Nothing showed up? The site allowing notifications isn’t the same as your computer allowing them for this browser — check your OS’s own notification settings for it too.</p>' +
      '<button class="pomo-btn pomo-btn-primary pomo-settings-save" id="pomo-settings-save" type="button">Save</button>' +
      '</div>' +
      '</div>';
  }

  function renderTodayCard(day, missedBeforeCount) {
    var html = '<div class="today-card fade-in">';
    html += '<div class="today-tag">Today</div>';
    html += '<div class="today-date">' + dayLabel(day.date) + '</div>';
    if (missedBeforeCount > 0) {
      html += '<div class="catchup-warn">⚠️ ' + missedBeforeCount + ' day' + (missedBeforeCount === 1 ? '' : 's') +
        ' incomplete before today. Today’s content builds on those, so consider catching up first.</div>';
    }
    day.tasks.forEach(function (t) {
      html += taskRowHtml(day.date, t);
    });
    html += '</div>';
    return html;
  }

  // Non-native accordion (div-based, not <details>/<summary>) so the
  // expand/collapse animates smoothly via a CSS grid-rows transition,
  // instead of the native element's instant snap-open.
  function renderDay(day) {
    var status = dayStatus(day);
    var isOpen = state.expanded.has(day.date);
    var statusLabel = status === 'complete' ? '✅ Complete' : status === 'missed' ? '⚠️ Missed' : 'Upcoming';

    var body = '';
    day.tasks.forEach(function (t) {
      body += taskRowHtml(day.date, t);
    });

    return '<div class="day fade-in" data-date="' + day.date + '">' +
      '<div class="day-summary" role="button" tabindex="0" aria-expanded="' + isOpen + '">' +
      '<svg class="day-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 6L15 12L9 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '<span class="day-date">' + dayLabel(day.date) + '</span>' +
      '<span class="day-status ' + status + '">' + statusLabel + '</span></div>' +
      '<div class="day-body-wrap' + (isOpen ? ' expanded' : '') + '"><div class="day-body-inner"><div class="day-body">' + body + '</div></div></div>' +
      '</div>';
  }

  function taskRowHtml(date, t) {
    var id = 'task-' + date + '-' + hashKey(t.subject + '|' + t.task_text);
    return '<label class="task-row' + (t.completed ? ' done' : '') + '" for="' + id + '">' +
      '<input type="checkbox" id="' + id + '" data-date="' + date + '" data-subject="' + escapeAttr(t.subject) + '" data-task="' + escapeAttr(t.task_text) + '"' + (t.completed ? ' checked' : '') + '>' +
      '<span class="task-text"><span class="task-subject">' + escapeHtml(t.subject) + ':</span> ' + escapeHtml(t.task_text) + '</span>' +
      '</label>';
  }

  // Focus Mode integrates with the History API so the browser Back button
  // exits it instead of navigating away from the tracker page entirely — entering
  // pushes a history entry, and leaving (Back button or the Exit focus
  // button, which triggers the same pop) is what flips state.focus back off.
  function enterFocus() {
    state.focus = true;
    saveFocusActive(true);
    history.pushState({ focus: true }, '');
    renderCalendar();
    refreshLeaderboard();
    startLeaderboardTimerTick();
    startLeaderboardPoll();
  }

  // Shared by the "Focus mode" toggle button and the top-5 champions card
  // (clicking it also jumps to Focus Mode — see bindCalendarEvents) — a
  // guest gets the same sign-up prompt either way, rather than a silent
  // no-op or a confusing error.
  function goToFocusMode() {
    if (state.focus) {
      exitFocus();
    } else if (!state.student) {
      pendingFocusMode = true;
      renderRegisterForm();
    } else {
      enterFocus();
    }
  }

  // ── Weekly focus leaderboard — public display names, ranked by focus
  // minutes logged since Monday (resets weekly server-side, see
  // pomodoro-leaderboard.js). Only rendered/fetched in Focus Mode.
  var LEADERBOARD_MEDALS = ['🥇', '🥈', '🥉'];

  // Rank-movement tracking — populated by refreshLeaderboard just before
  // it overwrites state.leaderboard/state.viewerRank with fresh data, so
  // renderLeaderboardRows can compare "where they are now" against
  // "where they were a moment ago" and show an up/down arrow. Empty on
  // the very first load (nothing to compare against yet), which is
  // exactly right — no marker should show until at least one refresh
  // has actually happened.
  var previousRankByName = {};
  var previousViewerRank = null;

  // Small ▲/▼ next to the rank number when it changed since the last
  // refresh (see previousRankByName/previousViewerRank above) — nothing
  // rendered for a first-ever appearance (prevRank undefined/null) or an
  // unchanged rank, same "don't show noise" reasoning as the streak
  // balls' empty-state span.
  function rankMovementHtml(currentRank, prevRank) {
    if (prevRank === undefined || prevRank === null || prevRank === currentRank) return '';
    var up = currentRank < prevRank;
    return '<span class="rank-move ' + (up ? 'rank-up' : 'rank-down') + '" title="' +
      (up ? 'Up from #' : 'Down from #') + prevRank + '">' + (up ? '▲' : '▼') + '</span>';
  }

  // "Live now" dot before a name — is_live comes from pomodoro-
  // leaderboard.js (running=true and that phase's countdown hasn't
  // finished yet, see the comment there). Wrapped in a plain
  // (non-shadowed, non-radius) span that's what actually gets animated,
  // per CLAUDE.md's Chromium DOM-node-leak gotcha: animating transform
  // directly on an element that also carries both box-shadow and
  // border-radius (.live-dot itself, for its glow) leaks detached nodes.
  // .live-dot-slot is always rendered, live or not — omitting it
  // entirely for non-live rows meant every name's text started at a
  // different x depending on whether the row before it had a dot,
  // exactly the same row-to-row misalignment already fixed once for the
  // streak balls (see streakBallsHtml above). A fixed-width slot keeps
  // every name starting at the same offset regardless.
  function liveDotHtml(isLive) {
    var dot = isLive ? '<span class="live-dot-wrap" title="In a focus session right now"><span class="live-dot"></span></span>' : '';
    return '<span class="live-dot-slot">' + dot + '</span>';
  }

  // Streak shown as a row of small balls between the name and minutes
  // columns, rather than the number alone — capped at STREAK_BALLS_CAP so
  // a long streak doesn't blow out the row's width; anything beyond that
  // collapses into a "+N" after the last ball. Nothing renders for a
  // zero streak (an empty column reads more cleanly than a row of hollow
  // balls for every non-streaking student).
  var STREAK_BALLS_CAP = 5;
  function streakBallsHtml(streak) {
    if (!streak) return '<span class="leaderboard-streak"></span>';
    var filled = Math.min(streak, STREAK_BALLS_CAP);
    var balls = '';
    for (var i = 0; i < filled; i++) balls += '<span class="streak-ball"></span>';
    var overflow = streak > STREAK_BALLS_CAP ? '<span class="streak-ball-overflow">+' + (streak - STREAK_BALLS_CAP) + '</span>' : '';
    return '<span class="leaderboard-streak" title="' + streak + ' day streak">' + balls + overflow + '</span>';
  }

  // Status badge ("Focus"/"Break") for a live student's current phase —
  // pomo_status comes straight from pomo_active_session's mode column
  // ('work'|'break', see schema.sql), null for anyone not live. Blank
  // span (not omitted) when null: this is already its own dedicated
  // grid column, so unlike the inline live-dot-in-name case there's no
  // row-to-row alignment risk from leaving it empty.
  // "Xm ago" / "Xh ago" / "Xd ago" — coarse on purpose (rounded to the
  // nearest unit, no seconds granularity), since this only needs to
  // refresh whenever the leaderboard itself does (the 30s smart-poll or
  // a load/action refresh), not tick live like the countdown does.
  function formatLastSeen(epochMs) {
    var diffMin = Math.max(0, Math.round((Date.now() - epochMs) / 60000));
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return diffMin + 'm ago';
    var diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return diffHr + 'h ago';
    return Math.round(diffHr / 24) + 'd ago';
  }

  // mode set -> the Focus/Break pill. Otherwise, if there's a
  // pomo_last_seen_at (they've used Pomodoro before, just not right
  // now), show when instead of leaving the column blank — "not live"
  // isn't the same as "never seen", and the latter is more useful at a
  // glance. Genuinely null (never touched Pomodoro at all) stays blank.
  function pomoStatusHtml(mode, lastSeenAt) {
    if (mode) {
      var isWork = mode === 'work';
      return '<span class="leaderboard-status ' + (isWork ? 'pomo-work' : 'pomo-break') + '">' + (isWork ? 'Focus' : 'Break') + '</span>';
    }
    if (lastSeenAt) {
      return '<span class="leaderboard-status pomo-idle" title="Last seen ' + escapeAttr(new Date(lastSeenAt).toLocaleString()) + '">' + formatLastSeen(lastSeenAt) + '</span>';
    }
    return '<span class="leaderboard-status"></span>';
  }

  // Live mm:ss countdown for a live student's current phase — computed
  // fresh from data-phase-end on every tick (tickLeaderboardTimers)
  // rather than a value baked in at render time, since that would
  // already be stale a second later. Blank span (not omitted) when not
  // live, same reasoning as pomoStatusHtml — its own dedicated grid
  // column, so no row-to-row alignment risk from leaving it empty.
  function pomoTimerHtml(phaseEndAt) {
    if (!phaseEndAt) return '<span class="leaderboard-timer"></span>';
    var remaining = Math.max(0, Math.round((phaseEndAt - Date.now()) / 1000));
    return '<span class="leaderboard-timer" data-phase-end="' + phaseEndAt + '">' + formatPomoTime(remaining) + '</span>';
  }

  // Ticks every .leaderboard-timer[data-phase-end] currently in the DOM
  // once a second — re-queried fresh each tick (not a cached element
  // list) so it transparently picks up whatever refreshLeaderboard just
  // rendered, no need to restart the interval on every refresh. Started
  // on entering Focus Mode, stopped on leaving it (see enterFocus/
  // setupFocusHistory) so it doesn't keep ticking against a torn-down
  // leaderboard after Exit Focus.
  var leaderboardTimerTickId = null;
  function tickLeaderboardTimers() {
    var now = Date.now();
    document.querySelectorAll('.leaderboard-timer[data-phase-end]').forEach(function (el) {
      var remaining = Math.max(0, Math.round((Number(el.dataset.phaseEnd) - now) / 1000));
      el.textContent = formatPomoTime(remaining);
    });
  }
  function startLeaderboardTimerTick() {
    if (leaderboardTimerTickId) return;
    leaderboardTimerTickId = setInterval(tickLeaderboardTimers, 1000);
  }
  function stopLeaderboardTimerTick() {
    if (!leaderboardTimerTickId) return;
    clearInterval(leaderboardTimerTickId);
    leaderboardTimerTickId = null;
  }

  // Smart refresh for is_live/pomo_status/pomo_phase_end_at while Focus
  // Mode is open — these can go stale between the load/action-triggered
  // refreshes elsewhere (someone else starts, pauses, or finishes a
  // session with nobody here doing anything to trigger a re-fetch).
  // Deliberately reuses the existing /pomodoro-leaderboard endpoint
  // rather than adding a new one — its response is already small
  // (~3KB, confirmed), and a dedicated live-only endpoint would need to
  // either send back student emails (this endpoint intentionally never
  // does, see its own comment) or rely on rank-order position matching
  // the full fetch, which can drift the instant anyone's minutes change
  // mid-poll. Not worth the complexity for a payload that's already tiny.
  //
  // The actual bandwidth-saving lever is visibility, not payload size:
  // polling is paused entirely (the interval is cleared, not just
  // skipped) whenever the tab isn't in the foreground — nobody's
  // watching a backgrounded leaderboard, so there's nothing to gain by
  // keeping it fresh. One immediate refresh fires the moment the tab
  // becomes visible again (rather than waiting up to the full interval)
  // so a long-backgrounded tab catches up right away instead of showing
  // stale live-status for up to 30s after being refocused.
  var LEADERBOARD_POLL_MS = 30000;
  var leaderboardPollId = null;
  function startLeaderboardPoll() {
    stopLeaderboardPoll();
    if (document.hidden) return; // visibilitychange below starts it once actually visible
    leaderboardPollId = setInterval(refreshLeaderboard, LEADERBOARD_POLL_MS);
  }
  function stopLeaderboardPoll() {
    if (!leaderboardPollId) return;
    clearInterval(leaderboardPollId);
    leaderboardPollId = null;
  }

  function renderLeaderboardRows() {
    if (!state.leaderboard.length) {
      return '<p class="center-note" style="padding:14px 0;">No focus sessions logged yet. Be the first!</p>';
    }
    var rows = state.leaderboard.map(function (r, i) {
      var timeLabel = r.total_minutes + 'm';
      var rankLabel = LEADERBOARD_MEDALS[i] || (i + 1);
      // Session count isn't shown — it's not a comparable stat once session
      // length is customizable per student (pomoSettings.work, 1-180min);
      // total_minutes already accounts for that correctly and is what
      // actually ranks the list, so it's the only number displayed too.
      return '<div class="leaderboard-row' + (i < 3 ? ' leaderboard-row--top' : '') + (r.is_me ? ' leaderboard-row--me' : '') + '">' +
        '<span class="leaderboard-rank">' + rankLabel + rankMovementHtml(i + 1, previousRankByName[r.display_name]) + '</span>' +
        '<span class="leaderboard-name">' + liveDotHtml(r.is_live) + escapeHtml(r.display_name) + (r.is_me ? ' <span class="leaderboard-you">You</span>' : '') + '</span>' +
        streakBallsHtml(r.streak) +
        pomoStatusHtml(r.pomo_status, r.pomo_last_seen_at) +
        pomoTimerHtml(r.pomo_phase_end_at) +
        '<span class="leaderboard-time">' + timeLabel + '</span>' +
        '</div>';
    }).join('');
    // A logged-in viewer outside the top 20 (state.leaderboard never
    // contains their row at all — see pomodoro-leaderboard.js) otherwise
    // has zero visibility into their own standing. Shown as a separate
    // "gap + own row" beneath the list instead of folded into it, since
    // their actual rank is nowhere near position 21.
    if (state.viewerRank) {
      rows += '<div class="leaderboard-gap">···</div>' +
        '<div class="leaderboard-row leaderboard-row--me">' +
        '<span class="leaderboard-rank">' + state.viewerRank.rank + rankMovementHtml(state.viewerRank.rank, previousViewerRank) + '</span>' +
        '<span class="leaderboard-name">' + liveDotHtml(state.viewerRank.is_live) + 'You</span>' +
        streakBallsHtml(state.viewerRank.streak) +
        pomoStatusHtml(state.viewerRank.pomo_status, state.viewerRank.pomo_last_seen_at) +
        pomoTimerHtml(state.viewerRank.pomo_phase_end_at) +
        '<span class="leaderboard-time">' + state.viewerRank.total_minutes + 'm</span>' +
        '</div>';
    }
    return rows;
  }

  function renderLeaderboardCard() {
    return '<div class="leaderboard-card fade-in" id="leaderboard-card">' +
      '<div class="leaderboard-title">Mission IIT Leaderboard</div>' +
      '<div class="leaderboard-subtitle">Top 20 by minutes logged · Resets every Monday</div>' +
      // Mirrors each row's exact rank/name/streak/time widths so every
      // label sits directly above its column on every row, not just
      // approximately near it.
      '<div class="leaderboard-columns"><span class="leaderboard-col-rank">Rank</span><span class="leaderboard-col-name">Name</span><span class="leaderboard-col-streak">Streak</span><span class="leaderboard-col-status">Status</span><span class="leaderboard-col-timer">Timer</span><span class="leaderboard-col-time">Minutes</span></div>' +
      '<div id="leaderboard-rows">' + renderLeaderboardRows() + '</div>' +
      '</div>';
  }

  // Patches #leaderboard-rows in place rather than the whole card, so the
  // card's own .fade-in entrance doesn't replay every time this refreshes.
  function refreshLeaderboard() {
    var q = state.student ? '?email=' + encodeURIComponent(state.student.email) : '';
    api('/pomodoro-leaderboard' + q)
      .then(function (r) {
        // Snapshot the rank each name held right before this refresh
        // overwrites state.leaderboard, so renderLeaderboardRows can show
        // an up/down arrow relative to it. Matched by display_name, not
        // email — pomodoro-leaderboard.js deliberately never sends student
        // emails to the client (see its own top comment), and this is
        // purely a same-viewer, same-session comparison against whatever
        // was already on screen, not a stored identity. The viewer's own
        // below-list row is tracked separately (by rank number, not name)
        // since its name always literally renders as "You".
        previousRankByName = {};
        state.leaderboard.forEach(function (l, i) { previousRankByName[l.display_name] = i + 1; });
        previousViewerRank = state.viewerRank ? state.viewerRank.rank : null;

        state.leaderboard = r.leaderboard || [];
        state.viewerRank = r.viewerRank || null;
        var rows = document.getElementById('leaderboard-rows');
        if (rows) rows.innerHTML = renderLeaderboardRows();
        // Armed here, not at the outer card's own render — #leaderboard-card
        // deliberately isn't re-rendered on refresh (only #leaderboard-rows
        // above is, to avoid replaying its .fade-in entrance), so checking
        // placement at render time would see stale/empty data from before
        // this fetch resolved. This fires with the real, current numbers.
        armConfetti('leaderboard-card', 'top20-' + mondayOf(todayIso()),
          state.leaderboard.some(function (l) { return l.is_me; }) || !!state.viewerRank);
      })
      .catch(function () { /* non-critical — leaderboard just stays stale */ });
  }

  function recordPomodoroCompletion(minutes) {
    if (!state.student) return; // guests aren't tracked — no identity to credit
    api('/pomodoro-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: state.student.email, minutes: minutes }),
    })
      .then(refreshLeaderboard)
      .catch(function () { /* non-critical — this session just won't count this time */ });
  }

  // Whenever state.focus becomes true (enterFocus, or the reload restore
  // in init()), it's always paired with a real {focus:true} history entry
  // (pushState or replaceState respectively) — so there's always something
  // valid for the Back button, or this function, to land on.
  function exitFocus() {
    history.back();
  }

  // Deliberately doesn't inspect e.state here (only whether we were in
  // Focus Mode going in) — a same-URL navigation (e.g. clicking "Progress
  // Tracker" in the nav while already on this page) can leave a *stale*
  // {focus:true} state attached to a history entry Chromium reuses/
  // preserves rather than replacing (confirmed empirically), so trusting
  // e.state.focus directly can resurrect Focus Mode from an unrelated,
  // already-exited session once the user hits Back. Since the only way
  // state.focus is ever true is our own code setting it, and the only
  // reason popstate fires while it's true is the user pressing Back,
  // "exit" is the only correct interpretation regardless of what's
  // actually attached to the entry being popped to.
  function setupFocusHistory() {
    window.addEventListener('popstate', function () {
      if (state.focus) {
        state.focus = false;
        saveFocusActive(false);
        stopLeaderboardTimerTick();
        stopLeaderboardPoll();
        renderCalendar();
      }
    });
  }

  function bindCalendarEvents() {
    var notYou = document.getElementById('not-you');
    if (notYou) notYou.addEventListener('click', function () {
      clearCookie();
      state.student = null;
      loadMonth(state.month);
    });

    var renameToggle = document.getElementById('rename-toggle');
    if (renameToggle) renameToggle.addEventListener('click', function () {
      state.renaming = true;
      state.renameError = null;
      renderCalendar();
      var input = document.getElementById('rename-input');
      if (input) { input.focus(); input.select(); }
    });

    var renameCancel = document.getElementById('rename-cancel');
    if (renameCancel) renameCancel.addEventListener('click', function () {
      state.renaming = false;
      state.renameError = null;
      renderCalendar();
    });

    var renameForm = document.getElementById('rename-form');
    if (renameForm) renameForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = document.getElementById('rename-input');
      var newName = input.value.trim();
      if (!newName) return;
      var btn = renameForm.querySelector('.rename-save');
      btn.disabled = true;
      api('/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: state.student.email, display_name: newName }),
      })
        .then(function (updated) {
          state.student.display_name = updated.display_name;
          writeCookie(state.student);
          state.renaming = false;
          state.renameError = null;
          renderCalendar();
        })
        .catch(function (err) {
          state.renameError = err.message;
          renderCalendar();
        });
    });

    var focusToggle = document.getElementById('focus-toggle');
    if (focusToggle) focusToggle.addEventListener('click', goToFocusMode);

    // Whole top-5 champions card is clickable, jumping to Focus Mode —
    // only rendered outside Focus Mode to begin with, so there's no
    // exitFocus branch to worry about firing unexpectedly here. Keyboard-
    // reachable too (role="button" tabindex="0" on the element itself),
    // so Enter/Space need to trigger it same as a click.
    var championsCard = document.getElementById('champions-card');
    if (championsCard) {
      championsCard.addEventListener('click', goToFocusMode);
      championsCard.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goToFocusMode();
        }
      });
    }

    var pomoToggle = document.getElementById('pomo-toggle');
    if (pomoToggle) pomoToggle.addEventListener('click', pomoToggleRun);
    var pomoReset_ = document.getElementById('pomo-reset');
    if (pomoReset_) pomoReset_.addEventListener('click', pomoReset);
    var pomoSkip_ = document.getElementById('pomo-skip');
    if (pomoSkip_) pomoSkip_.addEventListener('click', pomoSkip);

    var pomoSettingsToggle = document.getElementById('pomo-settings-toggle');
    if (pomoSettingsToggle) pomoSettingsToggle.addEventListener('click', function () {
      var panel = document.getElementById('pomo-settings');
      if (panel) panel.hidden = !panel.hidden;
    });
    var pomoSettingsSave = document.getElementById('pomo-settings-save');
    if (pomoSettingsSave) pomoSettingsSave.addEventListener('click', applyPomoSettings);

    var pomoTestSound = document.getElementById('pomo-test-sound');
    if (pomoTestSound) pomoTestSound.addEventListener('click', function () {
      ensurePomoAudioCtx();
      // Previews both, back to back, since there are now two distinct
      // chimes — 700ms covers one chime's own ~0.63s (two tones 0.18s
      // apart, each ringing for 0.45s) before the next one starts.
      playPomoChime('work');
      setTimeout(function () { playPomoChime('break'); }, 700);
    });

    var pomoTestNotify = document.getElementById('pomo-test-notify');
    if (pomoTestNotify) pomoTestNotify.addEventListener('click', function () {
      // Reachable only once notifications are already 'granted' (this
      // button lives in the unlocked timer view, not the gate), so this
      // isolates whether a real OS notification actually reaches the
      // screen — if this test button also shows nothing, the site's own
      // logic isn't the problem; look at the OS's own per-app notification
      // settings for the browser instead of the website's permission.
      try {
        new Notification('Test notification 🔔', {
          body: 'If you can see this, notifications are working.',
          tag: 'taai-pomo-test',
          icon: '/favicon-32.png',
        });
      } catch (e) { /* not critical */ }
    });

    var pomoGateReload = document.getElementById('pomo-gate-reload');
    if (pomoGateReload) pomoGateReload.addEventListener('click', function () {
      location.reload();
    });

    var prev = document.getElementById('prev-month');
    if (prev) prev.addEventListener('click', function () { loadMonth(shiftMonth(state.month, -1)); });

    var next = document.getElementById('next-month');
    if (next) next.addEventListener('click', function () { loadMonth(shiftMonth(state.month, 1)); });

    Array.prototype.forEach.call(document.querySelectorAll('.day-summary'), function (el) {
      el.addEventListener('click', function () { toggleDay(el.closest('.day').dataset.date); });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDay(el.closest('.day').dataset.date); }
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.week-label'), function (el) {
      el.addEventListener('click', function () { toggleWeek(el.closest('.week').dataset.week); });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleWeek(el.closest('.week').dataset.week); }
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.task-row input[type="checkbox"]'), function (cb) {
      cb.addEventListener('change', onTaskToggle);
    });
  }

  function toggleDay(date) {
    var el = document.querySelector('.day[data-date="' + date + '"]');
    if (!el) return;
    var wrap = el.querySelector('.day-body-wrap');
    var summary = el.querySelector('.day-summary');
    var open = state.expanded.has(date);
    if (open) { state.expanded.delete(date); } else { state.expanded.add(date); }
    wrap.classList.toggle('expanded', !open);
    summary.setAttribute('aria-expanded', String(!open));
  }

  function toggleWeek(wk) {
    var el = document.querySelector('.week[data-week="' + wk + '"]');
    if (!el) return;
    var wrap = el.querySelector('.week-body-wrap');
    var label = el.querySelector('.week-label');
    var collapsed = state.collapsedWeeks.has(wk);
    if (collapsed) { state.collapsedWeeks.delete(wk); } else { state.collapsedWeeks.add(wk); }
    wrap.classList.toggle('expanded', collapsed);
    label.setAttribute('aria-expanded', String(collapsed));
  }

  function onTaskToggle(e) {
    var cb = e.target;
    var completed = cb.checked;
    var date = cb.dataset.date, subject = cb.dataset.subject, taskText = cb.dataset.task;
    var row = cb.closest('.task-row');

    if (!state.student) {
      cb.checked = !completed;
      pendingTask = { date: date, subject: subject, task_text: taskText, completed: completed };
      renderRegisterForm();
      return;
    }

    row.classList.toggle('done', completed);
    cb.disabled = true;

    api('/complete-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: state.student.email, date: date, subject: subject, task_text: taskText, completed: completed }),
    })
      .then(function () {
        var day = state.days.find(function (d) { return d.date === date; });
        var task = day && day.tasks.find(function (t) { return t.subject === subject && t.task_text === taskText; });
        if (task) task.completed = completed;
        cb.disabled = false;
        refreshSubjectProgress();
        patchHeatmapCell(date);
        patchDayStatus(date);
        patchWeekStatus(date);
        refreshCatchupWarn();
        refreshStreak();
      })
      .catch(function () {
        cb.checked = !completed;
        row.classList.toggle('done', !completed);
        cb.disabled = false;
      });
  }

  // ── Utils ───────────────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escapeAttr(str) { return escapeHtml(str).replace(/`/g, '&#96;'); }
  function hashKey(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
    return Math.abs(h).toString(36);
  }

  // Recompute immediately on returning to the tab, rather than waiting for
  // the next throttled interval tick — a background tab's timer can be
  // delayed by Chrome's intensive throttling, so without this the display
  // would sit stale (or a finished phase wouldn't advance) until whenever
  // the browser next lets the interval fire. Same event also drives the
  // leaderboard's smart-refresh pause/resume (see startLeaderboardPoll) —
  // stopped while backgrounded since nobody's watching it, caught up with
  // one immediate refresh rather than waiting up to LEADERBOARD_POLL_MS
  // the moment it's visible again.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && pomo.running) pomoTick();
    if (state.focus) {
      if (document.hidden) stopLeaderboardPoll();
      else { refreshLeaderboard(); startLeaderboardPoll(); }
    }
  });

  // Focus Mode is desktop-only (same 1080px breakpoint that hides
  // .focus-toggle-wrap in CSS) — the button being hidden stops someone from
  // entering it fresh on a phone/iPad-portrait, but doesn't help if they
  // rotate an iPad from landscape to portrait mid-session, since state.focus
  // stays true and CSS alone can't back that out. This kicks them back to
  // the normal checklist the moment the viewport crosses the breakpoint.
  window.addEventListener('resize', function () {
    if (state.focus && window.innerWidth <= 1080) exitFocus();
  });

  init();
  setupScrollEffects();
  setupFocusHistory();
})();
