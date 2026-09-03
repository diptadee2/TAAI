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
  // The exact same fallback text resolveScheduledPostEmbed() in
  // lib/supabase.js uses when body is blank — shown pre-filled in the Body
  // box for a new/never-edited post of these two sources, so someone
  // editing it starts from the real current wording instead of an empty
  // box (and has to go dig up what the default even says). Only applies
  // to the single-entity sources — the ranked-list ones (daily_leaderboard,
  // weekly_leaderboard) have no equivalent "default sentence" to show,
  // blank there just means "no intro line," which is itself a valid,
  // common choice. Keep these two strings in sync with lib/supabase.js by
  // hand if that wording ever changes.
  var DEFAULT_BODY_BY_SOURCE = {
    daily_leader: '**{{name}}** logged the most focus time yesterday — **{{hours}}**!',
    monthly_consistency: '**{{name}}** was the most consistent student this month — a **typical day of {{hours}}** of focused study, day after day, all month long.',
  };

  var state = {
    authorized: false,
    posts: [],
    editing: null, // the post object being edited, or {} for a new one, or null when the form is closed
    preview: null, // { loading } | { embed } | { embed: null, reason } | { error } | null (not yet previewed)
    testStatus: null, // { loading } | { posted: true } | { posted: false, reason } | { error } | null
    showReference: false,
    showBuiltIn: false, // recurring daily/weekly/monthly posts start collapsed — see renderPostList()
    tab: 'announcements', // 'announcements' | 'students' — mutually exclusive views, not stacked panels
    students: null, // null = not loaded yet; array once fetched
    studentsLoading: false,
    studentsError: null,
    studentSort: { key: 'total_minutes', dir: 'desc' },
    noteSaving: {}, // email -> 'saving' | 'saved' | 'error', transient per-row save feedback
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

  // Distinct webhooks already used by an existing post, newest first —
  // powers the "Load a saved channel" dropdown so a new/edited post can
  // reuse one without retyping/repasting the URL.
  function getKnownChannels() {
    var seen = {};
    var list = [];
    state.posts.forEach(function (post) {
      if (!post.webhook_url || seen[post.webhook_url]) return;
      seen[post.webhook_url] = true;
      list.push({ webhook_url: post.webhook_url, channel_name: post.channel_name || null });
    });
    return list;
  }

  function channelSelectLabel(c) {
    return c.channel_name || ('…' + c.webhook_url.slice(-10));
  }

  function renderChannelSelect() {
    var known = getKnownChannels();
    if (!known.length) return '';
    var options = known.map(function (c, i) {
      return '<option value="' + i + '">' + escapeHtml(channelSelectLabel(c)) + '</option>';
    }).join('');
    return (
      '<div class="field"><label>Load a saved channel</label>' +
        '<select id="f-channel-select"><option value="">-- Enter a new webhook below --</option>' + options + '</select>' +
        '<div class="field-hint">Fills in the channel name and webhook URL from a post you\'ve already set up — still editable below.</div>' +
      '</div>'
    );
  }

  // Groups the flat post list by channel (falling back to a shortened
  // webhook tail for an unlabeled one) so it's obvious at a glance which
  // Discord channel each post is going to, instead of one undifferentiated
  // list — matters once there's more than one real channel in use.
  // Alphabetical group order, so it's stable across reloads rather than
  // shuffling with next_fire_at.
  function renderPostGroups(posts) {
    if (!posts.length) return '<div class="empty">Nothing here yet.</div>';

    var groups = {};
    var keys = [];
    posts.forEach(function (p) {
      var key = p.channel_name || (p.webhook_url ? '(unlabeled: …' + p.webhook_url.slice(-10) + ')' : '(no channel set)');
      if (!groups[key]) { groups[key] = []; keys.push(key); }
      groups[key].push(p);
    });
    keys.sort();

    return keys.map(function (key) {
      return (
        '<div class="card channel-group">' +
          '<div class="channel-group-heading">' + escapeHtml(key) + ' <span class="channel-group-count">(' + groups[key].length + ')</span></div>' +
          groups[key].map(renderPostRow).join('') +
        '</div>'
      );
    }).join('');
  }

  // Custom posts are the ones actually edited week to week (a schedule
  // post, a one-off announcement); the built-in daily/weekly/monthly
  // leaderboards are "set once, leave alone" by comparison — surfacing
  // both with equal weight meant re-scanning past three untouched rows
  // every time to find the one that actually needed attention. Custom
  // posts get top billing; the recurring ones collapse into their own
  // toggle, closed by default, same pattern as the syntax reference panel.
  function renderPostList() {
    if (!state.posts.length) return '<div class="empty">No scheduled posts yet.</div>';

    var customPosts = state.posts.filter(function (p) { return p.source === 'custom'; });
    var builtInPosts = state.posts.filter(function (p) { return p.source !== 'custom'; });

    var customHtml =
      '<h3 class="post-list-heading">Custom announcements</h3>' +
      renderPostGroups(customPosts);

    var builtInHtml = builtInPosts.length
      ? (
        '<button type="button" class="btn" id="builtin-toggle" style="margin:20px 0 12px;">' +
          (state.showBuiltIn ? 'Hide' : 'Show') + ' recurring leaderboards (' + builtInPosts.length + ')' +
        '</button>' +
        (state.showBuiltIn ? renderPostGroups(builtInPosts) : '')
      )
      : '';

    return customHtml + builtInHtml;
  }

  function colorToHex(color) {
    return '#' + (Number.isFinite(color) ? color : 0x8b5cf6).toString(16).padStart(6, '0');
  }

  // Converts a day-rows table (what someone actually fills in) into the
  // Discord markdown body a section's embed needs — the exact format
  // arrived at through live testing against a real test channel (bold
  // date + em dash + task, duration as a native blockquote line below,
  // not inline/parenthesized — see CLAUDE.md's "/team" section for why
  // every alternative tried was rejected). Rows with no task are skipped
  // (an empty day contributes nothing, same as leaving it out entirely).
  function sectionRowsToBody(rows) {
    return rows.filter(function (r) { return r.task; }).map(function (r) {
      var line = '**' + r.date + '** — ' + r.task;
      if (r.time) line += '\n> ⏱ ' + r.time;
      return line;
    }).join('\n');
  }

  // The inverse — reconstructs day-rows from a saved section's plain-text
  // body, so re-opening an existing post for editing shows the familiar
  // table again instead of a raw markdown blob. Safe to be this specific
  // about the format: sectionRowsToBody is the only thing that ever
  // writes this text, so parsing it back is parsing our own output, not
  // guessing at arbitrary user text.
  function parseSectionBodyToRows(body) {
    if (!body) return [];
    var rows = [];
    var lines = String(body).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\*\*(.+?)\*\*\s*—\s*(.*)$/);
      if (!m) continue;
      var time = '';
      var next = lines[i + 1];
      var tm = next && next.match(/^>\s*⏱\s*(.*)$/);
      if (tm) { time = tm[1]; i++; }
      rows.push({ date: m[1], task: m[2], time: time });
    }
    return rows;
  }

  // A repeatable list of {title, color, day-rows} mini-cards, only shown
  // for source: 'custom' — each becomes its own additional embed appended
  // after the main Title/Body, so one message can carry several full-
  // width cards (e.g. a weekly schedule: one header + a card per subject)
  // instead of squeezing everything into one embed. See `sections` in
  // schema.sql and resolveScheduledPostEmbed() in lib/supabase.js. Each
  // card's content is a Date/Topic/Duration table (matching how the
  // source spreadsheet is already laid out) rather than a free-text box —
  // someone filling this in shouldn't need to know Discord's markdown
  // syntax to get the formatting right.
  function renderSectionsEditor(p) {
    if (p.source !== 'custom') return '';
    var sections = Array.isArray(p.sections) ? p.sections : [];
    var sectionsHtml = sections.map(function (s, si) {
      var dayRows = Array.isArray(s.rows) ? s.rows : parseSectionBodyToRows(s.body);
      if (!dayRows.length) dayRows = [{ date: '', task: '', time: '' }];
      var dayRowsHtml = dayRows.map(function (r, ri) {
        return (
          '<tr class="day-row">' +
            '<td><input type="text" class="js-day-date" placeholder="Jun 15" value="' + escapeHtml(r.date) + '"></td>' +
            '<td><input type="text" class="js-day-task" placeholder="Topic"  value="' + escapeHtml(r.task) + '"></td>' +
            '<td><input type="text" class="js-day-time" placeholder="1h25m" value="' + escapeHtml(r.time) + '"></td>' +
            '<td><button type="button" class="btn btn-small btn-danger js-day-remove" data-section-index="' + si + '" data-row-index="' + ri + '">×</button></td>' +
          '</tr>'
        );
      }).join('');
      return (
        '<div class="section-row" data-index="' + si + '">' +
          '<div class="field-row">' +
            '<div class="field"><label>Card title</label><input type="text" class="js-section-title" value="' + escapeHtml(s.title) + '"></div>' +
            '<div class="field"><label>Accent color</label><input type="color" class="js-section-color" value="' + colorToHex(s.color) + '"></div>' +
          '</div>' +
          '<table class="day-table"><thead><tr><th>Date</th><th>Topic</th><th>Duration</th><th></th></tr></thead>' +
          '<tbody>' + dayRowsHtml + '</tbody></table>' +
          '<div style="display:flex;gap:8px;margin-top:8px;">' +
            '<button type="button" class="btn btn-small js-day-add" data-section-index="' + si + '">+ Add day</button>' +
            '<button type="button" class="btn btn-small btn-danger js-section-remove" data-index="' + si + '">Remove card</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
    return (
      '<div class="form-section">' +
        '<div class="form-section-heading">Extra cards (optional)</div>' +
        '<div class="field-hint" style="margin-bottom:10px;">Each one becomes its own full-width card stacked below the main Title/Body above — e.g. one card per subject in a weekly schedule post. Fill in one row per day; leave Duration blank for entries like a quiz that has none.</div>' +
        '<div id="sections-list">' + sectionsHtml + '</div>' +
        '<button type="button" class="btn btn-small" id="f-add-section">+ Add card</button>' +
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
        : 'Pre-filled with the current default wording below — edit it directly, or clear the box entirely to fall back to this same default. Supports {{name}} and {{hours}} placeholders.';
    // Only pre-fill when there's no real custom body saved (never overwrite
    // one that is) and only for sources that have a default sentence at
    // all. An empty body is treated the same as null here on purpose —
    // for these two sources blank always means "show the hardcoded
    // default" functionally (see resolveScheduledPostEmbed's `row.body ||
    // DEFAULT`), there's no distinct "truly blank" state to preserve.
    var bodyValue = (p.body != null && p.body !== '') ? p.body : (DEFAULT_BODY_BY_SOURCE[source] || '');
    var bodyField = '<div class="field"><label>Body</label><textarea name="body">' + escapeHtml(bodyValue) + '</textarea><div class="field-hint">' + bodyHint + '</div></div>';

    return (
      '<div class="card">' +
        '<h2 style="font-size:16px;margin-bottom:16px;">' + (isNew ? 'New scheduled post' : 'Edit scheduled post') + '</h2>' +
        '<form id="post-form">' +

          '<div class="form-section">' +
            '<div class="form-section-heading">Destination</div>' +
            renderChannelSelect() +
            '<div class="field"><label>Channel name (for your reference)</label><input type="text" name="channel_name" placeholder="e.g. #announcements" value="' + escapeHtml(p.channel_name) + '"></div>' +
            '<div class="field"><label>Webhook URL</label><input type="url" name="webhook_url" placeholder="https://discord.com/api/webhooks/..." value="' + escapeHtml(p.webhook_url) + '" required></div>' +
            '<div class="field"><label>Test webhook URL (optional)</label><input type="url" name="test_webhook_url" placeholder="A separate test-channel webhook, for the Send Test button below" value="' + escapeHtml(p.test_webhook_url) + '"><div class="field-hint">Never used by the real schedule — only "Send Test" below posts here, on demand. Point this at a private test channel, not the real one.</div></div>' +
          '</div>' +

          '<div class="form-section">' +
            '<div class="form-section-heading">Content</div>' +
            '<div class="field"><label>Source</label><select name="source" id="f-source">' + sourceOptions + '</select></div>' +
            '<div class="field"><label>Title (optional' + (source !== 'custom' ? ' — overrides the default' : '') + ')</label><input type="text" name="title" value="' + escapeHtml(p.title) + '"></div>' +
            bodyField +
          '</div>' +

          renderSectionsEditor(p) +

          '<div class="form-section">' +
            '<div class="form-section-heading">Mentions</div>' +
            '<div class="checkbox-row"><input type="checkbox" id="f-everyone" name="tag_everyone"' + (p.tag_everyone ? ' checked' : '') + '><label for="f-everyone">Tag @everyone</label></div>' +
            '<div class="field"><label>Additional mentions (optional)</label><input type="text" name="extra_mentions" placeholder="@here, or &lt;@&amp;ROLE_ID&gt; for a role, &lt;@USER_ID&gt; for a person" value="' + escapeHtml(p.extra_mentions) + '"><div class="field-hint">Type the exact Discord mention. For a role or person, right-click them in Discord (Developer Mode must be on in Discord\'s settings) and Copy ID, then use &lt;@&amp;THAT_ID&gt; for a role or &lt;@THAT_ID&gt; for a person.</div></div>' +
          '</div>' +

          '<div class="form-section">' +
            '<div class="form-section-heading">Schedule</div>' +
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
          '</div>' +

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

  // Renders one embed as a Discord-style card — the username/BOT tag and
  // mention line only appear once, above the first card, same as a real
  // Discord message with multiple stacked embeds.
  function renderPreviewEmbed(embed, isFirst, content) {
    var colorHex = '#' + (embed.color != null ? embed.color.toString(16).padStart(6, '0') : '8b5cf6');
    return (
      '<div class="preview-box" style="border-left-color:' + colorHex + ';margin-top:' + (isFirst ? '0' : '8px') + ';">' +
        (isFirst ? '<div class="preview-username">Department of Propaganda <span class="preview-bot-tag">BOT</span></div>' : '') +
        (isFirst && content ? '<div class="preview-mention">' + escapeHtml(content) + '</div>' : '') +
        (embed.title ? '<div class="preview-title">' + discordMarkdownToHtml(embed.title) + '</div>' : '') +
        (embed.description ? '<div class="preview-description">' + discordMarkdownToHtml(embed.description) + '</div>' : '') +
        (embed.footer && embed.footer.text ? '<div class="preview-footer">' + escapeHtml(embed.footer.text) + '</div>' : '') +
      '</div>'
    );
  }

  function renderPreviewBox() {
    if (!state.preview) return '';
    if (state.preview.loading) return '<div class="preview-box"><div class="field-hint">Loading preview…</div></div>';
    if (state.preview.error) return '<div class="preview-box"><div class="msg msg-error" style="margin:0;">' + escapeHtml(state.preview.error) + '</div></div>';
    if (!state.preview.embeds || !state.preview.embeds.length) return '<div class="preview-box"><div class="field-hint">' + escapeHtml(state.preview.reason || 'Nothing to preview.') + '</div></div>';

    return state.preview.embeds.map(function (embed, i) {
      return renderPreviewEmbed(embed, i === 0, state.preview.content);
    }).join('');
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

    var isAnnouncements = state.tab === 'announcements';
    var tabsHtml =
      '<div class="tabs">' +
        '<button class="tab-btn' + (isAnnouncements ? ' active' : '') + '" data-tab="announcements">📣 Announcements</button>' +
        '<button class="tab-btn' + (!isAnnouncements ? ' active' : '') + '" data-tab="students">👥 Students</button>' +
      '</div>';

    var actionsHtml = isAnnouncements
      ? ('<button class="btn" id="reference-toggle">' + (state.showReference ? 'Hide syntax reference' : '? Syntax reference') + '</button>' +
         (state.editing ? '' : '<button class="btn btn-primary" id="new-btn">+ New post</button>'))
      : '';

    var bodyHtml = isAnnouncements
      ? ((state.showReference ? renderReference() : '') +
         msgHtml +
         (state.editing ? renderForm(state.editing) : '') +
         renderPostList())
      : renderStudents();

    root.innerHTML =
      '<div class="wrap">' +
        '<header>' +
          '<div><h1>Team Console</h1><div class="sub">Signed in as ' + escapeHtml(user.email) + '</div></div>' +
          '<div style="display:flex;gap:10px;">' +
            actionsHtml +
            '<button class="btn" id="logout-btn">Log out</button>' +
          '</div>' +
        '</header>' +
        tabsHtml +
        bodyHtml +
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
          '<div class="ref-row"><strong>Custom message</strong> — whatever you type in Title/Body, posted as-is. No live data. Optionally add "Extra cards" below the Body for a multi-card message (e.g. a weekly schedule: one card per subject) — each becomes its own full-width card stacked below the main one.</div>' +
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
          '<div class="ref-row"><strong>Load a saved channel</strong> — picks from webhooks already used by an existing post and fills in the Channel name/Webhook URL fields for you. Still just a starting point — edit either field afterward if needed.</div>' +
          '<div class="ref-row"><strong>Preview</strong> button — shows exactly what would post right now, using real live data, before you save. Doesn\'t post anything or save your changes.</div>' +
          '<div class="ref-row"><strong>Send Test</strong> button — actually posts a real message right now, to whatever\'s in the "Test webhook URL" field above it (never the real Webhook URL, and never saves your changes). Point that at a private test channel so you can see the real rendered message in an actual Discord client before trusting it with the real one.</div>' +
          '<div class="ref-row"><strong>Once</strong> schedule — fires exactly one time at the date/time you set, then automatically pauses itself (doesn\'t delete, just switches to disabled).</div>' +
        '</div>' +
      '</div>'
    );
  }

  function formatHours(minutes) {
    return (minutes / 60).toFixed(1) + 'h';
  }

  var STUDENT_COLUMNS = [
    { key: 'display_name', label: 'Name' },
    { key: 'total_minutes', label: 'All-time' },
    { key: 'week_minutes', label: 'This week' },
    { key: 'consistency_minutes', label: 'Consistency' },
    { key: 'streak', label: 'Streak' },
    { key: 'progress_pct', label: 'Course progress' },
    { key: 'tasks_completed', label: 'Tasks done' },
    { key: 'last_active', label: 'Last active' },
  ];

  function sortedStudents() {
    var key = state.studentSort.key;
    var dir = state.studentSort.dir === 'asc' ? 1 : -1;
    return (state.students || []).slice().sort(function (a, b) {
      var av = a[key], bv = b[key];
      if (av == null) av = key === 'display_name' ? '' : -Infinity;
      if (bv == null) bv = key === 'display_name' ? '' : -Infinity;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  // A dedicated Students view for spotting high performers (default sort:
  // most all-time focus hours first) and students who've dropped off (sort
  // by Last active to see who's gone quiet), plus a free-text Notes field
  // per student purely for the team's own reference — see the `notes`
  // column added to `students` in schema.sql.
  function renderStudents() {
    if (state.studentsLoading) return '<div class="card"><div class="field-hint">Loading students…</div></div>';
    if (state.studentsError) return '<div class="card"><div class="msg msg-error" style="margin:0;">' + escapeHtml(state.studentsError) + '</div></div>';
    if (!state.students || !state.students.length) return '<div class="card"><div class="empty">No students registered yet.</div></div>';

    var headerHtml = STUDENT_COLUMNS.map(function (col) {
      var active = state.studentSort.key === col.key;
      var arrow = active ? (state.studentSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return '<th class="js-sort" data-key="' + col.key + '">' + escapeHtml(col.label) + arrow + '</th>';
    }).join('') + '<th>Notes</th>';

    var rowsHtml = sortedStudents().map(function (s) {
      var saveState = state.noteSaving[s.email];
      var saveLabel = saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Failed — retry' : 'Save';
      return (
        '<tr data-email="' + escapeHtml(s.email) + '">' +
          '<td>' + escapeHtml(s.display_name) + '<div class="field-hint"><a href="mailto:' + escapeHtml(s.email) + '">' + escapeHtml(s.email) + '</a></div></td>' +
          '<td>' + formatHours(s.total_minutes) + '</td>' +
          '<td>' + formatHours(s.week_minutes) + '</td>' +
          '<td>' + formatHours(s.consistency_minutes) + '/day</td>' +
          '<td>' + s.streak + '</td>' +
          '<td>' + s.progress_pct + '%</td>' +
          '<td>' + s.tasks_completed + '</td>' +
          '<td>' + (s.last_active || '—') + '</td>' +
          '<td class="students-notes-cell">' +
            '<textarea class="js-note-input" data-email="' + escapeHtml(s.email) + '" rows="1">' + escapeHtml(s.notes) + '</textarea>' +
            '<button type="button" class="btn btn-small js-note-save" data-email="' + escapeHtml(s.email) + '">' + saveLabel + '</button>' +
          '</td>' +
        '</tr>'
      );
    }).join('');

    return (
      '<div class="card">' +
        '<h2 style="font-size:16px;margin-bottom:12px;">Students (' + state.students.length + ')</h2>' +
        '<div class="field-hint" style="margin-bottom:10px;">Sorted by All-time hours by default — click a column to re-sort. Consistency = median daily minutes this month so far (same measure as the monthly Discord post), zero-filled on quiet days, so it rewards showing up regularly over binge days. Course progress = tasks completed out of everything scheduled so far. Try sorting by Consistency for steady-but-not-flashy students, or Last active to see who\'s gone quiet.</div>' +
        '<div class="students-table-wrap"><table class="students-table"><thead><tr>' + headerHtml + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
      '</div>'
    );
  }

  function loadStudents() {
    state.studentsLoading = true;
    state.studentsError = null;
    render();
    api('/team-students').then(function (data) {
      state.students = data.students || [];
      state.studentsLoading = false;
      render();
    }).catch(function (err) {
      state.studentsError = err.message;
      state.studentsLoading = false;
      render();
    });
  }

  function bindEvents() {
    var referenceToggle = document.getElementById('reference-toggle');
    if (referenceToggle) referenceToggle.addEventListener('click', function () {
      state.showReference = !state.showReference;
      render();
    });

    var builtinToggle = document.getElementById('builtin-toggle');
    if (builtinToggle) builtinToggle.addEventListener('click', function () {
      state.showBuiltIn = !state.showBuiltIn;
      render();
    });

    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.getAttribute('data-tab');
        if (tab === state.tab) return;
        state.tab = tab;
        if (tab === 'students' && state.students === null) { loadStudents(); return; }
        render();
      });
    });

    document.querySelectorAll('.js-sort').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-key');
        if (state.studentSort.key === key) {
          state.studentSort.dir = state.studentSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.studentSort = { key: key, dir: key === 'display_name' ? 'asc' : 'desc' };
        }
        render();
      });
    });

    document.querySelectorAll('.js-note-save').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var email = btn.getAttribute('data-email');
        var textarea = document.querySelector('.js-note-input[data-email="' + email + '"]');
        var notes = textarea ? textarea.value : '';
        state.noteSaving[email] = 'saving';
        render();
        api('/team-students', { method: 'PATCH', body: JSON.stringify({ email: email, notes: notes }) })
          .then(function () {
            state.noteSaving[email] = 'saved';
            var s = (state.students || []).filter(function (x) { return x.email === email; })[0];
            if (s) s.notes = notes;
            render();
          })
          .catch(function () { state.noteSaving[email] = 'error'; render(); });
      });
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
      syncEditingFromForm();
      state.editing.source = sourceSelect.value;
      state.preview = null;
      state.testStatus = null;
      render();
      document.getElementById('f-source').focus();
    });

    var addSectionBtn = document.getElementById('f-add-section');
    if (addSectionBtn) addSectionBtn.addEventListener('click', function () {
      syncEditingFromForm();
      state.editing.sections.push({ title: '', body: '', color: 0x8b5cf6 });
      render();
    });

    document.querySelectorAll('.js-section-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.getAttribute('data-index'));
        syncEditingFromForm();
        state.editing.sections.splice(idx, 1);
        render();
      });
    });

    document.querySelectorAll('.js-day-add').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var si = Number(btn.getAttribute('data-section-index'));
        syncEditingFromForm();
        state.editing.sections[si].rows.push({ date: '', task: '', time: '' });
        render();
      });
    });

    document.querySelectorAll('.js-day-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var si = Number(btn.getAttribute('data-section-index'));
        var ri = Number(btn.getAttribute('data-row-index'));
        syncEditingFromForm();
        state.editing.sections[si].rows.splice(ri, 1);
        if (!state.editing.sections[si].rows.length) state.editing.sections[si].rows.push({ date: '', task: '', time: '' });
        render();
      });
    });

    var scheduleTypeSelect = document.getElementById('f-schedule-type');
    if (scheduleTypeSelect) scheduleTypeSelect.addEventListener('change', function () {
      syncEditingFromForm();
      state.editing.schedule_type = scheduleTypeSelect.value;
      render();
      document.getElementById('f-schedule-type').focus();
    });

    var channelSelect = document.getElementById('f-channel-select');
    if (channelSelect) channelSelect.addEventListener('change', function () {
      if (channelSelect.value === '') return; // "Enter a new webhook below" — leave fields as they are
      var known = getKnownChannels()[Number(channelSelect.value)];
      if (!known) return;
      // Patches the two inputs directly rather than going through
      // state.editing + render() — a full re-render rebuilds the form
      // from state.editing alone, which doesn't have anything typed into
      // Title/Body yet (those only sync back on submit), so re-rendering
      // here would silently wipe out whatever else was already filled in.
      var webhookInput = document.querySelector('#post-form [name="webhook_url"]');
      var channelNameInput = document.querySelector('#post-form [name="channel_name"]');
      if (webhookInput) webhookInput.value = known.webhook_url;
      if (channelNameInput && known.channel_name) channelNameInput.value = known.channel_name;
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

  // Reads the current Sections editor rows straight from the DOM — used
  // both for form submission and to preserve in-progress edits across a
  // re-render triggered by Add/Remove card (state.editing.sections is
  // only otherwise updated on submit, same as every other field here).
  function readSectionsFromDom(scope) {
    return Array.prototype.map.call((scope || document).querySelectorAll('.section-row'), function (row) {
      var colorHex = row.querySelector('.js-section-color').value || '#8b5cf6';
      var dayRows = Array.prototype.map.call(row.querySelectorAll('.day-row'), function (dr) {
        return {
          date: dr.querySelector('.js-day-date').value,
          task: dr.querySelector('.js-day-task').value,
          time: dr.querySelector('.js-day-time').value,
        };
      });
      return {
        title: row.querySelector('.js-section-title').value,
        body: sectionRowsToBody(dayRows),
        rows: dayRows, // client-side only, for re-rendering the table faithfully; not read by the backend
        color: parseInt(colorHex.replace('#', ''), 16),
      };
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
      sections: readSectionsFromDom(form),
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

  // Merges every current field's value from the live DOM into
  // state.editing — needed before any handler that calls render() for a
  // reason other than form submission (changing Source/Frequency, or
  // adding/removing a card or day row), since renderForm() rebuilds the
  // whole form from state.editing alone. Without this, state.editing only
  // has whatever it started with (empty, for a new post) plus whichever
  // single field a given handler happens to set directly — so a
  // re-render would silently blank out anything else already typed
  // (Title, Body, webhook, other cards' content, etc.). Confirmed as a
  // real bug this way, not just a theoretical risk: typing a header
  // Title/Body then clicking "+ Add day" emptied them straight back out
  // before this existed.
  function syncEditingFromForm() {
    var form = document.getElementById('post-form');
    if (form) Object.assign(state.editing, readFormPayload(form));
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
