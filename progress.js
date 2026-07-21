(function () {
  'use strict';

  // Set this to the confirmed official GATE DA 2027 exam date ("YYYY-MM-DD")
  // to enable the exam countdown stat. Left null until that date is official
  // — showing a countdown to a guessed date would mislead students.
  var EXAM_DATE = null;

  var COOKIE_NAME = 'taai_user';
  var COOKIE_DAYS = 365;
  var FOCUS_KEY = 'taai_progress_focus';

  var app = document.getElementById('app');
  var state = {
    student: null,
    month: currentMonthStr(),
    days: [], // [{ date, tasks: [{subject, task_text, position, completed}] }]
    streak: null,
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
    ])
      .then(function (results) {
        var scheduleDays = results[0].days || [];
        var progressRows = results[1].progress || [];
        state.streak = results[2].streak;

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

        // Missed days start expanded so their checkboxes are immediately usable.
        var today = todayIso();
        state.days.forEach(function (d) {
          var allDone = d.tasks.length > 0 && d.tasks.every(function (t) { return t.completed; });
          if (d.date < today && !allDone) state.expanded.add(d.date);
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

  // ── Per-subject breakdown (elapsed days only, same scope as the
  // overall "days started" stat) ────────────────────────────────────
  function renderSubjectBreakdown() {
    var today = todayIso();
    var bySubject = {};
    state.days.filter(function (d) { return d.date <= today; }).forEach(function (d) {
      d.tasks.forEach(function (t) {
        if (!bySubject[t.subject]) bySubject[t.subject] = { done: 0, total: 0 };
        bySubject[t.subject].total++;
        if (t.completed) bySubject[t.subject].done++;
      });
    });
    var subjects = Object.keys(bySubject);
    if (!subjects.length) return '';

    var rows = subjects.map(function (name) {
      var s = bySubject[name];
      var pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
      return '<div class="subject-row" data-subject="' + escapeAttr(name) + '">' +
        '<div class="subject-row-name">' + escapeHtml(name) + '</div>' +
        '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="subject-row-pct">' + pct + '%</div>' +
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
    if (done === 0) return 1;
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

    html += renderSubjectBreakdown();
    return html;
  }

  // Updates each subject row's bar/percentage in place — no innerHTML
  // replace, so the .subject-breakdown card (which carries .fade-in)
  // never gets recreated and never replays its entrance animation.
  function patchSubjectBreakdown() {
    var today = todayIso();
    var bySubject = {};
    state.days.filter(function (d) { return d.date <= today; }).forEach(function (d) {
      d.tasks.forEach(function (t) {
        if (!bySubject[t.subject]) bySubject[t.subject] = { done: 0, total: 0 };
        bySubject[t.subject].total++;
        if (t.completed) bySubject[t.subject].done++;
      });
    });
    Object.keys(bySubject).forEach(function (name) {
      var row = document.querySelector('.subject-row[data-subject="' + CSS.escape(name) + '"]');
      if (!row) return;
      var s = bySubject[name];
      var pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
      var fill = row.querySelector('.progress-fill');
      var label = row.querySelector('.subject-row-pct');
      if (fill) fill.style.width = pct + '%';
      if (label) label.textContent = pct + '%';
    });
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
      html += '<div class="side-col"><div id="heatmap-panel">' + renderHeatmap() + '</div></div>';
      html += '</div>'; // page-grid
    }

    app.innerHTML = html;
    bindCalendarEvents();
    observeFadeIns();
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
        patchSubjectBreakdown();
        patchHeatmapCell(date);
        patchDayStatus(date);
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
