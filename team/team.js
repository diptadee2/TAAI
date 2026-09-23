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
  // Local-dev-only — mirrors requireAdmin()'s own NETLIFY_DEV-gated
  // bypass in lib/supabase.js. Netlify Identity can never authenticate
  // against localhost (no real domain to issue a JWT for), so without
  // this, `/team` on localhost is permanently stuck on the login gate
  // with a non-functional "Log in" button — the only way to test
  // anything was previously a throwaway script invoking a function
  // handler() directly, never the real page itself. This can't fire on
  // a real deploy — `location.hostname` is never 'localhost' there.
  var DEV_BYPASS = location.hostname === 'localhost';
  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var SOURCE_LABELS = {
    custom: 'Custom message (also used for weekly batch schedules)',
    daily_leader: 'Daily — Top Focus Student',
    daily_leaderboard: 'Daily — Top 3',
    weekly_leaderboard: 'Weekly — Top 5 Leaderboard',
    weekly_batch_trend: 'Weekly — Batch Median Trend',
    monthly_consistency: 'Monthly — Most Consistent Student',
  };
  // Sources whose Body is a plain optional intro line with no
  // placeholders at all — unlike LIST_SOURCES (an intro above a computed
  // medal list) or DEFAULT_BODY_BY_SOURCE (a full template sentence with
  // {{name}}/{{hours}}), this source has no per-entry data to interpolate,
  // just one computed number, so Body is either blank or a plain sentence.
  var PLAIN_INTRO_SOURCES = ['weekly_batch_trend'];
  // Sources whose content is a computed ranked list (medals, multiple
  // names) rather than a single-entity sentence — the Body field doesn't
  // apply to these (there's nothing to fill {{name}}/{{hours}} into), only
  // Title works as an override, same as the list already worked for
  // weekly_leaderboard before this was split out into its own set.
  var LIST_SOURCES = ['daily_leaderboard', 'weekly_leaderboard'];
  // Names come from gate-da-subjects.js (window.GATE_DA_SUBJECTS, loaded
  // before this script — see team/index.html), the single source of truth
  // also used by progress.js's CANONICAL_SUBJECTS, so this dropdown can't
  // drift in spelling from the tracker's own subject list. Per-subject
  // emoji (SUBJECT_EMOJI) used to be prefixed onto this value, since a
  // section's chosen subject IS what gets posted verbatim as each task
  // line's prefix on Discord — removed at explicit request ("remove the
  // emojis from the weekly schedule posts"), so SUBJECT_OPTIONS is now
  // just the plain subject names, unchanged from the canonical list.
  var GATE_DA_SUBJECT_NAMES = window.GATE_DA_SUBJECTS || [
    'Linear Algebra', 'Probability', 'Statistics', 'Calculus',
    'Machine Learning', 'AI', 'DBMS', 'Python', 'Data Structures', 'Algorithms',
  ];
  var SUBJECT_OPTIONS = GATE_DA_SUBJECT_NAMES.slice();
  // site_notes.subject/site_lectures.subject use the same kebab-case ids
  // gate-da-free-notes.html's own notes-data.json already defines for its
  // subject tabs (linear-algebra, machine-learning, ...) — derived here by
  // slugifying GATE_DA_SUBJECT_NAMES rather than a second hardcoded list,
  // since every one of those 10 names slugifies to exactly that id already
  // (confirmed by hand against notes-data.json). The server-side mirror
  // (SITE_DATA_SUBJECT_IDS in lib/supabase.js) can't reach this file's
  // window.GATE_DA_SUBJECTS global, so it stays its own hardcoded copy —
  // keep both in sync if the subject list ever changes.
  var SITE_SUBJECT_OPTIONS = GATE_DA_SUBJECT_NAMES.map(function (name) {
    return { id: name.toLowerCase().replace(/\s+/g, '-'), label: name };
  });

  // Every real site_pricing id that actually maps to a card rendered
  // somewhere on the live public site — COMBOS[]/INDIVIDUAL[] in
  // gate-da-courses.html, plus the test-series page's own 3 pricing
  // rows — hand-transcribed from those files (same unavoidable "can't
  // share a constant across this file boundary" tradeoff already
  // accepted for SITE_DATA_SUBJECT_IDS/COMBO_OWN_ROW_THRESHOLD). Backs
  // the Pricing form's ID field as a dropdown instead of free text (on
  // request, "the ids should be selectable from a dropdown menu") — a
  // non-technical admin can no longer create a typo'd slug that
  // silently never matches any live card. The two Full Course entries
  // spell out their year in the label, since "Full Course" alone
  // doesn't say which of the two cards a new row is even for.
  var SITE_PRICING_ID_GROUPS = [
    { label: 'Bundled courses', options: [
      { id: 'full-course-2028', label: 'Full Course — 2028 (full-course-2028)' },
      { id: 'full-course', label: 'Full Course — 2027 (full-course)' },
      { id: 'maths-ml-bundle', label: 'Mathematics & ML Bundle (maths-ml-bundle)' },
      { id: 'maths-bundle', label: 'Mathematics Bundle (maths-bundle)' },
    ] },
    { label: 'Individual courses', options: [
      { id: 'statistics', label: 'Statistics (statistics)' },
      { id: 'calculus', label: 'Calculus (calculus)' },
      { id: 'linear-algebra', label: 'Linear Algebra (linear-algebra)' },
      { id: 'probability', label: 'Probability (probability)' },
      { id: 'machine-learning', label: 'Machine Learning (machine-learning)' },
      { id: 'python-programming', label: 'Python Programming (python-programming)' },
    ] },
    { label: 'Test series', options: [
      { id: 'test-series', label: 'GATE DA Test Series (test-series)' },
      { id: 'test-series-quizzes', label: 'Test Series + Weekly Quizzes (test-series-quizzes)' },
      { id: 'weekly-quizzes', label: 'Weekly Quiz Pack (weekly-quizzes)' },
    ] },
  ];

  // Declarative shape for the three Site data sub-tabs (Pricing/Notes/
  // Lectures) — one config object drives the generic list table, the
  // generic create/edit form, and the generic FormData-based payload
  // reader all three share (renderSiteDataList/-Form/readSiteDataPayload
  // below), instead of three near-identical copies of each. Each field:
  // {name, label, type: 'text'|'number'|'url'|'date'|'select', options?,
  // required?, hint?, lockedOnEdit?} — lockedOnEdit disables the input
  // once editing an existing row (only site_pricing.id needs this: it's
  // the real primary key elsewhere on the site, not safe to silently
  // rename out from under every other consumer via this form).
  var SITE_DATA_RESOURCES = {
    pricing: {
      label: 'Pricing',
      endpoint: '/site-pricing',
      idKey: 'id',
      newRow: { id: '', type: 'individual', name: '', price: '', price_old: '', discount: '', discount_reason: '', discount_deadline: '', validity: '', sold_out_date: '', display_order: 0, enroll_url: '' },
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'type', label: 'Type' },
        { name: 'name', label: 'Name' },
        { name: 'price', label: 'Price', format: function (r) { return r.price != null ? '₹' + r.price : '—'; } },
        { name: 'price_old', label: 'Old price', format: function (r) { return r.price_old != null ? '₹' + r.price_old : '—'; } },
        { name: 'discount_deadline', label: 'Discount deadline', format: function (r) { return r.discount_deadline || '—'; } },
        { name: 'validity', label: 'Validity', format: function (r) { return r.validity || '—'; } },
        { name: 'sold_out_date', label: 'Sold-out date', format: function (r) { return r.sold_out_date || '—'; } },
        // Computed, not a separate flag — whether the Enrol Now button
        // would be clickable is entirely a function of "is there a real
        // link yet", on request ("the course can be declared coming
        // soon... without the enroll now link, like the full course
        // 2028 card"). Filling in Enrol URL is what flips this from
        // "Coming Soon" to "Live" — no separate toggle to forget to
        // flip alongside it.
        { name: 'enroll_url', label: 'Status', format: function (r) { return r.enroll_url ? 'Live' : 'Coming Soon'; } },
      ],
      // Grouped into labeled sections (renderSiteDataForm) — same
      // .form-section/.form-section-heading pattern the Announcements
      // form already uses for Destination/Content/etc — so a
      // non-technical admin sees "Basic info / Pricing / Enrollment &
      // dates" instead of one long undifferentiated list of 10 fields.
      fields: [
        { name: 'id', label: 'Course', type: 'select', optionGroups: SITE_PRICING_ID_GROUPS, required: true, lockedOnEdit: true, hint: 'Which course/bundle on the live site this row is for — can\'t be changed once created.', section: 'Basic info' },
        { name: 'type', label: 'Type', type: 'select', options: [{ id: 'combo', label: 'Combo/bundle' }, { id: 'individual', label: 'Individual course' }, { id: 'test-series', label: 'Test series' }], required: true, hint: 'Combo/bundle courses show up under "Bundled courses" below and can be reordered with ▲/▼; everything else shows under "Individual courses".', section: 'Basic info' },
        { name: 'name', label: 'Display name', type: 'text', required: true, section: 'Basic info' },
        { name: 'price', label: 'Price (₹)', type: 'number', section: 'Pricing' },
        { name: 'price_old', label: 'Old price (₹, optional — shown struck through)', type: 'number', section: 'Pricing' },
        { name: 'discount', label: 'Discount label (optional, e.g. "30% OFF")', type: 'text', section: 'Pricing' },
        { name: 'discount_reason', label: 'Discount reason (optional)', type: 'text', section: 'Pricing' },
        { name: 'discount_deadline', label: 'Discount deadline', type: 'date', section: 'Enrollment & dates' },
        { name: 'validity', label: 'Validity', type: 'date', section: 'Enrollment & dates' },
        // On request: leaving this blank is what puts the course in a
        // "Coming Soon" state (an unclickable button on the live page,
        // once this is ever wired up) — the same relationship the 2028
        // card already has to having no real pricing row at all, just
        // explicit here as one field instead of an absent row.
        { name: 'enroll_url', label: 'Enrol now link (blank = Coming Soon, unclickable)', type: 'url', hint: 'The real enrolment URL (e.g. https://learn.taai.live/learn/batch/GATE-2027/content). Leave blank while this course isn\'t open for enrolment yet.', section: 'Enrollment & dates' },
        // Only the full-course row gets this field, on request — the
        // live card's own sold-out cutover is exclusive to that one
        // course, so exposing it as editable elsewhere would just be
        // dead data with nothing reading it. Admin-only for now, same
        // as every other new field this round — see schema.sql's own
        // comment on why the live page doesn't read this yet.
        { name: 'sold_out_date', label: 'Sold-out date (full-course only, admin-only — not yet live)', type: 'date', showIf: function (row) { return row.id === 'full-course'; }, section: 'Enrollment & dates' },
      ],
    },
    notes: {
      label: 'Notes',
      endpoint: '/site-notes',
      idKey: 'id',
      newRow: { subject: SITE_SUBJECT_OPTIONS[0].id, title: '', description: '', file_url: '', posted_on: '' },
      columns: [
        { name: 'subject', label: 'Subject', format: function (r) { return subjectLabel(r.subject); } },
        { name: 'title', label: 'Title' },
        { name: 'posted_on', label: 'Posted on', format: function (r) { return r.posted_on || '—'; } },
      ],
      fields: [
        { name: 'subject', label: 'Subject', type: 'select', options: SITE_SUBJECT_OPTIONS, required: true },
        { name: 'title', label: 'Title', type: 'text' },
        { name: 'description', label: 'Description (optional)', type: 'text' },
        { name: 'file_url', label: 'PDF file URL', type: 'url', hint: 'A direct link to the downloadable PDF.' },
        { name: 'posted_on', label: 'Posted on', type: 'date' },
      ],
    },
    lectures: {
      label: 'Lectures',
      endpoint: '/site-lectures',
      idKey: 'id',
      newRow: { subject: SITE_SUBJECT_OPTIONS[0].id, lecture_number: '', title: '', youtube_url: '', slides_url: '', posted_on: '' },
      columns: [
        { name: 'subject', label: 'Subject', format: function (r) { return subjectLabel(r.subject); } },
        { name: 'lecture_number', label: '#' },
        { name: 'title', label: 'Title' },
        { name: 'posted_on', label: 'Posted on', format: function (r) { return r.posted_on || '—'; } },
      ],
      fields: [
        { name: 'subject', label: 'Subject', type: 'select', options: SITE_SUBJECT_OPTIONS, required: true },
        { name: 'lecture_number', label: 'Lecture #', type: 'number' },
        { name: 'title', label: 'Title', type: 'text' },
        { name: 'youtube_url', label: 'YouTube URL', type: 'url' },
        { name: 'slides_url', label: 'Slides URL (optional)', type: 'url' },
        { name: 'posted_on', label: 'Posted on', type: 'date' },
      ],
    },
  };

  function subjectLabel(id) {
    var match = SITE_SUBJECT_OPTIONS.filter(function (s) { return s.id === id; })[0];
    return match ? match.label : id;
  }
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

  // Direct feedback on a real screenshot: a built-in source's Title box
  // showed completely blank, with no hint anywhere in the box itself that
  // a real default title exists and is what's actually posting right now
  // — only the Body field had this treatment (see DEFAULT_BODY_BY_SOURCE
  // above), and only for 2 of the 5 built-in sources. These 4 are the
  // exact same literal strings resolveScheduledPostEmbed() in
  // lib/supabase.js falls back to (`row.title || '...'`) — keep both
  // copies in sync by hand if that wording ever changes, same maintenance
  // burden DEFAULT_BODY_BY_SOURCE already has. monthly_consistency is
  // deliberately NOT here — its real default title bakes in the CURRENT
  // month's name (`Most Consistent Student — ${label}`), so prefilling a
  // literal value would freeze a future month's post to whatever month
  // happened to be current when someone last saved without noticing —
  // see monthlyConsistencyTitlePlaceholder below for how that one's
  // handled instead (a placeholder, never a real saved value).
  var DEFAULT_TITLE_BY_SOURCE = {
    daily_leader: '🏆 Yesterday\'s Top Focus Session',
    daily_leaderboard: '🏆 Yesterday\'s Top 3',
    weekly_leaderboard: '📅 Weekly Top 5 Leaderboard',
    weekly_batch_trend: '📊 Weekly Batch Trend',
  };

  // A client-side approximation of previousMonthIST()/monthLabel() in
  // lib/supabase.js — good enough for a placeholder PREVIEW (the real
  // computation still only ever happens server-side, at actual post time),
  // not meant to be authoritative. Uses the browser's own local clock
  // rather than round-tripping to the server just to preview a label.
  function previousMonthLabelApprox() {
    var now = new Date();
    var d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  // Exactly which {{tokens}} are valid for the currently-selected Source —
  // drives the click-to-insert chips above the Body textarea (see
  // placeholderChipsHtml/bindEvents' .js-insert-placeholder handler).
  // Direct ask: someone non-technical needs to be able to make a small
  // wording change without knowing this curly-brace syntax exists, let
  // alone typing it correctly by hand (a single typo like {{Name}} or
  // {{ name }} just renders literally instead of being replaced — there's
  // no validation catching that server-side). Single-entity sources get
  // {{name}}/{{hours}}; ranked-list sources get one pair per position, up
  // to however many the real post shows (3 for daily, 5 for weekly); every
  // other source (custom, plain-intro) gets none, since neither has any
  // per-entry data to interpolate at all.
  function placeholdersForSource(source) {
    if (LIST_SOURCES.indexOf(source) !== -1) {
      var count = source === 'weekly_leaderboard' ? 5 : 3;
      var ordinals = ['1st', '2nd', '3rd', '4th', '5th'];
      var out = [];
      for (var i = 0; i < count; i++) {
        var suffix = i === 0 ? '' : String(i + 1);
        out.push({ token: '{{name' + suffix + '}}', desc: ordinals[i] + ' place\'s name' });
        out.push({ token: '{{hours' + suffix + '}}', desc: ordinals[i] + ' place\'s hours' });
      }
      return out;
    }
    if (PLAIN_INTRO_SOURCES.indexOf(source) !== -1 || source === 'custom') return [];
    return [{ token: '{{name}}', desc: 'their name' }, { token: '{{hours}}', desc: 'their hours' }];
  }

  function placeholderChipsHtml(source) {
    var placeholders = placeholdersForSource(source);
    if (!placeholders.length) return '';
    return '<div class="placeholder-chips">' +
      '<span class="placeholder-chips-label">Click to insert:</span> ' +
      placeholders.map(function (ph) {
        return '<button type="button" class="chip js-insert-placeholder" data-token="' + escapeHtml(ph.token) + '" title="Inserts ' + escapeHtml(ph.token) + ' — ' + escapeHtml(ph.desc) + '">' + escapeHtml(ph.token) + '</button>';
      }).join('') +
    '</div>';
  }

  var state = {
    authorized: false,
    posts: [],
    editing: null, // the post object being edited, or {} for a new one, or null when the form is closed
    preview: null, // { loading } | { embed } | { embed: null, reason } | { error } | null (not yet previewed)
    testStatus: null, // { loading } | { posted: true } | { posted: false, reason } | { error } | null
    showReference: false,
    showBuiltIn: false, // recurring daily/weekly/monthly posts start collapsed — see renderPostList()
    renamingWebhook: null, // webhook_url of the channel group currently showing a rename input, or null
    renameStatus: null, // { webhookUrl, saving } | { webhookUrl, error } | null
    tab: 'announcements', // 'announcements' | 'students' — mutually exclusive views, not stacked panels
    students: null, // null = not loaded yet; array once fetched
    studentsLoading: false,
    studentsError: null,
    studentSort: { key: 'total_minutes', dir: 'desc' },
    studentSummary: null,
    studentFilters: { search: '', inactive: '', minStreak: '' }, // inactive: '' | '3' | '7' | '14' | '30' | 'never'
    noteSaving: {}, // email -> 'saving' | 'saved' | 'error', transient per-row save feedback
    // Pricing/Notes/Lectures are three independent lists under one Site
    // data tab — rows/editing are keyed by resource type (see
    // SITE_DATA_RESOURCES) rather than three near-identical flat state
    // shapes, same "one config, generic renderer" discipline the resource
    // config object itself follows.
    siteData: {
      subTab: 'pricing', // 'pricing' | 'notes' | 'lectures'
      rows: { pricing: null, notes: null, lectures: null }, // null = not loaded yet
      loading: { pricing: false, notes: false, lectures: false },
      error: { pricing: null, notes: null, lectures: null },
      editing: null, // { type, row } | null
      saving: false,
    },
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

  // isFirst/isLast are about position within this post's own channel
  // group (see renderPostGroups' dispatch-order sort), not the flat post
  // list — the up/down buttons only ever reorder posts that share a
  // destination, since dispatch_order otherwise has no visible effect
  // (two posts going to different channels never interleave with each
  // other from a viewer's perspective either way).
  // Shows exactly what's currently configured — the raw, literal text
  // (placeholders and markdown shown as-typed, not resolved) — right in
  // the list, so checking current wording no longer requires opening Edit
  // first. Direct ask: "everything should have the current... syntax in
  // the body" visible. A 'custom' post's real content can live in
  // `sections` instead of `body` (a weekly schedule has no body text at
  // all) — summarized as a day/topic count in that case rather than
  // showing blank with no explanation.
  function bodySnippetText(p) {
    if (p.body) return p.body;
    if (p.source === 'custom') {
      var sections = Array.isArray(p.sections) ? p.sections : [];
      var dayCount = sections.reduce(function (n, s) { return n + (Array.isArray(s.rows) ? s.rows.length : 0); }, 0);
      if (dayCount) return '(no body text — ' + sections.length + ' section(s), ' + dayCount + ' day row(s) below)';
      return '(empty — click Edit to add text)';
    }
    if (DEFAULT_BODY_BY_SOURCE[p.source]) return '(using the default wording) ' + DEFAULT_BODY_BY_SOURCE[p.source];
    return '(no intro line — just the computed number/list)';
  }
  function renderPostRow(p, isFirst, isLast) {
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
    var bodySnippet = bodySnippetText(p);
    var truncated = bodySnippet.length > 160 ? bodySnippet.slice(0, 160) + '…' : bodySnippet;

    return (
      '<div class="post-row" data-id="' + p.id + '">' +
        '<div class="post-order-buttons">' +
          '<button class="btn-order js-move-up" data-id="' + p.id + '" title="Fire earlier than the post below it, when both are due at the same time"' + (isFirst ? ' disabled' : '') + '>▲</button>' +
          '<button class="btn-order js-move-down" data-id="' + p.id + '" title="Fire later than the post above it, when both are due at the same time"' + (isLast ? ' disabled' : '') + '>▼</button>' +
        '</div>' +
        '<div class="post-main">' +
          '<div class="post-title">' + tagHtml + disabledTag + ' ' + escapeHtml(title) + (p.tag_everyone ? ' 📣' : '') + '</div>' +
          '<div class="post-meta">' + scheduleDesc + ' — next: ' + formatNextFire(p.next_fire_at) + '</div>' +
          '<div class="post-body-snippet" title="' + escapeHtml(bodySnippet) + '">' + escapeHtml(truncated) + '</div>' +
        '</div>' +
        '<div class="post-actions">' +
          '<button class="btn btn-small js-edit" data-id="' + p.id + '">Edit</button>' +
          '<button class="btn btn-small js-toggle" data-id="' + p.id + '">' + (p.enabled ? 'Pause' : 'Resume') + '</button>' +
          '<button class="btn btn-small btn-danger js-delete" data-id="' + p.id + '">Delete</button>' +
        '</div>' +
      '</div>'
    );
  }

  // Same tiebreak discord-dispatch.js's own query uses (dispatch_order,
  // then created_at) — so a group's on-screen order always matches the
  // order posts sharing a fire time would actually go out in, which is
  // the whole point of showing the up/down buttons at all.
  function sortByDispatchOrder(rows) {
    return rows.slice().sort(function (a, b) {
      var orderDiff = (a.dispatch_order || 0) - (b.dispatch_order || 0);
      if (orderDiff !== 0) return orderDiff;
      return (a.created_at || '').localeCompare(b.created_at || '');
    });
  }

  // Distinct webhooks already used by an existing post, newest first —
  // powers the "Load a saved channel" dropdown so a new/edited post can
  // reuse one without retyping/repasting the URL.
  // A Telegram row's webhook_url actually holds its bot's API token, which
  // can be shared across several different chats — unlike a Discord
  // webhook URL, which is already channel-specific by itself. So "the
  // same channel" for grouping/dedup purposes means webhook_url alone for
  // Discord, but webhook_url + telegram_chat_id together for Telegram.
  function channelKey(post) {
    return post.platform === 'telegram' ? 'telegram|' + post.webhook_url + '|' + post.telegram_chat_id : (post.webhook_url || '');
  }

  function getKnownChannels() {
    var seen = {};
    var list = [];
    state.posts.forEach(function (post) {
      var key = channelKey(post);
      if (!key || seen[key]) return;
      seen[key] = true;
      list.push({ key: key, webhook_url: post.webhook_url, channel_name: post.channel_name || null, platform: post.platform || 'discord', telegram_chat_id: post.telegram_chat_id || null });
    });
    return list;
  }

  function channelSelectLabel(c) {
    var tail = c.channel_name || ('…' + c.webhook_url.slice(-10));
    return c.platform === 'telegram' ? '📨 ' + tail : tail;
  }

  // Real gap, direct feedback: this never showed which channel a post
  // ALREADY uses when opened for Edit — always defaulted to "-- Enter a
  // new webhook below --" even when the post's own webhook/chat exactly
  // matches a channel already in the list, same "empty box that should
  // show what's actually there" issue Title/Body just got fixed for.
  // `p` is optional — the "+ New post" flow calls this with nothing, and
  // an unmatched channel (its own key not found among getKnownChannels,
  // e.g. a genuinely new webhook nobody's saved yet) correctly falls back
  // to the same "-- Enter a new webhook --" as before, not a false match.
  function renderChannelSelect(p) {
    var known = getKnownChannels();
    if (!known.length) return '';
    var currentKey = p ? channelKey(p) : '';
    var options = known.map(function (c, i) {
      return '<option value="' + i + '"' + (currentKey && c.key === currentKey ? ' selected' : '') + '>' + escapeHtml(channelSelectLabel(c)) + '</option>';
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
  // Grouped by webhook_url (the actual channel identity — a post's
  // channel_name is just a display label, and two posts can only ever be
  // "the same channel" if they post to the same place), not by the label
  // text itself — so renaming a channel can unambiguously mean "every
  // post whose webhook_url matches this group", not "every post whose
  // label happened to match the old text" (which breaks if a row was
  // ever left unlabeled or mislabeled).
  function renderPostGroups(posts) {
    if (!posts.length) return '<div class="empty">Nothing here yet.</div>';

    var groups = {};
    var keys = [];
    posts.forEach(function (p) {
      var key = channelKey(p) || '(no destination set)';
      if (!groups[key]) { groups[key] = []; keys.push(key); }
      groups[key].push(p);
    });
    keys.sort(function (a, b) {
      return groupLabel(groups[a]).localeCompare(groupLabel(groups[b]));
    });

    return keys.map(function (key) {
      var rows = sortByDispatchOrder(groups[key]);
      var label = groupLabel(rows);
      var isTelegram = rows[0].platform === 'telegram';
      var isRenaming = state.renamingWebhook === key;
      var headingHtml = isRenaming
        ? (
          '<input type="text" id="rename-input" class="rename-input" value="' + escapeHtml(label) + '">' +
          '<button type="button" class="btn btn-small btn-primary js-rename-save" data-webhook="' + escapeHtml(key) + '">Save</button>' +
          '<button type="button" class="btn btn-small js-rename-cancel">Cancel</button>'
        )
        : (
          (isTelegram ? '📨 ' : '') + escapeHtml(label) + ' <span class="channel-group-count">(' + rows.length + ')</span>' +
          '<button type="button" class="btn btn-small js-rename-start" data-webhook="' + escapeHtml(key) + '" title="Rename this channel everywhere it\'s used">✎</button>'
        );
      return (
        '<div class="card channel-group">' +
          '<div class="channel-group-heading">' + headingHtml + '</div>' +
          (state.renameStatus && state.renameStatus.webhookUrl === key ? renderRenameStatus() : '') +
          rows.map(function (p, i) { return renderPostRow(p, i === 0, i === rows.length - 1); }).join('') +
        '</div>'
      );
    }).join('');
  }

  function groupLabel(rows) {
    var named = rows.filter(function (p) { return p.channel_name; })[0];
    if (named) return named.channel_name;
    var first = rows[0] || {};
    // A Telegram row's webhook_url is its bot's token, not a meaningful
    // per-channel identifier the way a Discord webhook URL's tail is —
    // telegram_chat_id is the actual destination, so that's what an
    // unlabeled Telegram group falls back to showing instead.
    if (first.platform === 'telegram') return first.telegram_chat_id ? '(unlabeled: ' + first.telegram_chat_id + ')' : '(no chat id set)';
    return first.webhook_url ? '(unlabeled: …' + first.webhook_url.slice(-10) + ')' : '(no channel set)';
  }

  function renderRenameStatus() {
    var s = state.renameStatus;
    if (s.saving) return '<div class="field-hint" style="padding:0 0 8px;">Renaming across ' + s.count + ' post(s)…</div>';
    if (s.error) return '<div class="msg msg-error" style="margin:0 0 10px;">' + escapeHtml(s.error) + '</div>';
    return '';
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

    // A weekly batch schedule IS a custom post (source: 'custom') with its
    // "Extra sections" table filled in — there's no separate "schedule"
    // concept anywhere in the data model. Reported directly as hard to
    // find: with zero custom posts saved, this section used to render as
    // a bare heading + "Nothing here yet.", no hint that this is where a
    // next-week schedule actually gets created, or that the single global
    // "+ New post" button (elsewhere on the page) is what to click. This
    // button is a second, section-local entry point to the exact same
    // flow (see startNewPost), always visible here regardless of whether
    // state.editing is already open, specifically so it's discoverable
    // from this heading without having to already know to scroll up.
    var customHtml =
      '<div class="post-list-heading-row">' +
        '<h3 class="post-list-heading">Custom announcements</h3>' +
        '<button type="button" class="btn btn-small" id="new-custom-btn">+ New announcement / schedule</button>' +
      '</div>' +
      '<div class="field-hint" style="margin-bottom:10px;">A weekly batch schedule is a Custom message with its "Extra sections" filled in below — pick a Subject and fill in one Date/Topic/Duration row per class.</div>' +
      (customPosts.length ? renderPostGroups(customPosts)
        : '<div class="empty">No announcements or schedules yet — click "+ New announcement / schedule" above to add next week\'s.</div>');

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
  // A repeatable list of {title, day-rows} sections, only shown for
  // source: 'custom'. Unlike the first version of this feature, rows are
  // now the actual persisted data (real `<input type="date">` values, not
  // free text) — needed so the final post can be sorted chronologically
  // and show each date's weekday, which isn't reliably possible from an
  // arbitrary typed string like "Jun 15" (could be "15th June", "6/15",
  // anything). resolveScheduledPostEmbed() in lib/supabase.js merges
  // every section's rows into one date-grouped list (see its comment for
  // why — subjects are labels on each day's line, not separate headings
  // anymore: "the order of mention of everything should be date wise").
  // Each section's content is a Date/Topic/Duration table (matching how
  // the source spreadsheet is already laid out) rather than a free-text
  // box, so someone filling this in doesn't need to know Discord markdown
  // syntax. Keep the "Subject" label short — it repeats on every one of
  // that subject's lines in the final date-grouped post now, not shown
  // once as a heading.
  // Builds the Subject <select>'s options, always including the current
  // value even if it isn't one of SUBJECT_OPTIONS (a blank first row, or
  // free text saved before this became a dropdown) — so opening an
  // existing post never silently swaps its subject to something else on
  // save.
  function subjectOptionsHtml(current) {
    var options = SUBJECT_OPTIONS.slice();
    if (current && options.indexOf(current) === -1) options.unshift(current);
    var placeholder = '<option value=""' + (current ? '' : ' selected') + '>-- choose a subject --</option>';
    return placeholder + options.map(function (name) {
      return '<option value="' + escapeHtml(name) + '"' + (name === current ? ' selected' : '') + '>' + escapeHtml(name) + '</option>';
    }).join('');
  }

  function renderSectionsEditor(p) {
    if (p.source !== 'custom') return '';
    var sections = Array.isArray(p.sections) ? p.sections : [];
    var sectionsHtml = sections.map(function (s, si) {
      var dayRows = Array.isArray(s.rows) && s.rows.length ? s.rows : [{ date: '', task: '', time: '' }];
      var dayRowsHtml = dayRows.map(function (r, ri) {
        return (
          '<tr class="day-row">' +
            '<td><input type="date" class="js-day-date" value="' + escapeHtml(r.date) + '"></td>' +
            '<td><input type="text" class="js-day-task" placeholder="Topic"  value="' + escapeHtml(r.task) + '"></td>' +
            '<td><input type="text" class="js-day-time" placeholder="1h25m" value="' + escapeHtml(r.time) + '"></td>' +
            '<td><button type="button" class="btn btn-small btn-danger js-day-remove" data-section-index="' + si + '" data-row-index="' + ri + '">×</button></td>' +
          '</tr>'
        );
      }).join('');
      return (
        '<div class="section-row" data-index="' + si + '">' +
          '<div class="field"><label>Subject</label><select class="js-section-title">' + subjectOptionsHtml(s.title) + '</select></div>' +
          '<table class="day-table"><thead><tr><th>Date</th><th>Topic</th><th>Duration</th><th></th></tr></thead>' +
          '<tbody>' + dayRowsHtml + '</tbody></table>' +
          '<div style="display:flex;gap:8px;margin-top:8px;">' +
            '<button type="button" class="btn btn-small js-day-add" data-section-index="' + si + '">+ Add day</button>' +
            '<button type="button" class="btn btn-small btn-danger js-section-remove" data-index="' + si + '">Remove section</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
    return (
      '<div class="form-section">' +
        '<div class="form-section-heading">Extra sections (optional)</div>' +
        '<div class="field-hint" style="margin-bottom:10px;">Pick a Subject from the dropdown, then fill in one row per day; leave Duration blank for entries like a quiz that has none. All sections merge into one date-ordered list in the final post, not shown subject-by-subject.</div>' +
        '<div id="sections-list">' + sectionsHtml + '</div>' +
        '<button type="button" class="btn btn-small" id="f-add-section">+ Add section</button>' +
      '</div>'
    );
  }

  function renderForm(p) {
    var isNew = !p.id;
    var source = p.source || 'custom';
    var scheduleType = p.schedule_type || 'daily';

    // Grouped into the same two buckets the post list itself already uses
    // (Custom announcements vs. recurring leaderboards) — the dropdown
    // used to list all 6 flat, so "Custom" (the one someone actually wants
    // most weeks) sat visually equal to 5 built-in options it has nothing
    // in common with, no hint that it's the odd one out.
    function sourceOptionHtml(key) { return '<option value="' + key + '"' + (key === source ? ' selected' : '') + '>' + SOURCE_LABELS[key] + '</option>'; }
    var sourceOptions =
      '<optgroup label="Custom">' + sourceOptionHtml('custom') + '</optgroup>' +
      '<optgroup label="Recurring leaderboards">' +
        Object.keys(SOURCE_LABELS).filter(function (key) { return key !== 'custom'; }).map(sourceOptionHtml).join('') +
      '</optgroup>';

    var scheduleOptions = Object.keys(SCHEDULE_LABELS).map(function (key) {
      return '<option value="' + key + '"' + (key === scheduleType ? ' selected' : '') + '>' + SCHEDULE_LABELS[key] + '</option>';
    }).join('');

    var dayOfWeekOptions = DAY_NAMES.map(function (name, i) {
      return '<option value="' + i + '"' + (p.schedule_day_of_week === i ? ' selected' : '') + '>' + name + '</option>';
    }).join('');

    var isList = LIST_SOURCES.indexOf(source) !== -1;
    var isPlainIntro = PLAIN_INTRO_SOURCES.indexOf(source) !== -1;
    var bodyHint = source === 'custom'
      ? 'The literal message text.'
      : isList
        ? 'Optional intro line shown above the medal list (the list itself always shows regardless). {{name}}/{{hours}} = 1st place, {{name2}}/{{hours2}} = 2nd, {{name3}}/{{hours3}} = 3rd (up to {{name5}}/{{hours5}} for the weekly top 5).'
        : isPlainIntro
          ? 'Optional intro line shown above the trend number (the number itself always shows regardless). No placeholders — plain text only, or leave blank for no intro line.'
          : 'Pre-filled with the current default wording below — edit it directly, or clear the box entirely to fall back to this same default. Supports {{name}} and {{hours}} placeholders.';
    // Only pre-fill when there's no real custom body saved (never overwrite
    // one that is) and only for sources that have a default sentence at
    // all. An empty body is treated the same as null here on purpose —
    // for these two sources blank always means "show the hardcoded
    // default" functionally (see resolveScheduledPostEmbed's `row.body ||
    // DEFAULT`), there's no distinct "truly blank" state to preserve.
    var bodyValue = (p.body != null && p.body !== '') ? p.body : (DEFAULT_BODY_BY_SOURCE[source] || '');
    // A ranked-list/plain-intro source's blank Body is a real, meaningful
    // choice (no intro line, not "use some default sentence") — so unlike
    // bodyValue above, this is a placeholder (grayed hint text INSIDE the
    // empty box, never saved), not a value, so it can't get typed over and
    // accidentally saved as if it were real body text.
    var bodyPlaceholder = !bodyValue
      ? (isList ? 'Leave blank to show just the ranked list below, with no intro line.'
        : isPlainIntro ? 'Leave blank to show just the number, with no intro line.' : '')
      : '';
    var bodyField = '<div class="field"><label>Body</label><textarea name="body" id="f-body"' + (bodyPlaceholder ? ' placeholder="' + escapeHtml(bodyPlaceholder) + '"' : '') + '>' + escapeHtml(bodyValue) + '</textarea>' + placeholderChipsHtml(source) + '<div class="field-hint">' + bodyHint + '</div></div>';

    // Same "show what's actually in use, not a blank box" treatment as
    // Body above — see DEFAULT_TITLE_BY_SOURCE's own comment for why
    // monthly_consistency is a placeholder (dynamic, never safe to bake in
    // as a saved value) while the other 4 built-ins get a real prefilled
    // value (all 4 are fixed strings — saving them verbatim changes
    // nothing about what would have posted anyway).
    var titleValue = p.title || '';
    var titlePlaceholder = '';
    if (!titleValue && source !== 'custom') {
      if (DEFAULT_TITLE_BY_SOURCE[source]) titleValue = DEFAULT_TITLE_BY_SOURCE[source];
      else if (source === 'monthly_consistency') titlePlaceholder = '🏅 Most Consistent Student — ' + previousMonthLabelApprox() + ' (the month name updates itself automatically)';
    }

    var platform = p.platform === 'telegram' ? 'telegram' : 'discord';
    var platformOptions =
      '<option value="discord"' + (platform === 'discord' ? ' selected' : '') + '>Discord</option>' +
      '<option value="telegram"' + (platform === 'telegram' ? ' selected' : '') + '>Telegram</option>';

    // Telegram's Bot API needs two separate things a Discord webhook URL
    // already bundles into one: the bot's own credential (its token,
    // embedded in the API base URL — see postToTelegram/
    // resolveScheduledPostText in lib/supabase.js) and the destination
    // *within* that bot's reach (a chat id/@username it's been added to
    // as admin). "Test" mirrors that: a separate bot-API-URL field for a
    // wholly different test bot if wanted, plus a required separate test
    // chat id — same "never the row's real destination" discipline
    // Discord's Send Test already has.
    var destinationHtml = platform === 'telegram'
      ? (
        '<div class="field"><label>Telegram Bot API URL</label><input type="url" name="webhook_url" placeholder="https://api.telegram.org/bot&lt;YOUR_BOT_TOKEN&gt;" value="' + escapeHtml(p.webhook_url) + '" required><div class="field-hint">From @BotFather: create a bot, copy its token, and use it here as https://api.telegram.org/bot&lt;TOKEN&gt; (with the word "bot" directly before the token, no space). The bot must be added as an admin of the target channel.</div></div>' +
        '<div class="field"><label>Chat ID</label><input type="text" name="telegram_chat_id" placeholder="@your_channel_username or a numeric chat id" value="' + escapeHtml(p.telegram_chat_id) + '" required><div class="field-hint">A public channel\'s @username works directly. A private channel needs its numeric chat id instead (forward a message from it to @userinfobot, or check the bot API\'s getUpdates response, to find it).</div></div>' +
        '<div class="field"><label>Test bot API URL (optional)</label><input type="url" name="test_webhook_url" placeholder="A different bot\'s API URL, only if you want a separate test bot" value="' + escapeHtml(p.test_webhook_url) + '"><div class="field-hint">Leave blank to reuse the same bot above for testing — only the Test Chat ID below needs to actually differ.</div></div>' +
        '<div class="field"><label>Test Chat ID</label><input type="text" name="telegram_test_chat_id" placeholder="A private test channel/chat this bot is also admin of" value="' + escapeHtml(p.telegram_test_chat_id) + '"><div class="field-hint">Never used by the real schedule — only "Send Test" below posts here, on demand. Point this at a private test chat, not the real channel.</div></div>'
      )
      : (
        '<div class="field"><label>Webhook URL</label><input type="url" name="webhook_url" placeholder="https://discord.com/api/webhooks/..." value="' + escapeHtml(p.webhook_url) + '" required></div>' +
        '<div class="field"><label>Test webhook URL (optional)</label><input type="url" name="test_webhook_url" placeholder="A separate test-channel webhook, for the Send Test button below" value="' + escapeHtml(p.test_webhook_url) + '"><div class="field-hint">Never used by the real schedule — only "Send Test" below posts here, on demand. Point this at a private test channel, not the real one.</div></div>'
      );

    return (
      '<div class="card">' +
        '<h2 style="font-size:16px;margin-bottom:16px;">' + (isNew ? 'New scheduled post' : 'Edit scheduled post') + '</h2>' +
        '<form id="post-form">' +

          '<div class="form-section">' +
            '<div class="form-section-heading">Destination</div>' +
            '<div class="field"><label>Platform</label><select name="platform" id="f-platform">' + platformOptions + '</select></div>' +
            renderChannelSelect(p) +
            '<div class="field"><label>Channel name (for your reference)</label><input type="text" name="channel_name" placeholder="e.g. #announcements" value="' + escapeHtml(p.channel_name) + '"></div>' +
            destinationHtml +
          '</div>' +

          '<div class="form-section">' +
            '<div class="form-section-heading">Content</div>' +
            '<div class="field"><label>Source</label><select name="source" id="f-source">' + sourceOptions + '</select></div>' +
            '<div class="field"><label>Title (optional' + (source !== 'custom' ? ' — overrides the default' : '') + ')</label><input type="text" name="title" value="' + escapeHtml(titleValue) + '"' + (titlePlaceholder ? ' placeholder="' + escapeHtml(titlePlaceholder) + '"' : '') + '></div>' +
            bodyField +
            (platform === 'telegram' ? '' : '<div class="field"><label>Card color</label><input type="color" name="color" value="' + colorToHex(p.color) + '"></div>') +
          '</div>' +

          renderSectionsEditor(p) +

          (platform === 'telegram' ? '' :
          '<div class="form-section">' +
            '<div class="form-section-heading">Mentions</div>' +
            '<div class="checkbox-row"><input type="checkbox" id="f-everyone" name="tag_everyone"' + (p.tag_everyone ? ' checked' : '') + '><label for="f-everyone">Tag @everyone</label></div>' +
            '<div class="field"><label>Additional mentions (optional)</label><input type="text" name="extra_mentions" placeholder="@here, or &lt;@&amp;ROLE_ID&gt; for a role, &lt;@USER_ID&gt; for a person" value="' + escapeHtml(p.extra_mentions) + '"><div class="field-hint">Type the exact Discord mention. For a role or person, right-click them in Discord (Developer Mode must be on in Discord\'s settings) and Copy ID, then use &lt;@&amp;THAT_ID&gt; for a role or &lt;@THAT_ID&gt; for a person.</div></div>' +
          '</div>') +

          '<div class="form-section">' +
            '<div class="form-section-heading">Schedule</div>' +
            '<div class="field-row">' +
              '<div class="field"><label>Frequency</label><select name="schedule_type" id="f-schedule-type">' + scheduleOptions + '</select></div>' +
              '<div class="field"><label>Time (IST)</label><input type="time" name="schedule_time" value="' + escapeHtml(p.schedule_time || '10:00') + '" required>' +
              '<div class="field-hint">Posts are checked every 15 minutes (:00, :15, :30, :45), not continuously — a time in between (like 10:31) won\'t fire until the next check after it, so it\'d actually go out at 10:45. Pick a time ending in :00/:15/:30/:45 to fire on the exact minute.</div>' +
              '</div>' +
            '</div>' +
            '<div id="f-schedule-extra">' +
              (scheduleType === 'once' ? '<div class="field"><label>Date</label><input type="date" name="schedule_date" value="' + escapeHtml(p.schedule_date) + '" required><div class="field-hint">Fires exactly once, then pauses itself automatically (shows as "Paused" in the list below — it\'s not deleted, you can still open and resume it).</div></div>' : '') +
              (scheduleType === 'weekly' ? '<div class="field"><label>Day of week</label><select name="schedule_day_of_week">' + dayOfWeekOptions + '</select></div>' : '') +
              (scheduleType === 'monthly' ? '<div class="field"><label>Day of month</label><input type="number" name="schedule_day_of_month" min="1" max="31" value="' + (p.schedule_day_of_month || 1) + '" required></div>' : '') +
            '</div>' +
            '<div class="checkbox-row"><input type="checkbox" id="f-enabled" name="enabled"' + (p.enabled !== false ? ' checked' : '') + '><label for="f-enabled">Enabled</label></div>' +
          '</div>' +

          // Previously only explained inside the "? Syntax reference"
          // panel (collapsed by default) — easy to never see before
          // clicking one of these for the first time. Moved right above
          // the buttons themselves, where the decision "which one do I
          // click" actually happens, not documented elsewhere and hoped
          // someone finds it first.
          '<div class="field-hint" style="margin-top:-6px;">' +
            '<strong>Preview</strong> shows what would post right now — nothing is sent or saved. ' +
            '<strong>Send Test</strong> actually posts, for real, to the Test webhook/chat above (never the real one). ' +
            '<strong>' + (isNew ? 'Create' : 'Save') + '</strong> stores this post\'s settings — it doesn\'t post anything by itself, it just schedules it for its own next fire time.' +
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

  // Telegram's response (resolveScheduledPostText) is already the exact
  // HTML sent as parse_mode: 'HTML' — safe to drop straight into the page
  // as-is (it only ever contains the handful of tags
  // discordMarkdownToTelegramHtml introduces, over already-escaped text),
  // so this is a genuinely accurate preview, not a second approximation
  // of Telegram's own rendering.
  function renderTelegramPreview(text) {
    return '<div class="preview-box telegram-preview">' +
      '<div class="preview-username">📨 Telegram bot</div>' +
      '<div class="preview-description">' + text + '</div>' +
    '</div>';
  }

  function renderPreviewBox() {
    if (!state.preview) return '';
    if (state.preview.loading) return '<div class="preview-box"><div class="field-hint">Loading preview…</div></div>';
    if (state.preview.error) return '<div class="preview-box"><div class="msg msg-error" style="margin:0;">' + escapeHtml(state.preview.error) + '</div></div>';

    if (state.preview.platform === 'telegram') {
      if (!state.preview.text) return '<div class="preview-box"><div class="field-hint">' + escapeHtml(state.preview.reason || 'Nothing to preview.') + '</div></div>';
      return renderTelegramPreview(state.preview.text);
    }

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
              ? '<p>Signed in' + (user.email ? ' as ' + escapeHtml(user.email) : '') + ', but this account is not authorized for /team.</p>'
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
    var isStudents = state.tab === 'students';
    var isSiteData = state.tab === 'site-data';
    // Counts right on the tab itself — knowing "there are 12 announcements,
    // 334 students" without having to click in first is a small thing, but
    // it's also the kind of at-a-glance orientation a two-tab page with no
    // other landing content otherwise has zero of. Students' count is
    // blank until actually loaded (null, not 0) rather than showing a
    // misleading "(0)" before the first fetch resolves.
    var postsCountLabel = state.posts.length ? ' (' + state.posts.length + ')' : '';
    var studentsCountLabel = state.students ? ' (' + state.students.length + ')' : '';
    var tabsHtml =
      '<div class="tabs">' +
        '<button class="tab-btn' + (isAnnouncements ? ' active' : '') + '" data-tab="announcements">📣 Announcements' + postsCountLabel + '</button>' +
        '<button class="tab-btn' + (isStudents ? ' active' : '') + '" data-tab="students">👥 Students' + studentsCountLabel + '</button>' +
        '<button class="tab-btn' + (isSiteData ? ' active' : '') + '" data-tab="site-data">🗂️ Site data</button>' +
      '</div>';

    var actionsHtml = isAnnouncements
      ? ('<button class="btn" id="reference-toggle">' + (state.showReference ? 'Hide syntax reference' : '? Syntax reference') + '</button>' +
         (state.editing ? '' : '<button class="btn btn-primary" id="new-btn">+ New post</button>'))
      // Students has no "create" action (rows come from real registrations,
      // never created here) — a refresh button fills that gap instead, so
      // checking for someone's just-completed session doesn't require
      // switching to Announcements and back (the only way to force a
      // re-fetch before this, since loadStudents() only ever ran once per
      // page visit, on the tab's first click — see bindEvents' tab handler).
      : isStudents
        ? '<button class="btn" id="students-refresh"' + (state.studentsLoading ? ' disabled' : '') + '>↻ Refresh</button>'
        // Site data's own create action is per-sub-tab (Pricing/Notes/
        // Lectures are three independent lists, not one form) — rendered
        // inside renderSiteData() itself, next to its own sub-tab bar,
        // rather than up here where there'd be no way to know which of
        // the three "+ New" should apply to.
        : '';

    var bodyHtml = isAnnouncements
      ? ((state.showReference ? renderReference() : '') +
         msgHtml +
         (state.editing ? renderForm(state.editing) : '') +
         renderPostList())
      : isStudents
        ? renderStudents()
        : (msgHtml + renderSiteData());

    root.innerHTML =
      '<div class="wrap">' +
        '<header>' +
          '<div><h1>Team Console</h1><div class="sub">' + (DEV_BYPASS ? 'Local dev mode — auth bypassed, not signed in' : 'Signed in as ' + escapeHtml(user.email)) + '</div></div>' +
          '<div style="display:flex;gap:10px;">' +
            actionsHtml +
            (DEV_BYPASS ? '' : '<button class="btn" id="logout-btn">Log out</button>') +
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
          '<div class="ref-row"><strong>Custom message</strong> — whatever you type in Title/Body, posted as-is. No live data. Optionally add "Extra sections" below the Body — one per subject, each a Date/Topic/Duration table. All subjects\' rows merge into one date-ordered list in the final post (grouped by day, with the weekday shown), not shown subject-by-subject — everything still posts as a single card.</div>' +
          '<div class="ref-row"><strong>Daily — Top Focus Student</strong> — yesterday\'s single top student. Body fully replaces the default sentence if set.</div>' +
          '<div class="ref-row"><strong>Daily — Top 3</strong> / <strong>Weekly — Top 5 Leaderboard</strong> — a computed, freshly-ranked list every time it fires. Body (if set) is an intro line shown ABOVE the medal list — the list itself always shows regardless, you can\'t remove it.</div>' +
          '<div class="ref-row"><strong>Weekly — Batch Median Trend</strong> — a separate post from the Top 5 leaderboard (schedule it a few minutes after that one so it lands as a follow-up message). Reports whether the whole active cohort\'s median focus time rose or fell vs. the week before — one computed number, no ranked list.</div>' +
          '<div class="ref-row"><strong>Monthly — Most Consistent Student</strong> — reports on the month that just closed, ranked by median daily minutes (not average). Body fully replaces the default sentence if set.</div>' +
        '</div>' +

        '<div class="ref-section"><div class="ref-heading">Body placeholders</div>' +
          '<div class="ref-row">Single-student sources (Daily Top Focus Student, Monthly Consistency): <code>{{name}}</code> and <code>{{hours}}</code> only.</div>' +
          '<div class="ref-row">Ranked-list sources (Daily Top 3, Weekly Top 5): <code>{{name}}</code>/<code>{{hours}}</code> = 1st place, <code>{{name2}}</code>/<code>{{hours2}}</code> = 2nd, <code>{{name3}}</code>/<code>{{hours3}}</code> = 3rd, up through <code>{{name5}}</code>/<code>{{hours5}}</code> on the weekly one. An unused one (e.g. <code>{{name4}}</code> on a top-3 post) just renders blank.</div>' +
          '<div class="ref-row">Weekly — Batch Median Trend: no placeholders — Body, if set, is just a plain intro line shown above the number.</div>' +
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
          '<div class="ref-row"><strong>▲/▼ buttons</strong> on each post — set which post fires first when two posts in the same channel are due at the same time (e.g. the weekly leaderboard before the weekly trend post). Only matters within one channel; has no effect on posts going to a different destination.</div>' +
          '<div class="ref-row"><strong>Posts are checked every 15 minutes</strong> (:00/:15/:30/:45), not continuously — a Time that doesn\'t land exactly on one of those fires at the next check after it, not the minute you typed.</div>' +
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

  // Search matches name or email (case-insensitive substring). "Inactive"
  // is a days_inactive threshold computed server-side (team-students.js,
  // against the same IST "today" every other date calc here uses) rather
  // than redone client-side — 'never' is its own bucket (days_inactive
  // null, distinct from a real large number) for a student who
  // registered but never logged a session at all. Filters narrow the
  // table only; the summary cards above it always reflect the full
  // roster (see renderStudents) so filtering never hides the big-picture
  // numbers.
  function filteredStudents() {
    var f = state.studentFilters;
    var search = f.search.trim().toLowerCase();
    var minStreak = f.minStreak !== '' ? Number(f.minStreak) : null;
    return (state.students || []).filter(function (s) {
      if (search && s.display_name.toLowerCase().indexOf(search) === -1 && s.email.toLowerCase().indexOf(search) === -1) return false;
      if (minStreak != null && s.streak < minStreak) return false;
      if (f.inactive === 'never') return s.days_inactive == null;
      if (f.inactive) return s.days_inactive != null && s.days_inactive >= Number(f.inactive);
      return true;
    });
  }

  function sortedStudents() {
    var key = state.studentSort.key;
    var dir = state.studentSort.dir === 'asc' ? 1 : -1;
    return filteredStudents().slice().sort(function (a, b) {
      var av = a[key], bv = b[key];
      if (av == null) av = key === 'display_name' ? '' : -Infinity;
      if (bv == null) bv = key === 'display_name' ? '' : -Infinity;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  // Green/amber/red purely by recency, same three-bucket vocabulary as
  // the tracker's own day-status pill (complete/pending/missed) —
  // familiar rather than inventing a fourth color scheme.
  function inactivityClass(daysInactive) {
    if (daysInactive == null) return 'inactivity-never';
    if (daysInactive <= 2) return 'inactivity-fresh';
    if (daysInactive <= 6) return 'inactivity-warm';
    return 'inactivity-cold';
  }
  function lastActiveLabel(s) {
    if (s.days_inactive == null) return 'Never';
    if (s.days_inactive === 0) return 'Today';
    if (s.days_inactive === 1) return 'Yesterday';
    return s.days_inactive + 'd ago';
  }

  // A dedicated Students view for spotting high performers (default sort:
  // most all-time focus hours first) and students who've dropped off (sort
  // by Last active to see who's gone quiet), plus a free-text Notes field
  // per student purely for the team's own reference — see the `notes`
  // column added to `students` in schema.sql.
  // Summary cards use state.studentSummary (computed server-side over the
  // FULL roster) rather than deriving from state.students client-side, so
  // these numbers stay stable as the true "state of the class" regardless
  // of whatever search/filter is currently narrowing the table below.
  function renderStudentSummary() {
    var sum = state.studentSummary;
    if (!sum) return '';
    var cards = [
      { label: 'Students', value: sum.total_students },
      { label: 'Active this week', value: sum.active_this_week + ' / ' + sum.total_students },
      { label: 'Inactive 7+ days', value: sum.inactive_7d, warn: sum.inactive_7d > 0 },
      { label: 'Never logged in', value: sum.never_active, warn: sum.never_active > 0 },
      { label: 'Avg. course progress', value: sum.avg_progress_pct + '%' },
      { label: 'Avg. consistency', value: formatHours(sum.avg_consistency_minutes) + '/day' },
    ];
    return '<div class="students-summary">' + cards.map(function (c) {
      return '<div class="students-summary-card' + (c.warn ? ' warn' : '') + '"><div class="students-summary-value">' + c.value + '</div><div class="students-summary-label">' + escapeHtml(c.label) + '</div></div>';
    }).join('') + '</div>';
  }

  function renderStudentFilters() {
    var f = state.studentFilters;
    var inactiveOptions = [
      ['', 'Any'], ['3', '3+ days'], ['7', '7+ days'], ['14', '14+ days'], ['30', '30+ days'], ['never', 'Never active'],
    ].map(function (o) {
      return '<option value="' + o[0] + '"' + (f.inactive === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
    return (
      '<div class="students-filters">' +
        '<input type="text" id="student-search" placeholder="Search name or email…" value="' + escapeHtml(f.search) + '">' +
        '<label>Inactive for <select id="student-inactive-filter">' + inactiveOptions + '</select></label>' +
        '<label>Min streak <input type="number" min="0" id="student-min-streak" placeholder="0" value="' + escapeHtml(f.minStreak) + '" style="width:64px;"></label>' +
        ((f.search || f.inactive || f.minStreak !== '') ? '<button type="button" class="btn btn-small" id="student-filter-clear">Clear filters</button>' : '') +
      '</div>'
    );
  }

  // The Last Active dot (inactivityClass) has never had a legend anywhere
  // on this page — color alone doesn't say what green/amber/red/gray each
  // mean without guessing or reading inactivityClass's own source. Built
  // from the exact same class names/thresholds that color the real dots
  // (not a separately-typed description), so it can't silently drift out
  // of sync if those thresholds ever change.
  function renderInactivityLegend() {
    var items = [
      ['inactivity-fresh', '≤2 days'],
      ['inactivity-warm', '3-6 days'],
      ['inactivity-cold', '7+ days'],
      ['inactivity-never', 'Never active'],
    ];
    return '<div class="inactivity-legend">' + items.map(function (item) {
      return '<span class="inactivity-legend-item"><span class="inactivity-dot ' + item[0] + '"></span>' + item[1] + '</span>';
    }).join('') + '</div>';
  }

  function renderStudents() {
    if (state.studentsLoading) return '<div class="card"><div class="field-hint">Loading students…</div></div>';
    if (state.studentsError) return '<div class="card"><div class="msg msg-error" style="margin:0;">' + escapeHtml(state.studentsError) + '</div></div>';
    if (!state.students || !state.students.length) return '<div class="card"><div class="empty">No students registered yet.</div></div>';

    // The active column's real ▲/▼ direction is unmistakable already, but
    // every OTHER column only ever hinted "this is clickable" via a hover
    // color change — invisible until you happen to mouse over it. A faint,
    // always-visible ↕ on the inactive columns is the same "this sorts"
    // signal a hover gives, just not gated on already knowing to hover.
    var headerHtml = STUDENT_COLUMNS.map(function (col) {
      var active = state.studentSort.key === col.key;
      var arrow = active ? (state.studentSort.dir === 'asc' ? ' ▲' : ' ▼') : ' <span class="sort-hint">↕</span>';
      return '<th class="js-sort" data-key="' + col.key + '">' + escapeHtml(col.label) + arrow + '</th>';
    }).join('') + '<th>Notes</th>';

    var visible = sortedStudents();
    var rowsHtml = visible.map(function (s) {
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
          '<td><span class="inactivity-dot ' + inactivityClass(s.days_inactive) + '"></span>' + lastActiveLabel(s) + '</td>' +
          '<td class="students-notes-cell">' +
            '<textarea class="js-note-input" data-email="' + escapeHtml(s.email) + '" rows="1">' + escapeHtml(s.notes) + '</textarea>' +
            '<button type="button" class="btn btn-small js-note-save" data-email="' + escapeHtml(s.email) + '">' + saveLabel + '</button>' +
          '</td>' +
        '</tr>'
      );
    }).join('');

    var countLabel = visible.length === state.students.length
      ? 'Students (' + state.students.length + ')'
      : 'Students (' + visible.length + ' of ' + state.students.length + ')';

    return (
      '<div class="card">' +
        renderStudentSummary() +
        '<h2 style="font-size:16px;margin-bottom:12px;">' + countLabel + '</h2>' +
        renderStudentFilters() +
        renderInactivityLegend() +
        '<div class="field-hint" style="margin:10px 0;">Sorted by All-time hours by default — click a column to re-sort. Consistency = median daily minutes this month so far (same measure as the monthly Discord post), zero-filled on quiet days, so it rewards showing up regularly over binge days. Course progress = tasks completed out of everything scheduled so far. Try sorting by Consistency for steady-but-not-flashy students, or filtering by Inactive days to see who\'s gone quiet.</div>' +
        (visible.length ? '<div class="students-table-wrap"><table class="students-table"><thead><tr>' + headerHtml + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>'
          : '<div class="empty">No students match the current filters.</div>') +
      '</div>'
    );
  }

  // ── Site data (Pricing / Notes / Lectures) ─────────────────────────
  // Admin-editable storage for data that today lives in a published
  // Google Sheet CSV, read live by gate-da-courses.html/
  // gate-da-test-series.html/index.html (pricing) and
  // gate-da-free-notes.html (notes, lectures) — see CLAUDE.md's "Site
  // data corner" section. The live pages are NOT reading from here yet;
  // this tab only manages the new Supabase-backed copy.

  function loadSiteData(type) {
    var sd = state.siteData;
    sd.loading[type] = true;
    sd.error[type] = null;
    render();
    var endpoint = SITE_DATA_RESOURCES[type].endpoint;
    api(endpoint).then(function (data) {
      sd.rows[type] = data.rows || [];
      sd.loading[type] = false;
      render();
    }).catch(function (err) {
      sd.loading[type] = false;
      sd.error[type] = err.message;
      render();
    });
  }

  function renderSiteDataTabs() {
    return Object.keys(SITE_DATA_RESOURCES).map(function (type) {
      var cfg = SITE_DATA_RESOURCES[type];
      var active = state.siteData.subTab === type;
      var rows = state.siteData.rows[type];
      var countLabel = rows ? ' (' + rows.length + ')' : '';
      return '<button class="tab-btn' + (active ? ' active' : '') + '" data-sitetab="' + type + '">' + cfg.label + countLabel + '</button>';
    }).join('');
  }

  // Mirrors the real threshold gate-da-courses.html's own COMBOS.map()
  // uses (getsOwnRow = c.comingSoon && COMBOS.length > 3) — kept in sync
  // by hand, same "can't share a constant across this boundary" tradeoff
  // already accepted elsewhere in this codebase (e.g. SITE_DATA_SUBJECT_IDS
  // vs notes-data.json). Purely informational here — reordering the cards
  // themselves is handled separately (see the drag-and-drop block below),
  // and IS live now, but the row-count threshold that decides whether the
  // featured card gets its own row is still a fixed number gate-da-
  // courses.html computes itself, not something this order controls.
  var COMBO_OWN_ROW_THRESHOLD = 3;

  function renderSiteDataList(type) {
    var sd = state.siteData;
    if (sd.loading[type]) return '<div class="field-hint">Loading…</div>';
    if (sd.error[type]) return '<div class="msg msg-error">' + escapeHtml(sd.error[type]) + '</div>';
    var rows = sd.rows[type];
    if (!rows || !rows.length) {
      return type === 'pricing'
        ? '<div class="empty">No pricing rows yet — these are added directly (with their matching course card), not through this page.</div>'
        : '<div class="empty">No rows yet. Click "+ New' + (type === 'notes' ? ' note' : ' lecture') + '" above to add one.</div>';
    }
    return type === 'pricing' ? renderPricingGroups(rows) : renderSiteDataTable(type, rows);
  }

  // Edit/Delete — shared by every plain sitedata-table row (Notes,
  // Lectures) and, minus Delete, every pricing card too, so Edit's own
  // markup never drifts between the two layouts.
  //
  // showDelete defaults true for Notes/Lectures, but pricing cards
  // always pass false — removed on direct request, after it became
  // clear Delete here was actively misleading: only a course's ORDER is
  // wired to the live page, not its existence, so deleting a site_pricing
  // row never actually takes a course off taai.live — the card keeps
  // rendering from its own hardcoded entry in gate-da-courses.html
  // regardless, just demoted to the end of its group once it has no
  // display_order left to sort by. An admin clicking Delete expecting
  // to remove a course would get exactly that wrong impression, with
  // no error to catch it. Actually removing a course is still a code
  // change (deleting its COMBOS/INDIVIDUAL entry), not a /team action —
  // see CLAUDE.md's "Site data corner" section.
  function siteDataRowActionsHtml(type, id, showDelete) {
    var deleteHtml = showDelete === false ? '' : ' <button class="btn btn-small btn-danger js-sitedata-delete" data-sitetype="' + type + '" data-id="' + escapeHtml(id) + '">Delete</button>';
    return '<button class="btn btn-small js-sitedata-edit" data-sitetype="' + type + '" data-id="' + escapeHtml(id) + '">Edit</button>' + deleteHtml;
  }

  // One course as a scannable card — name/status up top, the price
  // that's actually the point front and center, then only whichever
  // dates/labels are actually set (no "—" placeholders for a non-
  // technical admin to puzzle over). Built to replace the old flat
  // 9-column table, which needed horizontal scroll and showed mostly
  // dashes for any course without every field filled in.
  //
  // dragGroup/draggable: whole-card mouse drag-and-drop reordering (see
  // bindPricingCardDrag below), replacing the old ▲/▼ buttons on request
  // ("the reordering should be done by dragging with mouse and not
  // buttons") — dragGroup scopes a drag to its own group ('combo' or
  // 'individual', matching renderPricingGroups' own split) so a card
  // can never be dropped into the wrong section; draggable is false for
  // a lone card in a group of 1, where there's nothing to reorder against.
  function pricingCardHtml(row, dragGroup, draggable) {
    // Status is still purely the enroll_url computed value (see
    // SITE_DATA_RESOURCES.pricing's own comment on why there's no
    // separate toggle) — sold_out_date is shown as its own note below,
    // never folded into this badge, since it's an admin-only preview
    // value the live page doesn't act on yet (see schema.sql).
    var statusHtml = row.enroll_url
      ? '<span class="pricing-status pricing-status-live">● Live</span>'
      : '<span class="pricing-status pricing-status-soon">Coming Soon</span>';
    var soldOutHtml = row.sold_out_date
      ? '<div class="pricing-soldout-note">🔒 Sold-out cutover: ' + escapeHtml(row.sold_out_date) + ' <span class="field-hint" style="margin:0;">(preview only)</span></div>'
      : '';
    var priceHtml = row.price != null
      ? '<span class="pricing-card-price-main">₹' + escapeHtml(row.price) + '</span>' + (row.price_old != null ? '<span class="pricing-card-price-old">₹' + escapeHtml(row.price_old) + '</span>' : '')
      : '<span class="pricing-card-price-none">No price set</span>';
    var discountHtml = row.discount ? '<span class="pricing-card-discount">' + escapeHtml(row.discount) + (row.discount_reason ? ' — ' + escapeHtml(row.discount_reason) : '') + '</span>' : '';
    var metaRows = [];
    if (row.validity) metaRows.push('<div><b>Valid until</b> ' + escapeHtml(row.validity) + '</div>');
    if (row.discount_deadline) metaRows.push('<div><b>Discount ends</b> ' + escapeHtml(row.discount_deadline) + '</div>');
    var metaHtml = metaRows.length ? '<div class="pricing-card-meta">' + metaRows.join('') + '</div>' : '';
    var dragAttrs = draggable
      ? ' draggable="true" data-drag-id="' + escapeHtml(row.id) + '" data-drag-group="' + dragGroup + '"'
      : '';
    var dragHandleHtml = draggable ? '<div class="pricing-card-drag-handle" title="Drag to reorder">⠿</div>' : '';
    return (
      '<div class="pricing-card' + (draggable ? ' pricing-card--draggable' : '') + '"' + dragAttrs + '>' +
        dragHandleHtml +
        '<div class="pricing-card-head">' +
          '<div><div class="pricing-card-name">' + escapeHtml(row.name || row.id) + '</div><div class="pricing-card-id">' + escapeHtml(row.id) + '</div></div>' +
          statusHtml +
        '</div>' +
        '<div class="pricing-card-price">' + priceHtml + '</div>' +
        discountHtml +
        metaHtml +
        soldOutHtml +
        '<div class="pricing-card-actions">' + siteDataRowActionsHtml('pricing', row.id, false) + '</div>' +
      '</div>'
    );
  }

  // Three genuinely separate groups — "Bundled courses" (combo),
  // "Individual courses" (individual subjects only), "Test series" — each
  // with its own drag-reorder order space. Test series used to share the
  // "Individual courses" group/order with real subjects; split out on
  // direct correction ("test series is separate") — a test-series plan
  // isn't a subject course, so it shouldn't compete for position against
  // them, or be silently renumbered whenever a subject card moves.
  function renderPricingGroups(rows) {
    var comboRows = rows.filter(function (r) { return r.type === 'combo'; });
    var individualRows = rows.filter(function (r) { return r.type === 'individual'; });
    var testSeriesRows = rows.filter(function (r) { return r.type === 'test-series'; });

    var comboHintHtml = '';
    if (comboRows.length) {
      var ownRow = comboRows.length > COMBO_OWN_ROW_THRESHOLD;
      comboHintHtml = '<div class="pricing-group-hint">' +
        (ownRow
          ? 'On the live page, the featured bundle currently gets its own full-width row above the rest (4+ bundled courses).'
          : 'On the live page, the featured bundle currently sits in the plain grid with the others (3 or fewer bundled courses).') +
        (comboRows.length > 1 ? ' Drag a card by its ⠿ handle to reorder — this order is live on taai.live.' : '') +
        '</div>';
    }
    var individualHintHtml = individualRows.length > 1
      ? '<div class="pricing-group-hint">Drag a card by its ⠿ handle to reorder — this order is live on taai.live.</div>'
      : '';
    var testSeriesHintHtml = testSeriesRows.length > 1
      ? '<div class="pricing-group-hint">Drag a card by its ⠿ handle to reorder — admin-only preview for now, the test series page doesn\'t read this order yet.</div>'
      : '';

    // dragGroup is a plain string key ('combo'/'individual'/'test-series')
    // scoping a drag to its own section (see pricingCardHtml/
    // bindPricingCardDrag) — a card can never be dropped into another
    // group.
    function groupHtml(title, groupRows, hintHtml, dragGroup) {
      if (!groupRows.length) return '';
      var draggable = groupRows.length > 1;
      return (
        '<div class="pricing-group">' +
          '<div class="pricing-group-heading">' + escapeHtml(title) + ' <span class="pricing-group-count">(' + groupRows.length + ')</span></div>' +
          hintHtml +
          '<div class="pricing-cards" data-drag-group="' + dragGroup + '">' + groupRows.map(function (r) { return pricingCardHtml(r, dragGroup, draggable); }).join('') + '</div>' +
        '</div>'
      );
    }

    return (
      groupHtml('Bundled courses', comboRows, comboHintHtml, 'combo') +
      groupHtml('Individual courses', individualRows, individualHintHtml, 'individual') +
      groupHtml('Test series', testSeriesRows, testSeriesHintHtml, 'test-series')
    );
  }

  // Plain click-to-sort-free table — still used for Notes/Lectures,
  // which are short enough (few columns, no grouping/status logic
  // needed) that the card treatment above would be overkill.
  function renderSiteDataTable(type, rows) {
    var cfg = SITE_DATA_RESOURCES[type];
    var headerHtml = cfg.columns.map(function (col) { return '<th>' + escapeHtml(col.label) + '</th>'; }).join('') + '<th></th>';
    var rowsHtml = rows.map(function (r) {
      var cellsHtml = cfg.columns.map(function (col) {
        var val = col.format ? col.format(r) : (r[col.name] == null ? '—' : r[col.name]);
        return '<td>' + escapeHtml(val) + '</td>';
      }).join('');
      var id = r[cfg.idKey];
      return '<tr>' + cellsHtml + '<td style="white-space:nowrap;">' + siteDataRowActionsHtml(type, id) + '</td></tr>';
    }).join('');
    return '<div class="students-table-wrap"><table class="students-table sitedata-table"><thead><tr>' + headerHtml + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
  }

  function siteDataFieldHtml(field, row, isEdit) {
    var value = row[field.name] == null ? '' : row[field.name];
    var disabled = (isEdit && field.lockedOnEdit) ? ' disabled' : '';
    var required = field.required ? ' required' : '';
    var inputHtml;
    if (field.type === 'select') {
      var optionHtml = function (opt) {
        return '<option value="' + escapeHtml(opt.id) + '"' + (opt.id === value ? ' selected' : '') + '>' + escapeHtml(opt.label) + '</option>';
      };
      var options;
      if (field.optionGroups) {
        // Grouped <optgroup>s (e.g. site_pricing's ID field — Bundled
        // courses / Individual courses / Test series) instead of one
        // flat list, so the dropdown itself communicates the same
        // combo-vs-individual split the rest of this page draws. A
        // blank leading placeholder forces an explicit real choice for
        // a brand-new row (newRow's own id starts '') rather than
        // silently defaulting to the first real option.
        options = (!isEdit ? '<option value="" disabled' + (value ? '' : ' selected') + '>Choose a course…</option>' : '') +
          field.optionGroups.map(function (g) {
            return '<optgroup label="' + escapeHtml(g.label) + '">' + g.options.map(optionHtml).join('') + '</optgroup>';
          }).join('');
      } else {
        options = field.options.map(optionHtml).join('');
      }
      inputHtml = '<select name="' + field.name + '"' + disabled + required + '>' + options + '</select>';
    } else if (field.type === 'number') {
      inputHtml = '<input type="number" name="' + field.name + '" value="' + escapeHtml(value) + '"' + disabled + required + '>';
    } else if (field.type === 'date') {
      inputHtml = '<input type="date" name="' + field.name + '" value="' + escapeHtml(value) + '"' + disabled + required + '>';
    } else if (field.type === 'url') {
      inputHtml = '<input type="url" name="' + field.name + '" value="' + escapeHtml(value) + '"' + disabled + required + '>';
    } else {
      inputHtml = '<input type="text" name="' + field.name + '" value="' + escapeHtml(value) + '"' + disabled + required + '>';
    }
    // A locked field's disabled input never submits via FormData — a
    // hidden mirror keeps its real value flowing through to the payload
    // (see readSiteDataPayload) without the input itself being editable.
    var lockedMirror = (isEdit && field.lockedOnEdit) ? '<input type="hidden" name="' + field.name + '" value="' + escapeHtml(value) + '">' : '';
    return '<div class="field"><label>' + escapeHtml(field.label) + '</label>' + inputHtml + lockedMirror + (field.hint ? '<div class="field-hint">' + escapeHtml(field.hint) + '</div>' : '') + '</div>';
  }

  function renderSiteDataForm(type, row) {
    var cfg = SITE_DATA_RESOURCES[type];
    var isEdit = !!row[cfg.idKey];
    // showIf (optional per field) — e.g. sold_out_date only makes sense
    // on the full-course pricing row; every other row just skips
    // rendering the input entirely rather than showing an always-blank,
    // meaningless field.
    var applicableFields = cfg.fields.filter(function (f) { return !f.showIf || f.showIf(row); });
    // Optional per-field `section` (only pricing uses this so far) groups
    // the form the same way the Announcements form already groups
    // Destination/Content/etc — .form-section/.form-section-heading, see
    // team/index.html. A resource with no sectioned fields (Notes,
    // Lectures — short enough already) falls back to one flat list,
    // unchanged from before.
    var fieldsHtml;
    if (applicableFields.some(function (f) { return f.section; })) {
      var order = [];
      var bySection = {};
      applicableFields.forEach(function (f) {
        var sec = f.section || 'Details';
        if (!bySection[sec]) { bySection[sec] = []; order.push(sec); }
        bySection[sec].push(f);
      });
      fieldsHtml = order.map(function (sec) {
        return '<div class="form-section"><div class="form-section-heading">' + escapeHtml(sec) + '</div>' +
          bySection[sec].map(function (f) { return siteDataFieldHtml(f, row, isEdit); }).join('') +
        '</div>';
      }).join('');
    } else {
      fieldsHtml = applicableFields.map(function (f) { return siteDataFieldHtml(f, row, isEdit); }).join('');
    }
    return (
      '<div class="card form-card">' +
        '<h2 style="font-size:16px;margin-bottom:14px;">' + (isEdit ? 'Edit ' : 'New ') + SITE_DATA_SINGULAR[type] + '</h2>' +
        '<form id="sitedata-form">' +
          fieldsHtml +
          '<div class="form-actions">' +
            '<button type="button" class="btn" id="sitedata-cancel">Cancel</button>' +
            '<button type="submit" class="btn btn-primary"' + (state.siteData.saving ? ' disabled' : '') + '>' + (state.siteData.saving ? 'Saving…' : (isEdit ? 'Save' : 'Create')) + '</button>' +
          '</div>' +
        '</form>' +
      '</div>'
    );
  }

  // Plain-language intro per sub-tab, shown instead of a generic
  // "Admin-editable copy of the X data" line — written for someone who's
  // never seen a database table, explaining in one sentence what this
  // list is and what it doesn't do yet (still preview-only, not live).
  var SITE_DATA_INTRO = {
    pricing: 'Every course, bundle, and test series shown on the site — its price, discount, and enrolment link. Grouped below into Bundled courses and Individual courses.',
    notes: 'Downloadable PDF notes, organized by subject.',
    lectures: 'Video lectures and their slides, organized by subject.',
  };
  var SITE_DATA_NEW_LABEL = { pricing: '+ New course', notes: '+ New note', lectures: '+ New lecture' };
  var SITE_DATA_SINGULAR = { pricing: 'course', notes: 'note', lectures: 'lecture' };

  function renderSiteData() {
    var sd = state.siteData;
    var type = sd.subTab;
    var editingThis = sd.editing && sd.editing.type === type ? sd.editing.row : null;
    // No "+ New course" for Pricing — removed on direct request ("we
    // will add them from here to both courses page and team page"): a
    // genuinely new course always needs its own hardcoded card added to
    // gate-da-courses.html/gate-da-test-series.html first (see the ID
    // dropdown's own comment — SITE_PRICING_ID_GROUPS only ever lists
    // ids that already have a real card to attach to), so creating one
    // is a deliberate two-step, code-first action, not a one-click /team
    // form. Notes/Lectures have no such constraint and keep their own
    // "+ New" button.
    var showNewButton = type !== 'pricing';

    return (
      '<div class="card">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:10px;">' +
          '<div class="tabs" style="margin:0;">' + renderSiteDataTabs() + '</div>' +
          (editingThis || !showNewButton ? '' : '<button class="btn btn-primary" id="sitedata-new">' + SITE_DATA_NEW_LABEL[type] + '</button>') +
        '</div>' +
        '<div class="field-hint" style="margin-bottom:16px;">' + SITE_DATA_INTRO[type] + ' Changes here are a preview only for now — the live site still reads its own published spreadsheet, so nothing you edit here shows up on taai.live yet.</div>' +
        (editingThis ? renderSiteDataForm(type, editingThis) : renderSiteDataList(type)) +
      '</div>'
    );
  }

  function readSiteDataPayload(type, form) {
    var cfg = SITE_DATA_RESOURCES[type];
    var fd = new FormData(form);
    var payload = {};
    cfg.fields.forEach(function (f) {
      var raw = (fd.get(f.name) || '').toString().trim();
      payload[f.name] = raw === '' ? null : raw;
    });
    return payload;
  }

  // Pricing drag-and-drop reorder — see the "bindPricingCardDrag()" call
  // site in bindEvents() for why this replaced the old ▲/▼ buttons.
  // Module-level (not nested in bindEvents) since bindEvents() re-runs
  // and rebinds fresh listeners on every render anyway — no state needs
  // to survive a render here, `pricingDrag` only lives for the duration
  // of one physical drag gesture.
  //
  // Rebuilt (2026-09-23) after a real report that the first version —
  // which physically moved the dragged card in the DOM on every
  // dragover, Trello-style — felt "finnicky" and sometimes dropped a
  // card with nothing changing at all. Root cause: moving the node live
  // reflows the grid under the cursor mid-drag, which can shift the
  // very geometry the next dragover's before/after check depends on,
  // and in the worst case can make the browser lose track of a valid
  // drop target entirely (silently rejecting the drop — no error, no
  // visible change, exactly the reported symptom). Fixed by never
  // touching the DOM during the drag itself: dragover only tracks
  // where the drop WOULD land (`pricingDrag.overId`/`overBefore`) and
  // paints a lightweight border highlight on the hovered card, over a
  // grid whose geometry never moves underneath the cursor. The actual
  // reorder is computed once, on drop, from the still-untouched
  // original DOM order plus that tracked target.
  var pricingDrag = { id: null, group: null, overId: null, overBefore: null };

  function clearPricingDropIndicator() {
    document.querySelectorAll('.pricing-card--drop-before, .pricing-card--drop-after').forEach(function (el) {
      el.classList.remove('pricing-card--drop-before', 'pricing-card--drop-after');
    });
  }

  function bindPricingCardDrag() {
    document.querySelectorAll('.pricing-card[draggable="true"]').forEach(function (card) {
      card.addEventListener('dragstart', function (e) {
        pricingDrag.id = card.getAttribute('data-drag-id');
        pricingDrag.group = card.getAttribute('data-drag-group');
        pricingDrag.overId = null;
        pricingDrag.overBefore = null;
        card.classList.add('pricing-card--dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          // Firefox refuses to start a real drag without setData called.
          try { e.dataTransfer.setData('text/plain', pricingDrag.id); } catch (err) { /* ignore */ }
        }
      });
      card.addEventListener('dragend', function () {
        card.classList.remove('pricing-card--dragging');
        clearPricingDropIndicator();
        pricingDrag.id = null;
        pricingDrag.group = null;
      });
      card.addEventListener('dragover', function (e) {
        if (!pricingDrag.id || card.getAttribute('data-drag-group') !== pricingDrag.group) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        if (card.getAttribute('data-drag-id') === pricingDrag.id) return;
        var targetId = card.getAttribute('data-drag-id');
        var rect = card.getBoundingClientRect();
        var before = (e.clientY - rect.top) < rect.height / 2;
        if (pricingDrag.overId === targetId && pricingDrag.overBefore === before) return; // unchanged — skip the class churn
        clearPricingDropIndicator();
        card.classList.add(before ? 'pricing-card--drop-before' : 'pricing-card--drop-after');
        pricingDrag.overId = targetId;
        pricingDrag.overBefore = before;
      });
      card.addEventListener('drop', function (e) {
        e.preventDefault();
        applyPricingDrop();
      });
    });

    // Hovering the group's own empty grid space (not directly over
    // another card — the trailing gap past the last card, or gutters
    // between cards) means "drop at the end" — overId stays null, which
    // applyPricingDrop() below treats as append. Checked via e.target
    // (not e.currentTarget) specifically so a dragover that bubbled up
    // from a child card — already handled by that card's own listener
    // above — doesn't get double-processed here.
    document.querySelectorAll('.pricing-cards[data-drag-group]').forEach(function (container) {
      container.addEventListener('dragover', function (e) {
        if (!pricingDrag.id || e.target !== container || container.getAttribute('data-drag-group') !== pricingDrag.group) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        if (pricingDrag.overId !== null) { clearPricingDropIndicator(); pricingDrag.overId = null; pricingDrag.overBefore = null; }
      });
      container.addEventListener('drop', function (e) {
        if (!pricingDrag.id || e.target !== container || container.getAttribute('data-drag-group') !== pricingDrag.group) return;
        e.preventDefault();
        applyPricingDrop();
      });
    });
  }

  // Computes the final order from the ORIGINAL, never-mutated-during-
  // drag DOM order plus wherever pricingDrag ended up tracking as the
  // drop target, then persists it. `overId === null` means "no specific
  // card was hovered" (dropped on the empty grid area, or never moved
  // off the card it started on) — append to the end.
  function applyPricingDrop() {
    var group = pricingDrag.group;
    var draggedId = pricingDrag.id;
    var overId = pricingDrag.overId;
    var overBefore = pricingDrag.overBefore;
    clearPricingDropIndicator();
    if (!group || !draggedId) return;
    var container = document.querySelector('.pricing-cards[data-drag-group="' + group + '"]');
    if (!container) return;
    var ids = Array.prototype.map.call(container.querySelectorAll('.pricing-card[data-drag-id]'), function (el) {
      return el.getAttribute('data-drag-id');
    });
    var fromIndex = ids.indexOf(draggedId);
    if (fromIndex === -1) return;
    ids.splice(fromIndex, 1);
    if (overId === null) {
      ids.push(draggedId);
    } else {
      var targetIndex = ids.indexOf(overId);
      if (targetIndex === -1) ids.push(draggedId);
      else ids.splice(overBefore ? targetIndex : targetIndex + 1, 0, draggedId);
    }
    commitPricingOrder(group, ids);
  }

  // Only rows whose display_order actually changed get written, so a
  // drop that lands back where it started (or never moved off its own
  // starting card) costs zero requests.
  function commitPricingOrder(group, ids) {
    var rows = state.siteData.rows.pricing || [];
    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });
    var writes = [];
    ids.forEach(function (id, i) {
      var row = byId[id];
      if (row && (row.display_order || 0) !== i) {
        writes.push(api('/site-pricing', { method: 'PUT', body: JSON.stringify(Object.assign({}, row, { display_order: i })) }));
      }
    });
    if (!writes.length) return;
    Promise.all(writes)
      .then(function () { return loadSiteData('pricing'); })
      .catch(function (err) { state.msg = err.message; state.msgType = 'error'; render(); });
  }

  function loadStudents() {
    state.studentsLoading = true;
    state.studentsError = null;
    render();
    api('/team-students').then(function (data) {
      state.students = data.students || [];
      state.studentSummary = data.summary || null;
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

    var studentsRefreshBtn = document.getElementById('students-refresh');
    if (studentsRefreshBtn) studentsRefreshBtn.addEventListener('click', function () { loadStudents(); });

    var builtinToggle = document.getElementById('builtin-toggle');
    if (builtinToggle) builtinToggle.addEventListener('click', function () {
      state.showBuiltIn = !state.showBuiltIn;
      render();
    });

    document.querySelectorAll('.js-rename-start').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.renamingWebhook = btn.getAttribute('data-webhook');
        state.renameStatus = null;
        render();
        var input = document.getElementById('rename-input');
        if (input) { input.focus(); input.select(); }
      });
    });

    var renameCancelBtn = document.querySelector('.js-rename-cancel');
    if (renameCancelBtn) renameCancelBtn.addEventListener('click', function () {
      state.renamingWebhook = null;
      render();
    });

    document.querySelectorAll('.js-rename-save').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var webhookUrl = btn.getAttribute('data-webhook');
        var input = document.getElementById('rename-input');
        var newLabel = input ? input.value.trim() : '';
        var matching = state.posts.filter(function (p) { return channelKey(p) === webhookUrl; });
        state.renameStatus = { webhookUrl: webhookUrl, saving: true, count: matching.length };
        render();
        Promise.all(matching.map(function (post) {
          var payload = Object.assign({}, post, { channel_name: newLabel || null });
          return api('/team-posts', { method: 'PUT', body: JSON.stringify(payload) });
        })).then(function () {
          state.renamingWebhook = null;
          state.renameStatus = null;
          state.msg = 'Renamed to "' + newLabel + '" across ' + matching.length + ' post(s).';
          state.msgType = 'ok';
          return loadPosts();
        }).catch(function (err) {
          state.renameStatus = { webhookUrl: webhookUrl, error: err.message };
          render();
        });
      });
    });

    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      var tab = btn.getAttribute('data-tab');
      // The Site data sub-tab buttons (Pricing/Notes/Lectures) reuse this
      // same .tab-btn class for identical styling but carry data-sitetab
      // instead — skip those here, they get their own handler below.
      if (!tab) return;
      btn.addEventListener('click', function () {
        if (tab === state.tab) return;
        state.tab = tab;
        if (tab === 'students' && state.students === null) { loadStudents(); return; }
        if (tab === 'site-data' && state.siteData.rows[state.siteData.subTab] === null) { loadSiteData(state.siteData.subTab); return; }
        render();
      });
    });

    document.querySelectorAll('[data-sitetab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var type = btn.getAttribute('data-sitetab');
        if (type === state.siteData.subTab) return;
        state.siteData.subTab = type;
        state.siteData.editing = null;
        if (state.siteData.rows[type] === null) { loadSiteData(type); return; }
        render();
      });
    });

    var sitedataNewBtn = document.getElementById('sitedata-new');
    if (sitedataNewBtn) sitedataNewBtn.addEventListener('click', function () {
      var type = state.siteData.subTab;
      state.siteData.editing = { type: type, row: Object.assign({}, SITE_DATA_RESOURCES[type].newRow) };
      render();
    });

    var sitedataCancelBtn = document.getElementById('sitedata-cancel');
    if (sitedataCancelBtn) sitedataCancelBtn.addEventListener('click', function () {
      state.siteData.editing = null;
      render();
    });

    document.querySelectorAll('.js-sitedata-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var type = btn.getAttribute('data-sitetype');
        var id = btn.getAttribute('data-id');
        var idKey = SITE_DATA_RESOURCES[type].idKey;
        var row = (state.siteData.rows[type] || []).filter(function (r) { return String(r[idKey]) === id; })[0];
        if (!row) return;
        state.siteData.editing = { type: type, row: row };
        render();
      });
    });

    document.querySelectorAll('.js-sitedata-delete').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var type = btn.getAttribute('data-sitetype');
        var id = btn.getAttribute('data-id');
        var cfg = SITE_DATA_RESOURCES[type];
        if (!confirm('Delete this ' + SITE_DATA_SINGULAR[type] + '? This can\'t be undone.')) return;
        api(cfg.endpoint + '?id=' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
          return loadSiteData(type);
        }).catch(function (err) {
          state.msg = err.message;
          state.msgType = 'error';
          render();
        });
      });
    });

    // Whole-card mouse drag-and-drop reordering, replacing the old ▲/▼
    // buttons on direct request ("the reordering should be done by
    // dragging with mouse and not buttons"). Native HTML5 drag events,
    // no library — dragover on a sibling card physically moves the
    // dragged element in the DOM (plain insertBefore/insertAfter, no
    // re-render mid-drag, so the drag itself stays perfectly smooth);
    // the actual write only happens once, on drop, by reading back
    // whatever order the DOM ended up in and assigning fresh sequential
    // display_order values (0, 1, 2, ...) to that group's rows. Scoped
    // per data-drag-group ('combo'/'individual', see renderPricingGroups)
    // so a card can only ever be reordered within its own section, never
    // dragged across into the other one.
    bindPricingCardDrag();

    var sitedataForm = document.getElementById('sitedata-form');
    if (sitedataForm) sitedataForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var type = state.siteData.editing.type;
      var cfg = SITE_DATA_RESOURCES[type];
      var isEdit = !!state.siteData.editing.row[cfg.idKey];
      var payload = readSiteDataPayload(type, sitedataForm);
      if (isEdit) payload[cfg.idKey] = state.siteData.editing.row[cfg.idKey];
      // display_order has no form input of its own (only dragging a
      // card in the list ever sets it, see bindPricingCardDrag) — an
      // edit carries the existing value through unchanged, same "don't
      // let an unrelated field edit silently reset it" discipline
      // dispatch_order already needs for scheduled_posts. A brand NEW
      // row appends to the END of its own type's group (combo/
      // individual/test-series each their own order space — exact type
      // match, matching renderPricingGroups' three-way split) rather
      // than defaulting to 0, which would otherwise silently jump every
      // new course to the front.
      if (type === 'pricing') {
        if (isEdit) {
          payload.display_order = state.siteData.editing.row.display_order || 0;
        } else {
          var siblings = (state.siteData.rows.pricing || []).filter(function (r) { return r.type === payload.type; });
          var maxOrder = siblings.reduce(function (m, r) { return Math.max(m, r.display_order || 0); }, -1);
          payload.display_order = maxOrder + 1;
        }
      }
      state.siteData.saving = true;
      render();
      api(cfg.endpoint, { method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(payload) })
        .then(function () {
          state.siteData.saving = false;
          state.siteData.editing = null;
          state.msg = isEdit ? 'Saved.' : 'Created.';
          state.msgType = 'ok';
          return loadSiteData(type);
        })
        .catch(function (err) {
          state.siteData.saving = false;
          state.msg = err.message;
          state.msgType = 'error';
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

    // render() replaces #root's whole innerHTML (see above), which would
    // normally drop focus/cursor position out from under someone mid-
    // keystroke in the search box — re-focus + restore the cursor after
    // each re-render specifically for the two free-typing filter inputs
    // (search, min streak); the <select> doesn't need this, a dropdown
    // has no mid-interaction cursor state to lose.
    function refocusFilterInput(id, cursorPos) {
      var el = document.getElementById(id);
      if (el) { el.focus(); if (typeof cursorPos === 'number') el.setSelectionRange(cursorPos, cursorPos); }
    }
    var searchInput = document.getElementById('student-search');
    if (searchInput) searchInput.addEventListener('input', function () {
      var pos = searchInput.selectionStart;
      state.studentFilters.search = searchInput.value;
      render();
      refocusFilterInput('student-search', pos);
    });
    var inactiveFilter = document.getElementById('student-inactive-filter');
    if (inactiveFilter) inactiveFilter.addEventListener('change', function () {
      state.studentFilters.inactive = inactiveFilter.value;
      render();
    });
    var minStreakInput = document.getElementById('student-min-streak');
    if (minStreakInput) minStreakInput.addEventListener('input', function () {
      var pos = minStreakInput.selectionStart;
      state.studentFilters.minStreak = minStreakInput.value;
      render();
      refocusFilterInput('student-min-streak', pos);
    });
    var filterClearBtn = document.getElementById('student-filter-clear');
    if (filterClearBtn) filterClearBtn.addEventListener('click', function () {
      state.studentFilters = { search: '', inactive: '', minStreak: '' };
      render();
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

    function startNewPost(overrides) {
      state.editing = Object.assign({ schedule_type: 'daily', schedule_time: '10:00', enabled: true }, overrides);
      state.preview = null;
      state.testStatus = null;
      state.msg = null;
      render();
    }
    var newBtn = document.getElementById('new-btn');
    if (newBtn) newBtn.addEventListener('click', function () { startNewPost(); });
    var newCustomBtn = document.getElementById('new-custom-btn');
    if (newCustomBtn) newCustomBtn.addEventListener('click', function () {
      // Explicit source + one blank section pre-added (rather than
      // leaving the writer to also click "+ Add section" first) — this
      // button's whole purpose is "start a schedule," so get them
      // straight to a fillable Date/Topic/Duration row.
      startNewPost({ source: 'custom', sections: [{ title: '', rows: [{ date: '', task: '', time: '' }] }] });
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

    // Swaps this post's dispatch_order with whichever neighbor it's
    // moving past, within its own channel group (same sort discord-
    // dispatch.js itself uses) — a straight swap rather than a full
    // renumber, so moving one post never disturbs any other pair's
    // relative order.
    function movePost(id, direction) {
      var post = state.posts.filter(function (p) { return p.id === id; })[0];
      if (!post) return;
      var groupRows = sortByDispatchOrder(state.posts.filter(function (p) { return channelKey(p) === channelKey(post); }));
      var index = groupRows.findIndex(function (p) { return p.id === id; });
      var neighborIndex = index + direction;
      if (neighborIndex < 0 || neighborIndex >= groupRows.length) return;
      var neighbor = groupRows[neighborIndex];
      var postOrder = post.dispatch_order || 0;
      var neighborOrder = neighbor.dispatch_order || 0;
      // Identical dispatch_order (the common default-0 case) swapping to
      // the same value would be a no-op — nudge apart by 1 in the
      // intended direction instead of a plain swap, so the move always
      // actually takes effect on the very first click.
      var newPostOrder = postOrder === neighborOrder ? postOrder + direction : neighborOrder;
      var newNeighborOrder = postOrder === neighborOrder ? neighborOrder : postOrder;
      Promise.all([
        api('/team-posts', { method: 'PUT', body: JSON.stringify(Object.assign({}, post, { dispatch_order: newPostOrder })) }),
        api('/team-posts', { method: 'PUT', body: JSON.stringify(Object.assign({}, neighbor, { dispatch_order: newNeighborOrder })) }),
      ])
        .then(function () { return loadPosts(); })
        .catch(function (err) { state.msg = err.message; state.msgType = 'error'; render(); });
    }
    document.querySelectorAll('.js-move-up').forEach(function (btn) {
      btn.addEventListener('click', function () { movePost(btn.getAttribute('data-id'), -1); });
    });
    document.querySelectorAll('.js-move-down').forEach(function (btn) {
      btn.addEventListener('click', function () { movePost(btn.getAttribute('data-id'), 1); });
    });

    var sourceSelect = document.getElementById('f-source');
    if (sourceSelect) sourceSelect.addEventListener('change', function () {
      // Real bug, caught from testing, not assumed away: renderForm()
      // prefills Title/Body with the OLD source's default text as a real
      // `value` (see DEFAULT_TITLE_BY_SOURCE/DEFAULT_BODY_BY_SOURCE) — if
      // that's left untouched and syncEditingFromForm() runs as-is right
      // before the source actually changes, it captures that prefilled
      // default as if it were genuinely typed content, and it then keeps
      // carrying over through every subsequent source switch (confirmed:
      // switching daily_leaderboard → weekly_leaderboard → custom left
      // "Yesterday's Top 3" stuck in Title the whole way, and eventually
      // the OTHER source's stale Body default too). Clearing any field
      // that still exactly matches its OWN source's untouched default —
      // right before syncing, using the source this change is leaving —
      // means sync only ever captures genuinely user-edited text, so the
      // new source's own default correctly takes over instead.
      var oldSource = state.editing.source || 'custom';
      var titleInput = document.querySelector('#post-form [name="title"]');
      if (titleInput && titleInput.value === (DEFAULT_TITLE_BY_SOURCE[oldSource] || ' ')) titleInput.value = '';
      var bodyTextarea = document.getElementById('f-body');
      if (bodyTextarea && bodyTextarea.value === (DEFAULT_BODY_BY_SOURCE[oldSource] || ' ')) bodyTextarea.value = '';
      syncEditingFromForm();
      state.editing.source = sourceSelect.value;
      state.preview = null;
      state.testStatus = null;
      render();
      document.getElementById('f-source').focus();
    });

    // Splices the token in at wherever the cursor/selection currently is
    // (replacing a selection rather than just appending after it) instead
    // of always appending to the end — the whole point is behaving like a
    // normal "insert at cursor" action, not a fixed append. Doesn't use
    // document.execCommand('insertText', ...) (deprecated, inconsistent
    // undo-stack behavior across browsers) — a plain value splice plus a
    // real 'input' event dispatch (so anything that might listen for
    // changes, now or later, still sees one) is simpler and reliable.
    document.querySelectorAll('.js-insert-placeholder').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var textarea = document.getElementById('f-body');
        if (!textarea) return;
        var token = btn.getAttribute('data-token');
        var start = textarea.selectionStart;
        var end = textarea.selectionEnd;
        var before = textarea.value.slice(0, start);
        var after = textarea.value.slice(end);
        textarea.value = before + token + after;
        var cursor = start + token.length;
        textarea.focus();
        textarea.setSelectionRange(cursor, cursor);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });

    var addSectionBtn = document.getElementById('f-add-section');
    if (addSectionBtn) addSectionBtn.addEventListener('click', function () {
      syncEditingFromForm();
      state.editing.sections.push({ title: '', rows: [{ date: '', task: '', time: '' }] });
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

    var platformSelect = document.getElementById('f-platform');
    if (platformSelect) platformSelect.addEventListener('change', function () {
      syncEditingFromForm();
      state.editing.platform = platformSelect.value;
      state.preview = null;
      render();
      document.getElementById('f-platform').focus();
    });

    var channelSelect = document.getElementById('f-channel-select');
    if (channelSelect) channelSelect.addEventListener('change', function () {
      if (channelSelect.value === '') return; // "Enter a new webhook below" — leave fields as they are
      var known = getKnownChannels()[Number(channelSelect.value)];
      if (!known) return;
      var currentPlatform = (document.querySelector('#post-form [name="platform"]') || {}).value || 'discord';
      if (known.platform !== currentPlatform) {
        // Switching platform changes which fields even exist in the DOM
        // (Telegram's Chat ID field isn't rendered at all under Discord),
        // so this one case needs a real re-render — sync first (same as
        // the schedule-type/platform handlers above) so Title/Body/
        // whatever else was already typed survives it.
        syncEditingFromForm();
        state.editing.platform = known.platform;
        state.editing.webhook_url = known.webhook_url;
        state.editing.channel_name = known.channel_name || state.editing.channel_name;
        state.editing.telegram_chat_id = known.telegram_chat_id || '';
        state.preview = null;
        render();
        return;
      }
      // Same platform as already selected — patch the inputs directly
      // rather than going through state.editing + render(), since a full
      // re-render rebuilds the form from state.editing alone, which
      // doesn't have anything typed into Title/Body yet (those only sync
      // back on submit) — re-rendering here would silently wipe out
      // whatever else was already filled in.
      var webhookInput = document.querySelector('#post-form [name="webhook_url"]');
      var channelNameInput = document.querySelector('#post-form [name="channel_name"]');
      var chatIdInput = document.querySelector('#post-form [name="telegram_chat_id"]');
      if (webhookInput) webhookInput.value = known.webhook_url;
      if (channelNameInput && known.channel_name) channelNameInput.value = known.channel_name;
      if (chatIdInput && known.telegram_chat_id) chatIdInput.value = known.telegram_chat_id;
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
      if (payload.platform === 'telegram') {
        if (!payload.test_webhook_url && !payload.webhook_url) {
          state.testStatus = { error: 'Fill in "Telegram Bot API URL" (or a separate "Test bot API URL") above first.' };
          render();
          return;
        }
        if (!payload.telegram_test_chat_id) {
          state.testStatus = { error: 'Fill in "Test Chat ID" above first.' };
          render();
          return;
        }
      } else if (!payload.test_webhook_url) {
        state.testStatus = { error: 'Fill in "Test webhook URL" above first.' };
        render();
        return;
      }
      if (!confirm('This will actually post a real message right now. Continue?')) return;
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
  // rows (real date values + task + time) are the only thing persisted —
  // resolveScheduledPostEmbed() does the date-grouping/formatting from
  // this raw data server-side, so there's no derived markdown text to
  // keep in sync here.
  function readSectionsFromDom(scope) {
    return Array.prototype.map.call((scope || document).querySelectorAll('.section-row'), function (row) {
      var dayRows = Array.prototype.map.call(row.querySelectorAll('.day-row'), function (dr) {
        return {
          date: dr.querySelector('.js-day-date').value,
          task: dr.querySelector('.js-day-task').value,
          time: dr.querySelector('.js-day-time').value,
        };
      });
      return {
        title: row.querySelector('.js-section-title').value,
        rows: dayRows,
      };
    });
  }

  // dispatch_order has no form input of its own — it's only ever set via
  // the ▲/▼ buttons on the post list (see movePost), never typed. Read
  // straight from state.editing (unaffected by whatever's on the form)
  // rather than defaulting to 0 here, or saving any OTHER field through
  // the normal form/Save button would silently reset a post's custom
  // order back to 0 — a real bug caught before shipping the up/down
  // buttons, not a hypothetical one: this function is what both the
  // final Submit and every mid-edit syncEditingFromForm() call route
  // through, and neither has any other way to know the post's order.
  function readFormPayload(form) {
    var fd = new FormData(form);
    return {
      source: fd.get('source'),
      dispatch_order: state.editing.dispatch_order || 0,
      platform: fd.get('platform') === 'telegram' ? 'telegram' : 'discord',
      channel_name: (fd.get('channel_name') || '').trim(),
      webhook_url: (fd.get('webhook_url') || '').trim(),
      test_webhook_url: (fd.get('test_webhook_url') || '').trim(),
      telegram_chat_id: (fd.get('telegram_chat_id') || '').trim(),
      telegram_test_chat_id: (fd.get('telegram_test_chat_id') || '').trim(),
      title: (fd.get('title') || '').trim(),
      body: (fd.get('body') || '').trim(),
      color: parseInt((fd.get('color') || '#8b5cf6').replace('#', ''), 16),
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
    if (DEV_BYPASS) {
      state.authorized = true;
      render();
      loadPosts();
      return;
    }
    if (!window.netlifyIdentity) {
      document.getElementById('root').innerHTML = '<div class="wrap"><div id="gate"><p>Netlify Identity failed to load.</p></div></div>';
      return;
    }
    function applyIdentityUser(user) {
      var roles = (user && user.app_metadata && user.app_metadata.roles) || [];
      state.authorized = roles.indexOf('admin') !== -1;
      render();
      if (state.authorized) loadPosts();
    }

    // A real, reported bug: signing in with a genuinely-authorized admin
    // account still briefly showed "not authorized for /team" (sometimes
    // with a blank email too), self-correcting only on a manual page
    // refresh. The user object netlifyIdentity's own 'init'/'login'
    // events hand over — especially right after the Google OAuth
    // redirect completes, or right after a role was just granted in the
    // Netlify dashboard — can be a stale or not-yet-fully-resolved
    // snapshot (missing app_metadata.roles it should have). Applying
    // that snapshot immediately (below) is still correct for the common
    // case, but user.jwt(true) then forces a real token refresh against
    // the server, re-resolving app_metadata from the actual source of
    // truth — re-applying whatever THAT returns silently corrects a
    // stale first snapshot instead of leaving the person stuck looking
    // unauthorized until they think to reload themselves.
    function applyIdentityUserAndRefresh(user) {
      applyIdentityUser(user);
      if (user && typeof user.jwt === 'function') {
        user.jwt(true).then(function () {
          applyIdentityUser(window.netlifyIdentity.currentUser());
        }).catch(function () { /* keep whatever the initial snapshot already said */ });
      }
    }

    window.netlifyIdentity.on('init', applyIdentityUserAndRefresh);
    window.netlifyIdentity.on('login', applyIdentityUserAndRefresh);
    window.netlifyIdentity.on('logout', function () {
      state.authorized = false;
      state.posts = [];
      render();
    });
    window.netlifyIdentity.init();
  }

  init();
})();
