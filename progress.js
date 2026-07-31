(function () {
  'use strict';

  // Confirmed official GATE DA 2027 exam date.
  var EXAM_DATE = '2027-02-06';

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
  function savePomoActiveState() {
    try {
      localStorage.setItem(POMO_ACTIVE_KEY, JSON.stringify({
        mode: pomo.mode,
        running: pomo.running,
        secondsLeft: pomo.secondsLeft,
        totalSeconds: pomo.totalSeconds,
        phaseEndAt: pomo.phaseEndAt,
        completedSessions: pomo.completedSessions,
      }));
    } catch (e) { /* localStorage unavailable — refresh just won't resume, not critical */ }
  }
  function loadPomoActiveState() {
    try {
      var raw = localStorage.getItem(POMO_ACTIVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
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
    lastWeekLeaders: [], // [{ display_name, total_minutes }] — top 5 by focus minutes last week, shown outside Focus Mode
    streak: null,
    subjectProgress: [], // [{ subject, done, total }] — global, independent of viewed month
    expanded: new Set(), // dates whose day-card is open, non-native accordion
    collapsedWeeks: new Set(), // week keys (Monday date) currently collapsed
    initializedWeeks: new Set(), // week keys already given their one-time default collapse state
    // Never persisted — every fresh visit (reload or reopen) lands on the
    // main checklist, never resumes straight into Focus Mode.
    focus: false,
    leaderboard: [], // [{ display_name, total_minutes, total_sessions }] — Focus Mode only
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
  // Restores a running/paused pomodoro across a refresh (see
  // savePomoActiveState). Deliberately restarts the interval right here —
  // independent of whether Focus Mode happens to be open — so the timer
  // keeps counting down, completing phases, and crediting sessions in the
  // background exactly as if the refresh had never happened; Focus Mode
  // just displays whatever it finds whenever it's next opened. One
  // limitation that can't be worked around: the chime needs a fresh user
  // gesture to unlock audio (see ensurePomoAudioCtx), which a page load
  // doesn't provide, so a phase that completes before the next click will
  // only notify, not chime — the notification is what's mandatory instead.
  function restorePomoActiveState() {
    var saved = loadPomoActiveState();
    if (!saved) return;
    pomo.mode = saved.mode;
    pomo.totalSeconds = saved.totalSeconds;
    pomo.completedSessions = saved.completedSessions || 0;
    if (saved.running) {
      pomo.phaseEndAt = saved.phaseEndAt;
      pomo.running = true;
      pomoTick(); // catches up immediately if time already ran out while away
      if (pomo.running) pomo.timerId = setInterval(pomoTick, 1000);
    } else {
      pomo.secondsLeft = saved.secondsLeft;
      pomo.running = false;
    }
  }

  function init() {
    state.student = readCookie();
    restorePomoActiveState();
    loadMonth(state.month);
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
      '<h1>MISSION IIT🎯</h1>' +
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

    // Guests (no student yet) only need the public schedule — the other
    // endpoints are all per-student and would 400 without an email.
    // last-week-focus-leaders is public/unpersonalized like the schedule,
    // so it's always included regardless of login state — it's re-fetched
    // on every month nav too, which is mildly redundant (the data has
    // nothing to do with which month is being browsed) but simple, and
    // cheap enough not to matter.
    var calls = [
      api('/schedule?month=' + monthStr),
      api('/last-week-focus-leaders').catch(function () { return { leaders: [] }; }),
    ];
    if (state.student) {
      calls.push(
        api('/progress?email=' + encodeURIComponent(state.student.email) + '&month=' + monthStr),
        api('/streak?email=' + encodeURIComponent(state.student.email)).catch(function () { return { streak: null }; }),
        api('/subject-progress?email=' + encodeURIComponent(state.student.email)).catch(function () { return { subjects: [] }; }),
        // Non-critical if it fails — a fetch error here just means whatever
        // localStorage/defaults are already loaded stay in effect for this
        // load, not that the pomodoro timer breaks.
        api('/pomo-settings?email=' + encodeURIComponent(state.student.email)).catch(function () { return null; }),
        api('/pomo-sessions?email=' + encodeURIComponent(state.student.email)).catch(function () { return null; })
      );
    }

    Promise.all(calls)
      .then(function (results) {
        var scheduleDays = results[0].days || [];
        state.latestScheduledMonth = results[0].latestMonth || null;
        state.lastWeekLeaders = results[1].leaders || [];
        var progressRows = state.student ? (results[2].progress || []) : [];
        state.streak = state.student ? results[3].streak : null;
        state.subjectProgress = state.student ? (results[4].subjects || []) : [];

        // Only present once a student has actually saved custom durations
        // somewhere before (see applyPomoSettings) — merge in place of
        // whatever localStorage/defaults loaded at module-init time, so a
        // student's setup follows them to a new device/browser instead of
        // only living in the one that saved it.
        var savedPomo = state.student ? results[5] : null;
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
        var dailySessions = state.student ? results[6] : null;
        if (dailySessions) {
          pomo.completedSessions = Math.max(pomo.completedSessions, dailySessions.sessionsCompleted || 0);
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

  // ── Last week's top 5 by focus minutes — outside Focus Mode, in the
  // side column, so it's visible without entering the timer. Public/
  // unpersonalized like the live weekly leaderboard, so this shows for
  // guests too. Renders nothing at all if last week had no data yet
  // (a brand new week, or nobody used the timer) rather than showing an
  // empty-looking card.
  function renderLastWeekChampions() {
    var leaders = state.lastWeekLeaders || [];
    if (!leaders.length) return '';
    var rows = leaders.map(function (l, i) {
      var rank = LEADERBOARD_MEDALS[i] || (i + 1);
      return '<div class="leaderboard-row' + (i < 3 ? ' leaderboard-row--top' : '') + '">' +
        '<span class="leaderboard-rank">' + rank + '</span>' +
        '<span class="leaderboard-name">' + escapeHtml(l.display_name) + '</span>' +
        '<span class="leaderboard-time">' + l.total_minutes + 'm</span>' +
        '</div>';
    }).join('');
    return '<div class="leaderboard-card side-champions-card fade-in">' +
      '<div class="leaderboard-title">🏆 Last Week’s Focus Champions</div>' +
      '<div class="leaderboard-subtitle">Top 5 by minutes logged</div>' +
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
    html += '<div class="roadmap-head"><h1>MISSION IIT🎯</h1></div>';
    html += '<div class="roadmap-sub">' +
      '<div class="roadmap-sub-left">' + renderIdentityLine() + '</div>' +
      '</div>';
    // Rendered inside main-col below (not here) when not in Focus Mode, so it
    // centers against the calendar column's own width, not the full page
    // width including the sidebar — otherwise it visually floats off-center
    // from the cards it actually belongs to.
    if (state.focus) {
      html += '<div class="focus-toggle-wrap"><button id="focus-toggle" class="focus-toggle active">✕ Exit focus</button></div>';
    }

    if (!state.focus) html += '<div class="page-grid"><div class="main-col">';

    if (!state.focus) {
      html += '<div class="focus-toggle-wrap"><button id="focus-toggle" class="focus-toggle">◎ Focus mode</button></div>';
      html += '<div id="streak-panel">' + renderStreakHero() + '</div>';

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
      var lastWeekKey = null;
      var weekNum = 0;
      var weekOpen = true;
      otherDays.forEach(function (day) {
        var wk = mondayOf(day.date);
        if (wk !== lastWeekKey) {
          if (lastWeekKey !== null) html += '</div></div></div>'; // week-body-inner, week-body-wrap, week
          weekNum++;
          lastWeekKey = wk;
          weekOpen = !state.collapsedWeeks.has(wk);
          html += '<div class="week" data-week="' + wk + '">' +
            '<div class="week-label" role="button" tabindex="0" aria-expanded="' + weekOpen + '">' +
            '<svg class="week-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 6L15 12L9 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '<span>Week ' + weekNum + '</span></div>' +
            '<div class="week-body-wrap' + (weekOpen ? ' expanded' : '') + '"><div class="week-body-inner">';
        }
        html += renderDay(day);
      });
      if (lastWeekKey !== null) html += '</div></div></div>'; // week-body-inner, week-body-wrap, week

      if (!state.days.length) {
        html += '<p class="center-note">Nothing scheduled for ' + monthLabel(state.month) + ' yet.</p>';
      }

      html += '</div>'; // main-col
      html += '<div class="side-col">' +
        '<div id="heatmap-panel">' + renderHeatmap() + '</div>' +
        '<div id="subject-panel">' + renderSubjectBreakdown() + '</div>' +
        renderLastWeekChampions() +
        '</div>'; // side-col
      html += '</div>'; // page-grid
    }

    app.innerHTML = html;
    bindCalendarEvents();
    observeFadeIns();
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
    history.pushState({ focus: true }, '');
    renderCalendar();
    refreshLeaderboard();
  }

  // ── Weekly focus leaderboard — public display names, ranked by focus
  // minutes logged since Monday (resets weekly server-side, see
  // pomodoro-leaderboard.js). Only rendered/fetched in Focus Mode.
  var LEADERBOARD_MEDALS = ['🥇', '🥈', '🥉'];

  function renderLeaderboardRows() {
    if (!state.leaderboard.length) {
      return '<p class="center-note" style="padding:14px 0;">No focus sessions logged yet. Be the first!</p>';
    }
    return state.leaderboard.map(function (r, i) {
      var timeLabel = r.total_minutes + 'm';
      var rankLabel = LEADERBOARD_MEDALS[i] || (i + 1);
      // Session count isn't shown — it's not a comparable stat once session
      // length is customizable per student (pomoSettings.work, 1-180min);
      // total_minutes already accounts for that correctly and is what
      // actually ranks the list, so it's the only number displayed too.
      return '<div class="leaderboard-row' + (i < 3 ? ' leaderboard-row--top' : '') + (r.is_me ? ' leaderboard-row--me' : '') + '">' +
        '<span class="leaderboard-rank">' + rankLabel + '</span>' +
        '<span class="leaderboard-name">' + escapeHtml(r.display_name) + (r.is_me ? ' <span class="leaderboard-you">You</span>' : '') + '</span>' +
        '<span class="leaderboard-time">' + timeLabel + '</span>' +
        '</div>';
    }).join('');
  }

  function renderLeaderboardCard() {
    return '<div class="leaderboard-card fade-in" id="leaderboard-card">' +
      '<div class="leaderboard-title">🏆 Weekly Focus Leaderboard</div>' +
      '<div class="leaderboard-subtitle">Resets every Monday</div>' +
      '<div id="leaderboard-rows">' + renderLeaderboardRows() + '</div>' +
      '</div>';
  }

  // Patches #leaderboard-rows in place rather than the whole card, so the
  // card's own .fade-in entrance doesn't replay every time this refreshes.
  function refreshLeaderboard() {
    var q = state.student ? '?email=' + encodeURIComponent(state.student.email) : '';
    api('/pomodoro-leaderboard' + q)
      .then(function (r) {
        state.leaderboard = r.leaderboard || [];
        var rows = document.getElementById('leaderboard-rows');
        if (rows) rows.innerHTML = renderLeaderboardRows();
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

  function exitFocus() {
    if (history.state && history.state.focus) {
      history.back();
    } else {
      state.focus = false;
      renderCalendar();
    }
  }

  function setupFocusHistory() {
    window.addEventListener('popstate', function (e) {
      var wasFocus = state.focus;
      state.focus = !!(e.state && e.state.focus);
      if (wasFocus !== state.focus) renderCalendar();
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
    if (focusToggle) focusToggle.addEventListener('click', function () {
      if (state.focus) {
        exitFocus();
      } else if (!state.student) {
        pendingFocusMode = true;
        renderRegisterForm();
      } else {
        enterFocus();
      }
    });

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
  // the browser next lets the interval fire.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && pomo.running) pomoTick();
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
