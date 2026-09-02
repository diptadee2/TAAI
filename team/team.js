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
    preview: null, // { loading } | { embed } | { embed: null, reason } | { error } | null (not yet previewed)
    testStatus: null, // { loading } | { posted: true } | { posted: false, reason } | { error } | null
    showReference: false,
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
    // Falls back to a shortened webhook URL if no channel name was ever
    // typed in, so an old/never-labeled row still shows *something*
    // recognizable instead of nothing.
    var channelLabel = p.channel_name || (p.webhook_url ? '(unlabeled: …' + p.webhook_url.slice(-10) + ')' : '');

    return (
      '<div class="post-row" data-id="' + p.id + '">' +
        '<div class="post-main">' +
          '<div class="post-title">' + tagHtml + disabledTag + ' ' + escapeHtml(title) + (p.tag_everyone ? ' 📣' : '') + '</div>' +
          '<div class="post-meta">' + escapeHtml(channelLabel) + ' — ' + scheduleDesc + ' — next: ' + formatNextFire(p.next_fire_at) + '</div>' +
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
            '<div class="field"><label>Channel name (for your reference)</label><input type="text" name="channel_name" placeholder="e.g. #announcements" value="' + escapeHtml(p.channel_name) + '"></div>' +
          '</div>' +
          '<div class="field"><label>Webhook URL</label><input type="url" name="webhook_url" placeholder="https://discord.com/api/webhooks/..." value="' + escapeHtml(p.webhook_url) + '" required></div>' +
          '<div class="field"><label>Test webhook URL (optional)</label><input type="url" name="test_webhook_url" placeholder="A separate test-channel webhook, for the Send Test button below" value="' + escapeHtml(p.test_webhook_url) + '"><div class="field-hint">Never used by the real schedule — only "Send Test" below posts here, on demand. Point this at a private test channel, not the real one.</div></div>' +
          '<div class="field"><label>Title (optional' + (source !== 'custom' ? ' — overrides the default' : '') + ')</label><input type="text" name="title" value="' + escapeHtml(p.title) + '"></div>' +
          bodyField +
          '<div class="checkbox-row"><input type="checkbox" id="f-everyone" name="tag_everyone"' + (p.tag_everyone ? ' checked' : '') + '><label for="f-everyone">Tag @everyone</label></div>' +
          '<div class="field"><label>Additional mentions (optional)</label><input type="text" name="extra_mentions" placeholder="@here, or &lt;@&amp;ROLE_ID&gt; for a role, &lt;@USER_ID&gt; for a person" value="' + escapeHtml(p.extra_mentions) + '"><div class="field-hint">Type the exact Discord mention. For a role or person, right-click them in Discord (Developer Mode must be on in Discord\'s settings) and Copy ID, then use &lt;@&amp;THAT_ID&gt; for a role or &lt;@THAT_ID&gt; for a person.</div></div>' +
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
          renderPreviewBox() +
          renderTestStatus() +
          '<div class="form-actions">' +
            '<button type="button" class="btn" id="f-preview">Preview</button>' +
            '<button type="button" class="btn btn-test" id="f-send-test">Send Test</button>' +
            '<button type="button" class="btn" id="f-cancel">Cancel</button>' +
            '<button type="submit" class="btn btn-primary">' + (isNew ? 'Create' : 'Save') + '</button>' +
          '</div>' +
        '</form>' +
      '</div>'
    );
  }

  // Lightweight Discord-markdown -> HTML for the preview only (bold,
  // italic, [text](url) links) — not a full parser, just the handful of
  // things these embeds actually use. escapeHtml runs first, so the
  // markdown punctuation surviving it can't reintroduce real HTML.
  function discordMarkdownToHtml(text) {
    var html = escapeHtml(text);
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return html;
  }

  function renderPreviewBox() {
    if (!state.preview) return '';
    if (state.preview.loading) return '<div class="preview-box"><div class="field-hint">Loading preview…</div></div>';
    if (state.preview.error) return '<div class="preview-box"><div class="msg msg-error" style="margin:0;">' + escapeHtml(state.preview.error) + '</div></div>';
    if (!state.preview.embed) return '<div class="preview-box"><div class="field-hint">' + escapeHtml(state.preview.reason || 'Nothing to preview.') + '</div></div>';

    var embed = state.preview.embed;
    var colorHex = '#' + (embed.color != null ? embed.color.toString(16).padStart(6, '0') : '8b5cf6');
    return (
      '<div class="preview-box" style="border-left-color:' + colorHex + ';">' +
        '<div class="preview-username">Department of Propaganda <span class="preview-bot-tag">BOT</span></div>' +
        (state.preview.content ? '<div class="preview-mention">' + escapeHtml(state.preview.content) + '</div>' : '') +
        (embed.title ? '<div class="preview-title">' + discordMarkdownToHtml(embed.title) + '</div>' : '') +
        (embed.description ? '<div class="preview-description">' + discordMarkdownToHtml(embed.description) + '</div>' : '') +
        (embed.footer && embed.footer.text ? '<div class="preview-footer">' + escapeHtml(embed.footer.text) + '</div>' : '') +
      '</div>'
    );
  }

  function renderTestStatus() {
    if (!state.testStatus) return '';
    if (state.testStatus.loading) return '<div class="msg" style="background:var(--purple-soft);color:var(--purple);">Sending test post…</div>';
    if (state.testStatus.error) return '<div class="msg msg-error">' + escapeHtml(state.testStatus.error) + '</div>';
    if (state.testStatus.posted === false) return '<div class="msg" style="background:var(--amber-soft);color:var(--amber);">' + escapeHtml(state.testStatus.reason || 'Nothing was sent.') + '</div>';
    return '<div class="msg msg-ok">Test post sent — check your test channel.</div>';
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
            '<button class="btn" id="reference-toggle">' + (state.showReference ? 'Hide syntax reference' : '? Syntax reference') + '</button>' +
            (state.editing ? '' : '<button class="btn btn-primary" id="new-btn">+ New post</button>') +
            '<button class="btn" id="logout-btn">Log out</button>' +
          '</div>' +
        '</header>' +
        (state.showReference ? renderReference() : '') +
        msgHtml +
        (state.editing ? renderForm(state.editing) : '') +
        listHtml +
      '</div>';

    bindEvents();
  }

  // A persistent, always-current reference for anyone creating a post —
  // lives here (not a one-off doc elsewhere) specifically so it can't
  // drift out of sync with the actual placeholder/mention logic below.
  function renderReference() {
    return (
      '<div class="card reference-card">' +
        '<h2 style="font-size:15px;margin-bottom:12px;">Syntax reference</h2>' +

        '<div class="ref-section"><div class="ref-heading">Sources</div>' +
          '<div class="ref-row"><strong>Custom message</strong> — whatever you type in Title/Body, posted as-is. No live data.</div>' +
          '<div class="ref-row"><strong>Daily — Top Focus Student</strong> — yesterday\'s single top student. Body fully replaces the default sentence if set.</div>' +
          '<div class="ref-row"><strong>Daily — Top 3</strong> / <strong>Weekly — Top 5 Leaderboard</strong> — a computed, freshly-ranked list every time it fires. Body (if set) is an intro line shown ABOVE the medal list — the list itself always shows regardless, you can\'t remove it.</div>' +
          '<div class="ref-row"><strong>Monthly — Most Consistent Student</strong> — reports on the month that just closed, ranked by median daily minutes (not average). Body fully replaces the default sentence if set.</div>' +
        '</div>' +

        '<div class="ref-section"><div class="ref-heading">Body placeholders</div>' +
          '<div class="ref-row">Single-student sources (Daily Top Focus Student, Monthly Consistency): <code>{{name}}</code> and <code>{{hours}}</code> only.</div>' +
          '<div class="ref-row">Ranked-list sources (Daily Top 3, Weekly Top 5): <code>{{name}}</code>/<code>{{hours}}</code> = 1st place, <code>{{name2}}</code>/<code>{{hours2}}</code> = 2nd, <code>{{name3}}</code>/<code>{{hours3}}</code> = 3rd, up through <code>{{name5}}</code>/<code>{{hours5}}</code> on the weekly one. An unused one (e.g. <code>{{name4}}</code> on a top-3 post) just renders blank.</div>' +
          '<div class="ref-row">Custom messages: no placeholders — Body is posted exactly as typed.</div>' +
        '</div>' +

        '<div class="ref-section"><div class="ref-heading">Mentions</div>' +
          '<div class="ref-row"><strong>Tag @everyone</strong> checkbox — pings the whole server.</div>' +
          '<div class="ref-row"><strong>Additional mentions</strong> field — free text for anything else: <code>@here</code> for online members only, <code>&lt;@&amp;ROLE_ID&gt;</code> to ping a role, <code>&lt;@USER_ID&gt;</code> to ping one person. Both fields combine (e.g. @everyone + a role ping both fire together).</div>' +
          '<div class="ref-row">Getting an ID: in Discord, turn on Developer Mode (User Settings → Advanced), then right-click a role or person → Copy ID.</div>' +
        '</div>' +

        '<div class="ref-section"><div class="ref-heading">Other fields</div>' +
          '<div class="ref-row"><strong>Channel name</strong> — just a label for this list, purely for telling rows apart at a glance. Doesn\'t affect where the post actually goes — that\'s the Webhook URL.</div>' +
          '<div class="ref-row"><strong>Preview</strong> button — shows exactly what would post right now, using real live data, before you save. Doesn\'t post anything or save your changes.</div>' +
          '<div class="ref-row"><strong>Send Test</strong> button — actually posts a real message right now, to whatever\'s in the "Test webhook URL" field above it (never the real Webhook URL, and never saves your changes). Point that at a private test channel so you can see the real rendered message in an actual Discord client before trusting it with the real one.</div>' +
          '<div class="ref-row"><strong>Once</strong> schedule — fires exactly one time at the date/time you set, then automatically pauses itself (doesn\'t delete, just switches to disabled).</div>' +
        '</div>' +
      '</div>'
    );
  }

  function bindEvents() {
    var referenceToggle = document.getElementById('reference-toggle');
    if (referenceToggle) referenceToggle.addEventListener('click', function () {
      state.showReference = !state.showReference;
      render();
    });

    var newBtn = document.getElementById('new-btn');
    if (newBtn) newBtn.addEventListener('click', function () {
      state.editing = { schedule_type: 'daily', schedule_time: '10:00', enabled: true };
      state.preview = null;
      state.testStatus = null;
      state.msg = null;
      render();
    });

    var logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', function () { window.netlifyIdentity.logout(); });

    document.querySelectorAll('.js-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var post = state.posts.filter(function (p) { return p.id === id; })[0];
        if (post) { state.editing = Object.assign({}, post); state.preview = null; state.testStatus = null; state.msg = null; render(); }
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
      state.preview = null;
      state.testStatus = null;
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
    if (cancelBtn) cancelBtn.addEventListener('click', function () { state.editing = null; state.preview = null; state.testStatus = null; render(); });

    var previewBtn = document.getElementById('f-preview');
    if (previewBtn) previewBtn.addEventListener('click', function () {
      var payload = readFormPayload(document.getElementById('post-form'));
      state.preview = { loading: true };
      render();
      api('/team-posts?preview=1', { method: 'POST', body: JSON.stringify(payload) })
        .then(function (data) { state.preview = data; render(); })
        .catch(function (err) { state.preview = { error: err.message }; render(); });
    });

    var sendTestBtn = document.getElementById('f-send-test');
    if (sendTestBtn) sendTestBtn.addEventListener('click', function () {
      var payload = readFormPayload(document.getElementById('post-form'));
      if (!payload.test_webhook_url) {
        state.testStatus = { error: 'Fill in "Test webhook URL" above first.' };
        render();
        return;
      }
      if (!confirm('This will actually post a real message to that webhook right now. Continue?')) return;
      state.testStatus = { loading: true };
      render();
      api('/team-posts?test=1', { method: 'POST', body: JSON.stringify(payload) })
        .then(function (data) { state.testStatus = data; render(); })
        .catch(function (err) { state.testStatus = { error: err.message }; render(); });
    });

    var form = document.getElementById('post-form');
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      var payload = readFormPayload(form);
      payload.id = state.editing.id;
      var isNew = !payload.id;
      api('/team-posts', { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(payload) })
        .then(function () {
          state.editing = null;
          state.preview = null;
          state.testStatus = null;
          state.msg = isNew ? 'Created.' : 'Saved.';
          state.msgType = 'ok';
          return loadPosts();
        })
        .catch(function (err) { state.msg = err.message; state.msgType = 'error'; render(); });
    });
  }

  function readFormPayload(form) {
    var fd = new FormData(form);
    return {
      source: fd.get('source'),
      channel_name: (fd.get('channel_name') || '').trim(),
      webhook_url: (fd.get('webhook_url') || '').trim(),
      test_webhook_url: (fd.get('test_webhook_url') || '').trim(),
      title: (fd.get('title') || '').trim(),
      body: (fd.get('body') || '').trim(),
      tag_everyone: fd.get('tag_everyone') === 'on',
      extra_mentions: (fd.get('extra_mentions') || '').trim(),
      schedule_type: fd.get('schedule_type'),
      schedule_time: fd.get('schedule_time'),
      schedule_date: fd.get('schedule_date') || null,
      schedule_day_of_week: fd.get('schedule_day_of_week') != null ? Number(fd.get('schedule_day_of_week')) : null,
      schedule_day_of_month: fd.get('schedule_day_of_month') != null ? Number(fd.get('schedule_day_of_month')) : null,
      enabled: fd.get('enabled') === 'on',
    };
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
