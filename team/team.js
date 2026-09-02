// /team — Discord scheduled-post control page. Vanilla JS, no React/Babel,
// same "build HTML strings, patch the DOM" style as progress.js, since
// this is an internal tool rather than a marketing page. Gated by Netlify
// Identity (same login already powering the blog CMS at /admin),
// requiring the 'admin' role specifically — see requireAdmin in
// netlify/functions/lib/supabase.js for why that's a real role check and
// not just "any logged-in Identity user".
(function () {
  'use strict';

  var API_BASE = '/api';
  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var SOURCE_LABELS = {
    custom: 'Custom message',
    daily_leader: 'Daily — Top Focus Student',
    daily_leaderboard: 'Daily — Top 3',
    weekly_leaderboard: 'Weekly — Top 5 Leaderboard',
    monthly_consistency: 'Monthly — Most Consistent Student',
  };
  // Sources whose content is a computed ranked list (medals, multiple
  // names) rather than a single-entity sentence — the Body field doesn't
  // apply to these (there's nothing to fill {{name}}/{{hours}} into), only
  // Title works as an override, same as the list already worked for
  // weekly_leaderboard before this was split out into its own set.
  var LIST_SOURCES = ['daily_leaderboard', 'weekly_leaderboard'];
  var SCHEDULE_LABELS = { once: 'Once', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

  var state = {
    authorized: false,
    posts: [],
    editing: null, // the post object being edited, or {} for a new one, or null when the form is closed
    msg: null,
    msgType: null,
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, opts) {
    opts = opts || {};
    var user = window.netlifyIdentity && window.netlifyIdentity.currentUser();
    var tokenPromise = user ? user.jwt() : Promise.resolve(null);
    return tokenPromise.then(function (token) {
      var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      if (token) headers.Authorization = 'Bearer ' + token;
      return fetch(API_BASE + path, Object.assign({}, opts, { headers: headers }));
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || ('request failed (' + res.status + ')'));
        return data;
      });
    });
  }

  function loadPosts() {
    return api('/team-posts').then(function (data) {
      state.posts = data.posts || [];
      render();
    }).catch(function (err) {
      state.msg = 'Could not load posts: ' + err.message;
      state.msgType = 'error';
      render();
    });
  }

  function formatNextFire(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';
  }

  function renderPostRow(p) {
    var isBuiltIn = p.source !== 'custom';
    var tagHtml = isBuiltIn
      ? '<span class="tag tag-builtin">' + escapeHtml(SOURCE_LABELS[p.source] || p.source) + '</span>'
      : '<span class="tag tag-custom">Custom</span>';
    var disabledTag = p.enabled ? '' : '<span class="tag tag-disabled">Paused</span>';
    var title = p.title || (isBuiltIn ? SOURCE_LABELS[p.source] : '(untitled)');
    var scheduleDesc = SCHEDULE_LABELS[p.schedule_type] + ' at ' + escapeHtml(p.schedule_time) + ' IST';
    if (p.schedule_type === 'weekly') scheduleDesc = DAY_NAMES[p.schedule_day_of_week] + 's, ' + scheduleDesc;
    if (p.schedule_type === 'monthly') scheduleDesc = 'Day ' + p.schedule_day_of_month + ' of month, ' + scheduleDesc;
    if (p.schedule_type === 'once') scheduleDesc = p.schedule_date + ' at ' + escapeHtml(p.schedule_time) + ' IST';

    return (
      '<div class="post-row" data-id="' + p.id + '">' +
        '<div class="post-main">' +
          '<div class="post-title">' + tagHtml + disabledTag + ' ' + escapeHtml(title) + (p.tag_everyone ? ' 📣' : '') + '</div>' +
          '<div class="post-meta">' + scheduleDesc + ' — next: ' + formatNextFire(p.next_fire_at) + '</div>' +
        '</div>' +
        '<div class="post-actions">' +
          '<button class="btn btn-small js-edit" data-id="' + p.id + '">Edit</button>' +
          '<button class="btn btn-small js-toggle" data-id="' + p.id + '">' + (p.enabled ? 'Pause' : 'Resume') + '</button>' +
          '<button class="btn btn-small btn-danger js-delete" data-id="' + p.id + '">Delete</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderForm(p) {
    var isNew = !p.id;
    var source = p.source || 'custom';
    var scheduleType = p.schedule_type || 'daily';

    var sourceOptions = Object.keys(SOURCE_LABELS).map(function (key) {
      return '<option value="' + key + '"' + (key === source ? ' selected' : '') + '>' + SOURCE_LABELS[key] + '</option>';
    }).join('');

    var scheduleOptions = Object.keys(SCHEDULE_LABELS).map(function (key) {
      return '<option value="' + key + '"' + (key === scheduleType ? ' selected' : '') + '>' + SCHEDULE_LABELS[key] + '</option>';
    }).join('');

    var dayOfWeekOptions = DAY_NAMES.map(function (name, i) {
      return '<option value="' + i + '"' + (p.schedule_day_of_week === i ? ' selected' : '') + '>' + name + '</option>';
    }).join('');

    var isList = LIST_SOURCES.indexOf(source) !== -1;
    var bodyHint = source === 'custom'
      ? 'The literal message text.'
      : isList
        ? 'Optional intro line shown above the medal list (the list itself always shows regardless). {{name}}/{{hours}} = 1st place, {{name2}}/{{hours2}} = 2nd, {{name3}}/{{hours3}} = 3rd (up to {{name5}}/{{hours5}} for the weekly top 5).'
        : 'Optional override. Leave blank to use the default wording. Supports {{name}} and {{hours}} placeholders.';
    var bodyField = '<div class="field"><label>Body</label><textarea name="body">' + escapeHtml(p.body) + '</textarea><div class="field-hint">' + bodyHint + '</div></div>';

    return (
      '<div class="card">' +
        '<h2 style="font-size:16px;margin-bottom:16px;">' + (isNew ? 'New scheduled post' : 'Edit scheduled post') + '</h2>' +
        '<form id="post-form">' +
          '<div class="field-row">' +
            '<div class="field"><label>Source</label><select name="source" id="f-source">' + sourceOptions + '</select></div>' +
            '<div class="field"><label>Webhook URL</label><input type="url" name="webhook_url" placeholder="https://discord.com/api/webhooks/..." value="' + escapeHtml(p.webhook_url) + '" required></div>' +
          '</div>' +
          '<div class="field"><label>Title (optional' + (source !== 'custom' ? ' — overrides the default' : '') + ')</label><input type="text" name="title" value="' + escapeHtml(p.title) + '"></div>' +
          bodyField +
          '<div class="checkbox-row"><input type="checkbox" id="f-everyone" name="tag_everyone"' + (p.tag_everyone ? ' checked' : '') + '><label for="f-everyone">Tag @everyone</label></div>' +
          '<div class="field-row">' +
            '<div class="field"><label>Frequency</label><select name="schedule_type" id="f-schedule-type">' + scheduleOptions + '</select></div>' +
            '<div class="field"><label>Time (IST)</label><input type="time" name="schedule_time" value="' + escapeHtml(p.schedule_time || '10:00') + '" required></div>' +
          '</div>' +
          '<div id="f-schedule-extra">' +
            (scheduleType === 'once' ? '<div class="field"><label>Date</label><input type="date" name="schedule_date" value="' + escapeHtml(p.schedule_date) + '" required></div>' : '') +
            (scheduleType === 'weekly' ? '<div class="field"><label>Day of week</label><select name="schedule_day_of_week">' + dayOfWeekOptions + '</select></div>' : '') +
            (scheduleType === 'monthly' ? '<div class="field"><label>Day of month</label><input type="number" name="schedule_day_of_month" min="1" max="31" value="' + (p.schedule_day_of_month || 1) + '" required></div>' : '') +
          '</div>' +
          '<div class="checkbox-row"><input type="checkbox" id="f-enabled" name="enabled"' + (p.enabled !== false ? ' checked' : '') + '><label for="f-enabled">Enabled</label></div>' +
          '<div class="form-actions">' +
            '<button type="button" class="btn" id="f-cancel">Cancel</button>' +
            '<button type="submit" class="btn btn-primary">' + (isNew ? 'Create' : 'Save') + '</button>' +
          '</div>' +
        '</form>' +
      '</div>'
    );
  }

  function render() {
    var root = document.getElementById('root');
    var user = window.netlifyIdentity && window.netlifyIdentity.currentUser();

    if (!state.authorized) {
      root.innerHTML =
        '<div class="wrap">' +
          '<div id="gate">' +
            '<h1 style="margin-bottom:10px;">Team Console</h1>' +
            (user
              ? '<p>Signed in as ' + escapeHtml(user.email) + ', but this account is not authorized for /team.</p>'
              : '<p>Sign in to manage Discord scheduled posts.</p>') +
            '<div style="margin-top:20px;"><button class="btn btn-primary" id="login-btn">' + (user ? 'Switch account' : 'Log in') + '</button></div>' +
          '</div>' +
        '</div>';
      var loginBtn = document.getElementById('login-btn');
      if (loginBtn) loginBtn.addEventListener('click', function () { window.netlifyIdentity.open(); });
      return;
    }

    var msgHtml = state.msg ? '<div class="msg msg-' + (state.msgType === 'error' ? 'error' : 'ok') + '">' + escapeHtml(state.msg) + '</div>' : '';
    var listHtml = state.posts.length
      ? '<div class="card">' + state.posts.map(renderPostRow).join('') + '</div>'
      : '<div class="empty">No scheduled posts yet.</div>';

    root.innerHTML =
      '<div class="wrap">' +
        '<header>' +
          '<div><h1>Team Console</h1><div class="sub">Discord scheduled posts — signed in as ' + escapeHtml(user.email) + '</div></div>' +
          '<div style="display:flex;gap:10px;">' +
            (state.editing ? '' : '<button class="btn btn-primary" id="new-btn">+ New post</button>') +
            '<button class="btn" id="logout-btn">Log out</button>' +
          '</div>' +
        '</header>' +
        msgHtml +
        (state.editing ? renderForm(state.editing) : '') +
        listHtml +
      '</div>';

    bindEvents();
  }

  function bindEvents() {
    var newBtn = document.getElementById('new-btn');
    if (newBtn) newBtn.addEventListener('click', function () {
      state.editing = { schedule_type: 'daily', schedule_time: '10:00', enabled: true };
      state.msg = null;
      render();
    });

    var logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', function () { window.netlifyIdentity.logout(); });

    document.querySelectorAll('.js-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var post = state.posts.filter(function (p) { return p.id === id; })[0];
        if (post) { state.editing = Object.assign({}, post); state.msg = null; render(); }
      });
    });

    document.querySelectorAll('.js-delete').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        if (!confirm('Delete this scheduled post? This cannot be undone.')) return;
        api('/team-posts?id=' + encodeURIComponent(id), { method: 'DELETE' })
          .then(function () { state.msg = 'Deleted.'; state.msgType = 'ok'; return loadPosts(); })
          .catch(function (err) { state.msg = err.message; state.msgType = 'error'; render(); });
      });
    });

    document.querySelectorAll('.js-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var post = state.posts.filter(function (p) { return p.id === id; })[0];
        if (!post) return;
        var updated = Object.assign({}, post, { enabled: !post.enabled });
        api('/team-posts', { method: 'PUT', body: JSON.stringify(updated) })
          .then(function () { state.msg = updated.enabled ? 'Resumed.' : 'Paused.'; state.msgType = 'ok'; return loadPosts(); })
          .catch(function (err) { state.msg = err.message; state.msgType = 'error'; render(); });
      });
    });

    var sourceSelect = document.getElementById('f-source');
    if (sourceSelect) sourceSelect.addEventListener('change', function () {
      state.editing.source = sourceSelect.value;
      render();
      document.getElementById('f-source').focus();
    });

    var scheduleTypeSelect = document.getElementById('f-schedule-type');
    if (scheduleTypeSelect) scheduleTypeSelect.addEventListener('change', function () {
      state.editing.schedule_type = scheduleTypeSelect.value;
      render();
      document.getElementById('f-schedule-type').focus();
    });

    var cancelBtn = document.getElementById('f-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function () { state.editing = null; render(); });

    var form = document.getElementById('post-form');
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var payload = {
        id: state.editing.id,
        source: fd.get('source'),
        webhook_url: (fd.get('webhook_url') || '').trim(),
        title: (fd.get('title') || '').trim(),
        body: (fd.get('body') || '').trim(),
        tag_everyone: fd.get('tag_everyone') === 'on',
        schedule_type: fd.get('schedule_type'),
        schedule_time: fd.get('schedule_time'),
        schedule_date: fd.get('schedule_date') || null,
        schedule_day_of_week: fd.get('schedule_day_of_week') != null ? Number(fd.get('schedule_day_of_week')) : null,
        schedule_day_of_month: fd.get('schedule_day_of_month') != null ? Number(fd.get('schedule_day_of_month')) : null,
        enabled: fd.get('enabled') === 'on',
      };
      var isNew = !payload.id;
      api('/team-posts', { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(payload) })
        .then(function () {
          state.editing = null;
          state.msg = isNew ? 'Created.' : 'Saved.';
          state.msgType = 'ok';
          return loadPosts();
        })
        .catch(function (err) { state.msg = err.message; state.msgType = 'error'; render(); });
    });
  }

  function init() {
    if (!window.netlifyIdentity) {
      document.getElementById('root').innerHTML = '<div class="wrap"><div id="gate"><p>Netlify Identity failed to load.</p></div></div>';
      return;
    }
    window.netlifyIdentity.on('init', function (user) {
      var roles = (user && user.app_metadata && user.app_metadata.roles) || [];
      state.authorized = roles.indexOf('admin') !== -1;
      render();
      if (state.authorized) loadPosts();
    });
    window.netlifyIdentity.on('login', function (user) {
      var roles = (user && user.app_metadata && user.app_metadata.roles) || [];
      state.authorized = roles.indexOf('admin') !== -1;
      render();
      if (state.authorized) loadPosts();
    });
    window.netlifyIdentity.on('logout', function () {
      state.authorized = false;
      state.posts = [];
      render();
    });
    window.netlifyIdentity.init();
  }

  init();
})();
