(function () {
  'use strict';

  // Set this to the confirmed official GATE DA 2027 exam date ("YYYY-MM-DD")
  // to enable the exam countdown stat. Left null until that date is official
  // — showing a countdown to a guessed date would mislead students.
  var EXAM_DATE = null;

  var COOKIE_NAME = 'taai_user';
  var COOKIE_DAYS = 365;
  var FOCUS_KEY = 'taai_progress_focus';

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

  var pomo = {
    mode: 'work', // 'work' | 'break'
    secondsLeft: pomoSettings.work * 60,
    totalSeconds: pomoSettings.work * 60,
    running: false,
    timerId: null,
    completedSessions: 0,
  };

  var app = document.getElementById('app');
  var state = {
    student: null,
    month: currentMonthStr(),
    days: [], // [{ date, tasks: [{subject, task_text, position, completed}] }]
    streak: null,
    subjectProgress: [], // [{ subject, done, total }] — global, independent of viewed month
    expanded: new Set(), // dates whose day-card is open, non-native accordion
    focus: localStorage.getItem(FOCUS_KEY) === '1',
  };

  function init() {
    var student = readCookie();
    if (student) {
      state.student = student;
      loadMonth(state.month);
    } else {
      renderRegisterForm();
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
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function currentMonthStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
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
    app.innerHTML =
      '<div class="reg-card fade-in">' +
      '<h1>Welcome to your GATE DA 2027 Roadmap</h1>' +
      '<p>Enter your details once — we’ll remember you on this browser.</p>' +
      '<form id="reg-form">' +
      '<div class="reg-field"><label for="reg-email">Your email</label>' +
      '<input id="reg-email" type="email" required autocomplete="email"></div>' +
      '<div class="reg-field"><label for="reg-name">Your display name</label>' +
      '<input id="reg-name" type="text" required autocomplete="name"></div>' +
      (errorMsg ? '<p class="form-error">' + escapeHtml(errorMsg) + '</p>' : '') +
      '<button class="btn-primary" type="submit">Start Tracking</button>' +
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
          loadMonth(state.month);
        })
        .catch(function (err) {
          renderRegisterForm(err.message);
        });
    });

    observeFadeIns();
  }

  // ── Calendar ────────────────────────────────────────────────────────
  function loadMonth(monthStr) {
    state.month = monthStr;
    app.innerHTML = '<p class="center-note">Loading your roadmap…</p>';

    Promise.all([
      api('/schedule?month=' + monthStr),
      api('/progress?email=' + encodeURIComponent(state.student.email) + '&month=' + monthStr),
      api('/streak?email=' + encodeURIComponent(state.student.email)).catch(function () { return { streak: null }; }),
      api('/subject-progress?email=' + encodeURIComponent(state.student.email)).catch(function () { return { subjects: [] }; }),
    ])
      .then(function (results) {
        var scheduleDays = results[0].days || [];
        var progressRows = results[1].progress || [];
        state.streak = results[2].streak;
        state.subjectProgress = results[3].subjects || [];

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

        renderCalendar();
      })
      .catch(function (err) {
        app.innerHTML = '<p class="center-note">Couldn’t load your roadmap — ' + escapeHtml(err.message) + '</p>';
      });
  }

  function dayStatus(day) {
    var today = todayIso();
    if (day.date === today) return 'today';
    var allDone = day.tasks.length > 0 && day.tasks.every(function (t) { return t.completed; });
    if (allDone) return 'complete';
    return day.date < today ? 'missed' : 'upcoming';
  }

  // ── Streak hero ────────────────────────────────────────────────────
  function renderStreakHero() {
    var n = state.streak;
    var label = n === 1 ? 'day streak' : 'day streak';
    return '<div class="streak-hero fade-in">' +
      '<div class="streak-flame">🔥</div>' +
      '<div class="streak-number" id="streak-number">' + (n === null ? '—' : n) + '</div>' +
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
      var today = todayIso();
      var daysLeft = Math.max(0, Math.ceil((new Date(EXAM_DATE) - new Date(today)) / 864e5));
      html += '<div class="exam-countdown fade-in">📅 ' + daysLeft + ' days till exam</div>';
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
        ' incomplete before today. Today’s content builds on those — consider catching up first.';
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

  function renderCalendar() {
    var today = todayIso();
    var todayDay = state.days.find(function (d) { return d.date === today; });
    var missedBefore = state.days.filter(function (d) { return d.date < today && dayStatus(d) === 'missed'; });

    var html = '';
    html += '<div class="roadmap-head"><h1>🗺 GATE DA 2027 Roadmap</h1></div>';
    html += '<div class="roadmap-sub">' +
      '<div class="roadmap-sub-left">' + escapeHtml(state.student.display_name) + ' &middot; <button id="not-you">Not you?</button></div>' +
      '<button id="focus-toggle" class="focus-toggle' + (state.focus ? ' active' : '') + '">' + (state.focus ? '✕ Exit focus' : '◎ Focus mode') + '</button>' +
      '</div>';

    if (!state.focus) html += '<div class="page-grid"><div class="main-col">';

    if (!state.focus) {
      html += '<div id="streak-panel">' + renderStreakHero() + '</div>';
      html += '<div id="stats-panel">' + buildStatsPanelHtml() + '</div>';

      html += '<div class="month-nav"><button id="prev-month" aria-label="Previous month">&larr;</button>' +
        '<span class="month-label">' + monthLabel(state.month) + '</span>' +
        '<button id="next-month" aria-label="Next month">&rarr;</button></div>';
    }

    if (state.focus) html += renderPomodoro();

    if (todayDay) {
      html += renderTodayCard(todayDay, missedBefore.length);
    } else if (state.focus) {
      html += '<p class="center-note">Nothing scheduled for today.</p>';
    }

    if (!state.focus) {
      var otherDays = state.days.filter(function (d) { return d.date !== today; });
      var lastWeekKey = null;
      var weekNum = 0;
      otherDays.forEach(function (day) {
        var wk = mondayOf(day.date);
        if (wk !== lastWeekKey) {
          weekNum++;
          lastWeekKey = wk;
          html += '<div class="week-label">Week ' + weekNum + '</div>';
        }
        html += renderDay(day);
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

  // Short two-tone chime via Web Audio — no audio asset to manage, and it's a
  // one-shot synthesized tone rather than a decoded/streamed file, so there's
  // nothing to preload or fail to load.
  function playPomoChime() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx();
      [660, 880].forEach(function (freq, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        var start = ctx.currentTime + i * 0.16;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
        osc.start(start);
        osc.stop(start + 0.35);
      });
    } catch (e) { /* Web Audio unsupported/blocked — not critical */ }
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
    var toggleBtn = document.getElementById('pomo-toggle');
    if (toggleBtn) toggleBtn.textContent = pomo.running ? 'Pause' : 'Start';
    var ring = document.getElementById('pomo-ring-progress');
    if (ring) {
      var frac = pomo.totalSeconds > 0 ? pomo.secondsLeft / pomo.totalSeconds : 0;
      ring.style.strokeDashoffset = String(POMO_RING_CIRCUMFERENCE * (1 - frac));
    }
  }

  function pomoAdvance() {
    if (pomo.mode === 'work') pomo.completedSessions++;
    pomo.mode = pomo.mode === 'work' ? 'break' : 'work';
    pomo.totalSeconds = pomoDurationFor(pomo.mode);
    pomo.secondsLeft = pomo.totalSeconds;
    playPomoChime();
    updatePomoDisplay();
  }

  function pomoTick() {
    pomo.secondsLeft--;
    if (pomo.secondsLeft <= 0) {
      pomoAdvance();
    } else {
      updatePomoDisplay();
    }
  }

  function pomoToggleRun() {
    if (pomo.running) {
      clearInterval(pomo.timerId);
      pomo.running = false;
    } else {
      pomo.running = true;
      pomo.timerId = setInterval(pomoTick, 1000);
    }
    updatePomoDisplay();
  }

  function pomoReset() {
    clearInterval(pomo.timerId);
    pomo.running = false;
    pomo.mode = 'work';
    pomo.totalSeconds = pomoDurationFor('work');
    pomo.secondsLeft = pomo.totalSeconds;
    updatePomoDisplay();
  }

  function pomoSkip() {
    clearInterval(pomo.timerId);
    pomoAdvance();
    if (pomo.running) pomo.timerId = setInterval(pomoTick, 1000);
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

  function renderPomodoro() {
    var frac = pomo.totalSeconds > 0 ? pomo.secondsLeft / pomo.totalSeconds : 1;
    var offset = POMO_RING_CIRCUMFERENCE * (1 - frac);

    return '<div class="pomodoro-card fade-in' + (pomo.mode === 'break' ? ' on-break' : '') + '" id="pomo-card">' +
      '<button class="pomo-settings-toggle" id="pomo-settings-toggle" aria-label="Timer settings" type="button">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" stroke-width="1.7"/><path d="M19.4 13.5a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V19.5a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2.5a2 2 0 110-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H8.5a1.65 1.65 0 001-1.51V2.5a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.09a1.65 1.65 0 001.51 1H21.5a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" stroke-width="1.7"/></svg>' +
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
      '<div class="pomodoro-controls">' +
      '<button id="pomo-toggle" class="pomo-btn pomo-btn-primary">' + (pomo.running ? 'Pause' : 'Start') + '</button>' +
      '<button id="pomo-reset" class="pomo-btn pomo-btn-secondary">Reset</button>' +
      '<button id="pomo-skip" class="pomo-btn pomo-btn-secondary">Skip</button>' +
      '</div>' +
      '<div class="pomo-settings" id="pomo-settings" hidden>' +
      '<div class="pomo-setting-row"><label for="pomo-set-work">Focus</label><input type="number" id="pomo-set-work" min="1" max="180" value="' + pomoSettings.work + '"><span>min</span></div>' +
      '<div class="pomo-setting-row"><label for="pomo-set-short">Short break</label><input type="number" id="pomo-set-short" min="1" max="60" value="' + pomoSettings.shortBreak + '"><span>min</span></div>' +
      '<div class="pomo-setting-row"><label for="pomo-set-long">Long break</label><input type="number" id="pomo-set-long" min="1" max="90" value="' + pomoSettings.longBreak + '"><span>min</span></div>' +
      '<div class="pomo-setting-row"><label for="pomo-set-cycle">Sessions / long break</label><input type="number" id="pomo-set-cycle" min="1" max="12" value="' + pomoSettings.cycle + '"><span></span></div>' +
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
        ' incomplete before today. Today’s content builds on those — consider catching up first.</div>';
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

  function bindCalendarEvents() {
    var notYou = document.getElementById('not-you');
    if (notYou) notYou.addEventListener('click', function () {
      clearCookie();
      state.student = null;
      renderRegisterForm();
    });

    var focusToggle = document.getElementById('focus-toggle');
    if (focusToggle) focusToggle.addEventListener('click', function () {
      state.focus = !state.focus;
      localStorage.setItem(FOCUS_KEY, state.focus ? '1' : '0');
      renderCalendar();
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

  function onTaskToggle(e) {
    var cb = e.target;
    var completed = cb.checked;
    var date = cb.dataset.date, subject = cb.dataset.subject, taskText = cb.dataset.task;
    var row = cb.closest('.task-row');
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

  init();
  setupScrollEffects();
})();
