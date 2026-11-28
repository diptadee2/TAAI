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
    daily_leader: 'Daily: Top Focus Student',
    daily_leaderboard: 'Daily: Top 3',
    weekly_leaderboard: 'Weekly: Top 5 Leaderboard',
    weekly_batch_trend: 'Weekly: Batch Median Trend',
    monthly_consistency: 'Monthly: Most Consistent Student',
    schedule_runout: 'Daily: Schedule running out (team reminder)',
    weekly_schedule_post: 'Weekly: Post the schedule pictures (team reminder)',
    piracy_status: 'Weekly: Piracy takedown status (team)',
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
  // The resources page splits Machine Learning into two groups (2026-10-15):
  // relabel the GATE one and add the from-scratch course right after it.
  (function () {
    var i = -1;
    SITE_SUBJECT_OPTIONS.forEach(function (o, k) { if (o.id === 'machine-learning') i = k; });
    if (i < 0) return;
    SITE_SUBJECT_OPTIONS[i] = { id: 'machine-learning', label: 'Machine Learning for GATE DA' };
    SITE_SUBJECT_OPTIONS.splice(i + 1, 0, { id: 'machine-learning-scratch', label: 'Complete Machine Learning from scratch' });
  })();

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
      { id: 'full-course-2028', label: 'Full Course: 2028 (full-course-2028)' },
      { id: 'full-course', label: 'Full Course: 2027 (full-course)' },
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
      { id: 'artificial-intelligence', label: 'Artificial Intelligence, no Logic (artificial-intelligence)' },
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
      // No `columns` array — Pricing renders as cards (renderPricingGroups/
      // pricingCardHtml), not the generic table renderSiteDataTable uses
      // for Notes/Lectures, so there's nothing here to define columns for.
      // Grouped into labeled sections (renderSiteDataForm) — same
      // .form-section/.form-section-heading pattern the Announcements
      // form already uses for Destination/Content/etc — so a
      // non-technical admin sees "Basic info / Pricing / Enrollment &
      // dates" instead of one long undifferentiated list of 10 fields.
      fields: [
        { name: 'id', label: 'Course', type: 'select', optionGroups: SITE_PRICING_ID_GROUPS, required: true, lockedOnEdit: true, hint: 'Which course/bundle on the live site this row is for: can\'t be changed once created.', section: 'Basic info' },
        { name: 'type', label: 'Type', type: 'select', options: [{ id: 'combo', label: 'Combo/bundle' }, { id: 'individual', label: 'Individual course' }, { id: 'test-series', label: 'Test series' }], required: true, hint: 'Combo/bundle courses show up under "Bundled courses" below; individual subjects under "Individual courses"; test series under "Test series". Drag a card to reorder within its own group.', section: 'Basic info' },
        { name: 'name', label: 'Display name', type: 'text', required: true, section: 'Basic info' },
        { name: 'price', label: 'Price (₹)', type: 'number', section: 'Pricing' },
        { name: 'price_old', label: 'Old price (₹, optional: shown struck through)', type: 'number', section: 'Pricing' },
        { name: 'discount', label: 'Discount label (optional, e.g. "30% OFF")', type: 'text', section: 'Pricing' },
        { name: 'discount_reason', label: 'Discount reason (optional)', type: 'text', section: 'Pricing' },
        { name: 'discount_deadline', label: 'Discount deadline', type: 'date', section: 'Enrollment & dates' },
        { name: 'validity', label: 'Validity', type: 'date', section: 'Enrollment & dates' },
        // LIVE since 2026-09-23 (see CLAUDE.md's "Site data corner"
        // section) — sets the real "Enrol now" button's destination on
        // the live page. Leaving it blank does NOT make the button
        // unclickable/"Coming Soon" for a course that already has its
        // own built-in link in code (gate-da-courses.html's own c.href)
        // — it just falls back to that. Only a course with no built-in
        // link at all (the 2028 preview card, comingSoon-gated in code,
        // no button rendered regardless of this field) reads as
        // "Coming Soon" — that's driven by the card's own code, not by
        // this field being empty.
        { name: 'enroll_url', label: 'Enrol now link (overrides the button: blank keeps the course\'s existing link)', type: 'url', hint: 'The real enrolment URL (e.g. https://learn.taai.live/learn/batch/GATE-2027/content). Live on taai.live immediately.', section: 'Enrollment & dates' },
        // LIVE since 2026-09-23, same cutover — any combo (bundle) can
        // now have a real sold-out cutover date, not just full-course
        // (that restriction was only ever a /team form limit; the live
        // page's own ComboCard has always supported it generically).
        // Individual/test-series rows don't get this field — only
        // ComboCard reads soldOutDate at all, CourseCard has no such
        // concept.
        { name: 'sold_out_date', label: 'Sold-out date (bundled courses only)', type: 'date', showIf: function (row) { return row.type === 'combo'; }, section: 'Enrollment & dates' },
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
    daily_leader: '**{{name}}** logged the most focus time yesterday: **{{hours}}**!',
    monthly_consistency: '**{{name}}** was the most consistent student this month: a **typical day of {{hours}}** of focused study, day after day, all month long.',
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
        return '<button type="button" class="chip js-insert-placeholder" data-token="' + escapeHtml(ph.token) + '" title="Inserts ' + escapeHtml(ph.token) + ': ' + escapeHtml(ph.desc) + '">' + escapeHtml(ph.token) + '</button>';
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
    showBuiltIn: null, // null = automatic: open when there are no custom posts, else collapsed (see renderPostList)
    renamingWebhook: null, // webhook_url of the channel group currently showing a rename input, or null
    renameStatus: null, // { webhookUrl, saving } | { webhookUrl, error } | null
    tab: 'announcements', // 'announcements' | 'students' — mutually exclusive views, not stacked panels
    dayCard: { batch: 'D', which: 'today', theme: 'auto', date: '', months: {}, loading: false, error: null }, // Day card tab (2026-10-09)
    offerPoster: { which: 'today', mode: 'auto', pricing: null, cutoff: null, loading: false, error: null }, // Offer poster tab (2026-10-18; challenge mode 2026-10-19)
    clubWinner: { loaded: false, loading: false, form: null, saving: false, msg: null, msgType: null, updatedAt: null }, // 2 AM Club winner popup (2026-11-18)
    clubRunners: { loaded: false, loading: false, form: null, saving: false, msg: null, msgType: null }, // 2nd and 3rd place popup (2026-11-19)
    students: null, // null = not loaded yet; array once fetched
    studentsLoading: false,
    studentsError: null,
    studentSort: { key: 'total_minutes', dir: 'desc' },
    studentSummary: null,
    studentFilters: { search: '', inactive: '', active: '', minScore: '', joinedFrom: '', joinedTo: '', rankers: '', minStreak: '', flaggedOnly: false, batch: '' }, // active: '' | '7' | '14' | '30' (active within the last N days) // batch: '' | 'C' | 'D'; inactive: '' | '3' | '7' | '14' | '30' | 'never'
    noteSaving: {}, // email -> 'saving' | 'saved' | 'error', transient per-row save feedback
    studentsShown: 50, // how many rows of the filtered list are rendered (see STUDENTS_PAGE)
    studentsViewKey: '', // filters+sort last rendered; a change resets studentsShown
    clearBlockStatus: {}, // email -> 'saving' | 'error', transient status for the gate_escalated Clear block/Rename actions
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
    // LMS price sync panel on Site data > Pricing (see lib/lms-price-sync.js)
    lmsSync: { data: null, loading: false, checking: false, error: null },
    // Resources page counters on Site data > Notes / Lectures (team-resource-stats.js, 2026-11-08)
    resourceStats: { data: null, loading: false, error: null },
    // A 4th Site data sub-tab (subTab: 'settings') alongside Pricing/Notes/
    // Lectures, but deliberately its own small state/functions rather than
    // shoehorned into SITE_DATA_RESOURCES' generic list-of-rows machinery
    // — there's exactly one settings row, no create/delete, just toggles.
    siteSettings: {
      loaded: false,
      loading: false,
      saving: false,
      error: null,
      hideFinancialAssistance: false,
      scheduleRunout: [],
      runoutSaving: null,
      miniFlt: null, mfltSaving: false, mfltMsg: null, mfltError: null,
      topStrip: null, stripSaving: false, stripMsg: null, stripError: null,
    },
    // Site data > Challenge (2026-10-18): "100 pe 100% off" registrations
    // and the registration cutoff date.
    challenge: { loaded: false, loading: false, saving: false, error: null, rows: [], cutoff: null, open: true, msg: null, q: '' },
    // Competitor YouTube monitor (2026-11-24).
    comp: { loaded: false, loading: false, error: null, data: null, period: 3, sort: 'subs', sortDir: -1, vsort: 'views', vchannel: 'all', vkind: 'all', vq: '', vlimit: 40, busy: false, msg: null, msgType: 'ok', view: 'youtube', ideas: {}, ideasBusy: false, ideasErr: null, bestKind: 'video' },
    // Competitor website watcher (2026-11-25), Competitors > Websites.
    web: { loaded: false, loading: false, error: null, data: null, busy: false, msg: null, msgType: 'ok', comp: 'all', kind: 'all', open: {}, details: {}, limit: 60 },
    // Piracy takedown log + notice generator (2026-11-12).
    piracy: { loaded: false, loading: false, error: null, msg: null, rows: [], signature: null, sub: 'log', filter: 'all', q: '', checking: false, saving: false, sigSaving: false, draft: null, candidates: [], candidatesReady: false, runs: [], terms: null, termsSaving: false, foundFilter: 'new',
      ev: { loaded: false, loading: false, error: null, files: [], reports: [], reportsReady: false, unfiled: [], view: 'report', q: '', fetchedAt: 0, open: {} } },
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
      if (dayCount) return '(no body text: ' + sections.length + ' section(s), ' + dayCount + ' day row(s) below)';
      return '(empty: click Edit to add text)';
    }
    if (DEFAULT_BODY_BY_SOURCE[p.source]) return '(using the default wording) ' + DEFAULT_BODY_BY_SOURCE[p.source];
    return '(no intro line: just the computed number/list)';
  }
  function renderPostRow(p, isFirst, isLast) {
    var isBuiltIn = p.source !== 'custom';
    var tagHtml = isBuiltIn
      ? '<span class="tag tag-builtin">' + escapeHtml(SOURCE_LABELS[p.source] || p.source) + '</span>'
      : '<span class="tag tag-custom">Custom</span>';
    var title = p.title || (isBuiltIn ? SOURCE_LABELS[p.source] : '(untitled)');
    var scheduleDesc = SCHEDULE_LABELS[p.schedule_type] + ' at ' + escapeHtml(p.schedule_time) + ' IST';
    if (p.schedule_type === 'weekly') scheduleDesc = DAY_NAMES[p.schedule_day_of_week] + 's, ' + scheduleDesc;
    if (p.schedule_type === 'monthly') scheduleDesc = 'Day ' + p.schedule_day_of_month + ' of month, ' + scheduleDesc;
    if (p.schedule_type === 'once') scheduleDesc = p.schedule_date + ' at ' + escapeHtml(p.schedule_time) + ' IST';
    var bodySnippet = bodySnippetText(p);
    var truncated = bodySnippet.length > 160 ? bodySnippet.slice(0, 160) + '…' : bodySnippet;

    // A built-in post with no custom title would show its source name twice
    // (as the title and as the tag), so its tag just says Built-in.
    if (isBuiltIn && !p.title) tagHtml = '<span class="tag tag-builtin">Built-in</span>';
    // Card layout (2026-10-01, direct request: "in the form of cards like
    // the product page"), reusing the Site data > Pricing card styling
    // (.pricing-card*) so both tabs share one visual language. The next send
    // time takes the spot the price has on a course card. ◀/▶ replace the
    // old ▲/▼ since cards read left to right; same movePost behavior.
    var statusHtml = p.enabled
      ? '<span class="pricing-status pricing-status-live">● Active</span>'
      : '<span class="pricing-status pricing-status-soon">Paused</span>';
    var extras = [];
    if (p.tag_everyone) extras.push('📣 @everyone');
    if (p.extra_mentions) extras.push(escapeHtml(p.extra_mentions));
    return (
      '<div class="pricing-card post-card' + (p.enabled ? '' : ' post-card--paused') + '" data-id="' + p.id + '">' +
        '<div class="pricing-card-head">' +
          '<div class="post-card-titlewrap"><div class="pricing-card-name">' + escapeHtml(title) + '</div>' +
            '<div class="post-card-tags">' + tagHtml + '</div></div>' +
          statusHtml +
        '</div>' +
        '<div class="post-card-next"><span class="post-card-next-label">Next send</span>' +
          '<span class="post-card-next-time">' + (p.enabled ? escapeHtml(formatNextFire(p.next_fire_at)) : 'Paused') + '</span></div>' +
        '<div class="pricing-card-meta"><div><b>Schedule</b> ' + scheduleDesc + '</div>' +
          (extras.length ? '<div><b>Mentions</b> ' + extras.join(' · ') + '</div>' : '') +
        '</div>' +
        '<div class="post-body-snippet" title="' + escapeHtml(bodySnippet) + '">' + escapeHtml(truncated) + '</div>' +
        '<div class="pricing-card-actions">' +
          '<button class="btn btn-small js-edit" data-id="' + p.id + '">Edit</button>' +
          '<button class="btn btn-small js-toggle" data-id="' + p.id + '">' + (p.enabled ? 'Pause' : 'Resume') + '</button>' +
          '<button class="btn btn-small btn-danger js-delete" data-id="' + p.id + '">Delete</button>' +
          '<span class="post-card-order">' +
            '<button class="btn-order js-move-up" data-id="' + p.id + '" title="Send earlier than the card before it, when both are due at the same time"' + (isFirst ? ' disabled' : '') + '>◀</button>' +
            '<button class="btn-order js-move-down" data-id="' + p.id + '" title="Send later than the card after it, when both are due at the same time"' + (isLast ? ' disabled' : '') + '>▶</button>' +
          '</span>' +
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
        '<div class="field-hint">Fills in the channel name and webhook URL from a post you\'ve already set up: still editable below.</div>' +
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
          '<div class="pricing-cards post-cards">' + rows.map(function (p, i) { return renderPostRow(p, i === 0, i === rows.length - 1); }).join('') + '</div>' +
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
      '<div class="field-hint" style="margin-bottom:10px;">A weekly batch schedule is a Custom message with its "Extra sections" filled in below: pick a Subject and fill in one Date/Topic/Duration row per class.</div>' +
      (customPosts.length ? renderPostGroups(customPosts)
        : '<div class="empty">No announcements or schedules yet: click "+ New announcement / schedule" above to add next week\'s.</div>');

    // With no custom posts, the automatic ones are all there is, so show them
    // instead of an empty-looking page (2026-10-22). The toggle still works.
    var showBuiltIn = state.showBuiltIn === null ? !customPosts.length : state.showBuiltIn;
    var builtInHtml = builtInPosts.length
      ? (
        '<button type="button" class="btn" id="builtin-toggle" style="margin:20px 0 12px;">' +
          (showBuiltIn ? 'Hide' : 'Show') + ' recurring leaderboards (' + builtInPosts.length + ')' +
        '</button>' +
        (showBuiltIn ? renderPostGroups(builtInPosts) : '')
      )
      : '';

    return renderComingUp() + customHtml + builtInHtml;
  }

  // "Coming up": the next few sends across every channel, so "what goes out
  // next, and where" is answered without opening each card (2026-10-22).
  function renderComingUp() {
    var upcoming = state.posts
      .filter(function (p) { return p.enabled && p.next_fire_at; })
      .sort(function (a, b) { return new Date(a.next_fire_at) - new Date(b.next_fire_at); })
      .slice(0, 4);
    var paused = state.posts.filter(function (p) { return !p.enabled; }).length;
    if (!upcoming.length && !paused) return '';
    var items = upcoming.map(function (p) {
      var title = p.title || SOURCE_LABELS[p.source] || p.source;
      var channel = p.channel_name || (p.platform === 'telegram' ? 'Telegram' : 'Discord');
      return '<li><span class="coming-when">' + escapeHtml(formatNextFire(p.next_fire_at)) + '</span>' +
        '<span class="coming-what">' + escapeHtml(title) + '</span><span class="coming-where">' + escapeHtml(channel) + '</span></li>';
    }).join('');
    return '<div class="coming-up"><div class="coming-up-head"><b>Coming up</b>' +
      (paused ? '<span class="field-hint">' + paused + ' paused</span>' : '') + '</div>' +
      (items ? '<ul>' + items + '</ul>' : '<div class="field-hint">Nothing scheduled.</div>') + '</div>';
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
    // Built-in (auto leaderboard) posts: their message content and what data
    // they fetch are managed by the developers, not from /team (direct
    // request 2026-10-01: "editing the text body or the fetch functions ...
    // be removed, the dev can do it" - things should be simple for
    // non-technical people). Channel, mentions, schedule, enable/pause and
    // delete stay editable. readFormPayload sends the stored content back
    // unchanged for these, since a save replaces the whole row.
    var lockedContent = !isNew && source !== 'custom';
    var scheduleType = p.schedule_type || 'daily';

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
          ? 'Optional intro line shown above the trend number (the number itself always shows regardless). No placeholders: plain text only, or leave blank for no intro line.'
          : 'Pre-filled with the current default wording below: edit it directly, or clear the box entirely to fall back to this same default. Supports {{name}} and {{hours}} placeholders.';
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
      else if (source === 'monthly_consistency') titlePlaceholder = '🏅 Most Consistent Student: ' + previousMonthLabelApprox() + ' (the month name updates itself automatically)';
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
        '<div class="field"><label>Test bot API URL (optional)</label><input type="url" name="test_webhook_url" placeholder="A different bot\'s API URL, only if you want a separate test bot" value="' + escapeHtml(p.test_webhook_url) + '"><div class="field-hint">Leave blank to reuse the same bot above for testing: only the Test Chat ID below needs to actually differ.</div></div>' +
        '<div class="field"><label>Test Chat ID</label><input type="text" name="telegram_test_chat_id" placeholder="A private test channel/chat this bot is also admin of" value="' + escapeHtml(p.telegram_test_chat_id) + '"><div class="field-hint">Never used by the real schedule: only "Send Test" below posts here, on demand. Point this at a private test chat, not the real channel.</div></div>'
      )
      : (
        '<div class="field"><label>Webhook URL</label><input type="url" name="webhook_url" placeholder="https://discord.com/api/webhooks/..." value="' + escapeHtml(p.webhook_url) + '" required></div>' +
        '<div class="field"><label>Test webhook URL (optional)</label><input type="url" name="test_webhook_url" placeholder="A separate test-channel webhook, for the Send Test button below" value="' + escapeHtml(p.test_webhook_url) + '"><div class="field-hint">Never used by the real schedule: only "Send Test" below posts here, on demand. Point this at a private test channel, not the real one.</div></div>'
      );

    return (
      '<div class="card">' +
        '<h2 style="font-size:16px;margin-bottom:16px;">' + (isNew ? 'New scheduled post' : 'Edit scheduled post') + '</h2>' +
        '<form id="post-form"' + (lockedContent ? ' data-locked-content="1"' : '') + '>' +

          '<div class="form-section">' +
            '<div class="form-section-heading">Destination</div>' +
            '<div class="field"><label>Platform</label><select name="platform" id="f-platform">' + platformOptions + '</select></div>' +
            renderChannelSelect(p) +
            '<div class="field"><label>Channel name (for your reference)</label><input type="text" name="channel_name" placeholder="e.g. #announcements" value="' + escapeHtml(p.channel_name) + '"></div>' +
            destinationHtml +
          '</div>' +

          (lockedContent
            ? '<div class="form-section">' +
                '<div class="form-section-heading">Content</div>' +
                '<div class="locked-content-note"><b>' + escapeHtml(SOURCE_LABELS[source] || source) + '</b><br>This message is generated automatically. Its content is managed by the developers.</div>' +
              '</div>'
            : '<div class="form-section">' +
                '<div class="form-section-heading">Content</div>' +
                '<input type="hidden" name="source" value="custom">' +
                '<div class="field"><label>Title (optional)</label><input type="text" name="title" value="' + escapeHtml(titleValue) + '"></div>' +
                bodyField +
                (platform === 'telegram' ? '' : '<div class="field"><label>Card color</label><input type="color" name="color" value="' + colorToHex(p.color) + '"></div>') +
              '</div>') +

          (lockedContent ? '' : renderSectionsEditor(p)) +

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
              '<div class="field-hint">Posts are checked every 15 minutes (:00, :15, :30, :45), not continuously: a time in between (like 10:31) won\'t fire until the next check after it, so it\'d actually go out at 10:45. Pick a time ending in :00/:15/:30/:45 to fire on the exact minute.</div>' +
              '</div>' +
            '</div>' +
            '<div id="f-schedule-extra">' +
              (scheduleType === 'once' ? '<div class="field"><label>Date</label><input type="date" name="schedule_date" value="' + escapeHtml(p.schedule_date) + '" required><div class="field-hint">Fires exactly once, then pauses itself automatically (shows as "Paused" in the list below: it\'s not deleted, you can still open and resume it).</div></div>' : '') +
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
            '<strong>Preview</strong> shows what would post right now: nothing is sent or saved. ' +
            '<strong>Send Test</strong> actually posts, for real, to the Test webhook/chat above (never the real one). ' +
            '<strong>' + (isNew ? 'Create' : 'Save') + '</strong> stores this post\'s settings: it doesn\'t post anything by itself, it just schedules it for its own next fire time.' +
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
    return '<div class="msg msg-ok">Test post sent: check your test channel.</div>';
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
    // Day card and Offer poster share one "Marketing" main tab (2026-10-18,
    // direct request). state.tab still holds the sub-tab ('day-card' or
    // 'offer-poster') so each poster's own loaders keep working unchanged.
    var isMarketing = state.tab === 'day-card' || state.tab === 'offer-poster' || state.tab === 'club-winner';
    var marketingTabs = isMarketing
      ? '<div class="tabs subtabs">' +
          '<button class="tab-btn' + (state.tab === 'day-card' ? ' active' : '') + '" data-mktab="day-card">Day card</button>' +
          '<button class="tab-btn' + (state.tab === 'offer-poster' ? ' active' : '') + '" data-mktab="offer-poster">Offer poster</button>' +
          '<button class="tab-btn' + (state.tab === 'club-winner' ? ' active' : '') + '" data-mktab="club-winner">2 AM winner</button>' +
        '</div>'
      : '';
    // Counts right on the tab itself — knowing "there are 12 announcements,
    // 334 students" without having to click in first is a small thing, but
    // it's also the kind of at-a-glance orientation a two-tab page with no
    // other landing content otherwise has zero of. Students' count is
    // blank until actually loaded (null, not 0) rather than showing a
    // misleading "(0)" before the first fetch resolves.
    // 2026-11-25 ("it looks too haphazard"): plain labels with a small count
    // badge, one line each, no emoji. Counts are left out of the main bar
    // (they appeared after loading and pushed the labels onto 2-3 lines);
    // each section shows its own numbers.
    var mainTab = function (key, label, active) {
      return '<button class="tab-btn' + (active ? ' active' : '') + '" data-tab="' + key + '">' + label + '</button>';
    };
    var tabsHtml =
      '<nav class="tabs tabs-main" aria-label="Sections">' +
        mainTab('announcements', 'Announcements', isAnnouncements) +
        mainTab('students', 'Students', isStudents) +
        mainTab('site-data', 'Site data', isSiteData) +
        mainTab('marketing', 'Marketing', isMarketing) +
        mainTab('challenge', 'Challenge', state.tab === 'challenge') +
        mainTab('piracy', 'Piracy', state.tab === 'piracy') +
        mainTab('competitors', 'Competitors', state.tab === 'competitors') +
      '</nav>';

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
        : state.tab === 'day-card'
          ? renderDayCard()
          : state.tab === 'offer-poster'
            ? renderOfferPoster()
          : state.tab === 'club-winner'
            ? renderClubWinner() + renderClubRunners()
            : state.tab === 'challenge'
              ? renderChallengePanel()
              : state.tab === 'piracy'
                ? renderPiracyPanel()
              : state.tab === 'competitors'
                ? renderCompetitors()
              : (msgHtml + renderSiteData());

    // One bar under the main tabs for every section: its sub-tabs on the
    // left, its buttons on the right (they used to sit in the page header
    // and inside the cards, in a different place per section).
    var subTabsHtml = isMarketing ? marketingTabs
      : isSiteData ? '<div class="tabs subtabs">' + renderSiteDataTabs() + '</div>'
      : state.tab === 'piracy' ? renderPiracyTabs()
      : state.tab === 'competitors' ? renderCompetitorsTabs()
      : '';
    if (isSiteData) actionsHtml = siteDataNewButtonHtml();
    var barHtml = subTabsHtml || actionsHtml
      ? '<div class="section-bar"><div class="section-bar-tabs">' + subTabsHtml + '</div><div class="section-bar-actions">' + actionsHtml + '</div></div>'
      : '';

    root.innerHTML =
      '<div class="wrap">' +
        '<header>' +
          '<div><h1>Team Console</h1><div class="sub">' + (DEV_BYPASS ? 'Local dev mode: sign-in skipped' : 'Signed in as ' + escapeHtml(user.email)) + '</div></div>' +
          (DEV_BYPASS ? '' : '<button class="btn" id="logout-btn">Log out</button>') +
        '</header>' +
        tabsHtml +
        barHtml +
        bodyHtml +
      '</div>';

    // Phones: the tab strips scroll sideways, so bring the selected tab into
    // view (it could sit off-screen, e.g. Piracy past the right edge).
    document.querySelectorAll('.tabs-main, .tabs.subtabs').forEach(function (strip) {
      var act = strip.querySelector('.tab-btn.active');
      if (!act || strip.scrollWidth <= strip.clientWidth + 1) return;
      var off = act.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
      var left = off - (strip.clientWidth - act.offsetWidth) / 2;
      strip.scrollLeft = Math.max(0, Math.min(left, strip.scrollWidth - strip.clientWidth));
    });
    bindEvents();
    if (state.tab === 'day-card') bindDayCard();
    if (state.tab === 'offer-poster') bindOfferPoster();
    if (state.tab === 'piracy') bindPiracy();
    if (state.tab === 'competitors') bindCompetitors();
    if (state.tab === 'club-winner') { bindClubWinner(); bindClubRunners(); }
  }

  // ── Competitors (2026-11-24) ─────────────────────────────────────────
  // YouTube numbers for TAAI and competitor channels, recorded every 6 hours
  // by yt-monitor.js (lib/yt-monitor.js). Everything below is worked out in
  // the browser from the last 30 days of videos and 35 days of channel stats.
  function loadCompetitors() {
    var c = state.comp;
    c.loading = true; c.error = null; render();
    api('/team-competitors').then(function (d) {
      c.data = d; c.loaded = true; c.loading = false;
      c.error = d.ready === false ? d.error : null;
      render();
    }).catch(function (e) { c.loading = false; c.loaded = true; c.error = e.message; render(); });
  }
  function cmpMedian(a) {
    a = a.filter(function (x) { return x != null; }).sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
  }
  function cmpNum(n) {
    if (n == null) return '-';
    if (n >= 10000000) return (n / 10000000).toFixed(n >= 100000000 ? 0 : 1) + ' Cr';
    if (n >= 100000) return (n / 100000).toFixed(n >= 1000000 ? 0 : 1) + ' L';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
    return String(Math.round(n));
  }
  function cmpAgo(iso) {
    var h = (Date.now() - Date.parse(iso)) / 3600000;
    if (h < 1) return 'just now';
    if (h < 24) return Math.floor(h) + 'h ago';
    var d = Math.floor(h / 24);
    return d + ' day' + (d === 1 ? '' : 's') + ' ago';
  }
  function cmpRows() {
    var c = state.comp, d = c.data, now = Date.now(), from = now - c.period * 86400000;
    var startDay = new Date(from + 5.5 * 3600000).toISOString().slice(0, 10);
    return d.channels.filter(function (ch) { return ch.active; }).map(function (ch) {
      var st = d.stats.filter(function (x) { return x.channel_id === ch.channel_id; });
      var last = st[st.length - 1] || null;
      var before = st.filter(function (x) { return x.taken_on <= startDay; }).pop() || null;
      var base = before || st[0] || null;
      var vids = d.videos.filter(function (v) { return v.channel_id === ch.channel_id && Date.parse(v.published_at) >= from; });
      var longf = vids.filter(function (v) { return v.kind !== 'short'; });
      var shorts = vids.filter(function (v) { return v.kind === 'short'; });
      var views = vids.reduce(function (a, v) { return a + (v.views || 0); }, 0);
      var eng = vids.filter(function (v) { return v.views; });
      var engV = eng.reduce(function (a, v) { return a + v.views; }, 0);
      var engL = eng.reduce(function (a, v) { return a + (v.likes || 0) + (v.comments || 0); }, 0);
      var top = vids.slice().sort(function (a, b) { return (b.views || 0) - (a.views || 0); })[0] || null;
      return {
        ch: ch,
        name: ch.label || ch.title || ch.handle,
        subs: last ? last.subscribers : null,
        gained: last && base && base.taken_on !== last.taken_on && last.subscribers != null && base.subscribers != null ? last.subscribers - base.subscribers : null,
        gainedSince: before ? null : (base ? base.taken_on : null),
        uploads: vids.length, nLong: longf.filter(function (v) { return v.kind !== 'live'; }).length, nLive: vids.filter(function (v) { return v.kind === 'live'; }).length, nShort: shorts.length,
        views: views,
        medLong: cmpMedian(longf.map(function (v) { return v.views; })),
        medShort: cmpMedian(shorts.map(function (v) { return v.views; })),
        med24: cmpMedian(longf.map(function (v) { return v.views_24h; })),
        eng: engV ? engL / engV * 100 : null,
        top: top
      };
    });
  }
  var CMP_COLS = [
    ['name', 'Channel'], ['subs', 'Subs'], ['gained', 'Gained'], ['uploads', 'Uploads'], ['views', 'Views'],
    ['medLong', 'Median / video'], ['medShort', 'Median / Short'], ['med24', 'Median day 1'], ['eng', 'Engagement']
  ];
  function renderCompetitorsTabs() {
    var v = state.comp.view;
    return '<div class="tabs subtabs">' + [['youtube', 'YouTube'], ['insights', 'Insights'], ['market', 'Whole market'], ['season', 'Through the year'], ['web', 'Websites']].map(function (x) {
      return '<button type="button" class="tab-btn' + (v === x[0] ? ' active' : '') + '" data-cmpview="' + x[0] + '">' + x[1] + '</button>';
    }).join('') + '</div>';
  }
  function renderCompetitors() {
    return state.comp.view === 'web' ? renderWebWatch() : state.comp.view === 'insights' ? renderCmpInsightsTab() : state.comp.view === 'season' ? renderCmpSeason() : state.comp.view === 'market' ? renderCmpMarket() : renderCmpYoutube();
  }
  function renderCmpYoutube() {
    var c = state.comp, d = c.data;
    if (c.loading && !c.loaded) return '<div class="card"><div class="field-hint">Loading…</div></div>';
    if (c.error && !d) return '<div class="card"><div class="msg msg-error">' + escapeHtml(c.error) + '</div></div>';
    if (!d || d.ready === false) return '<div class="card"><div class="msg msg-error">Not set up yet: the developer needs to run the competitor monitor SQL first.' + (c.error ? ' (' + escapeHtml(c.error) + ')' : '') + '</div></div>';
    var rows = cmpRows();
    var k = c.sort, dir = c.sortDir;
    rows.sort(function (a, b) {
      if (k === 'name') return dir * String(a.name).localeCompare(String(b.name));
      var x = a[k], y = b[k];
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return dir * (x - y);
    });
    var best = {};
    ['subs', 'gained', 'uploads', 'views', 'medLong', 'medShort', 'med24', 'eng'].forEach(function (key) {
      var vals = rows.map(function (r) { return r[key]; }).filter(function (v) { return v != null; });
      best[key] = vals.length ? Math.max.apply(null, vals) : null;
    });
    var run = d.lastRun;
    var head = '<div class="cmp-head">' +
      '<div class="field-hint">' + (d.keyReady
        ? 'Numbers from the YouTube API, recorded every 6 hours.'
        : 'Running on YouTube\'s public feeds: only each channel\'s latest 15 videos, and no subscriber or comment counts. Add the YouTube API key in Netlify for the full picture.') +
        (run ? ' Last update ' + escapeHtml(cmpAgo(run.ran_at)) + (run.error ? ' (some channels failed: ' + escapeHtml(run.error) + ')' : '') + '.' : ' No data recorded yet: press Refresh now.') + '</div>' +
      '<div class="cmp-head-actions">' +
        '<div class="tabs cmp-period">' + [[1, '24 hours'], [3, '3 days'], [7, '7 days'], [30, '30 days']].map(function (p) {
          return '<button type="button" class="tab-btn' + (c.period === p[0] ? ' active' : '') + '" data-cmpperiod="' + p[0] + '">' + p[1] + '</button>';
        }).join('') + '</div>' +
        '<button type="button" class="btn" id="cmp-refresh"' + (c.busy ? ' disabled' : '') + '>' + (c.busy ? 'Updating…' : '↻ Refresh now') + '</button>' +
      '</div></div>';
    var table = '<div class="students-table-wrap"><table class="students-table cmp-table"><thead><tr>' +
      CMP_COLS.map(function (col) {
        return '<th class="' + (col[0] === k ? 'sorted' : '') + '" data-cmpsort="' + col[0] + '">' + escapeHtml(col[1]) + (col[0] === 'gained' || col[0] === 'uploads' || col[0] === 'views' ? ' <span class="cmp-per">(' + (c.period === 1 ? '24h' : c.period + 'd') + ')</span>' : '') + (col[0] === k ? (dir < 0 ? ' ↓' : ' ↑') : '') + '</th>';
      }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) {
        var cell = function (key, txt) { return '<td class="cmp-n' + (r[key] != null && r[key] === best[key] && rows.length > 1 ? ' cmp-best' : '') + '">' + txt + '</td>'; };
        return '<tr class="' + (r.ch.is_us ? 'cmp-us' : '') + '">' +
          '<td class="cmp-ch">' + (r.ch.thumbnail ? '<img src="' + escapeHtml(r.ch.thumbnail) + '" alt="" loading="lazy">' : '<span class="cmp-av">' + escapeHtml(String(r.name).charAt(0)) + '</span>') +
            '<div><a href="https://www.youtube.com/' + (r.ch.handle ? '@' + escapeHtml(r.ch.handle) : 'channel/' + escapeHtml(r.ch.channel_id)) + '" target="_blank" rel="noopener">' + escapeHtml(r.name) + '</a>' + (r.ch.is_us ? ' <span class="cmp-you">You</span>' : '') +
            (r.ch.handle ? '<div class="field-hint">@' + escapeHtml(r.ch.handle) + '</div>' : '') + '</div></td>' +
          cell('subs', cmpNum(r.subs)) +
          cell('gained', r.gained == null ? '-' : (r.gained > 0 ? '+' : '') + cmpNum(r.gained) + (r.gainedSince ? '<div class="field-hint">since ' + escapeHtml(pirFmtDate(r.gainedSince)) + '</div>' : '')) +
          cell('uploads', r.uploads + '<div class="field-hint">' + r.nLong + ' video' + (r.nLong === 1 ? '' : 's') + ' · ' + r.nShort + ' short' + (r.nShort === 1 ? '' : 's') + (r.nLive ? ' · ' + r.nLive + ' live' : '') + '</div>') +
          cell('views', cmpNum(r.views)) + cell('medLong', cmpNum(r.medLong)) + cell('medShort', cmpNum(r.medShort)) + cell('med24', cmpNum(r.med24)) +
          cell('eng', r.eng == null ? '-' : r.eng.toFixed(1)) +
        '</tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="field-hint" style="margin-top:8px;">Uploads, Views and the medians count only videos published in the chosen period. Median / video and Median / Short are the middle view counts of those uploads. Median day 1 is the views a video had about 24 hours after going up, so new and old videos compare fairly; it fills in as the monitor runs. Engagement is likes plus comments per 100 views. The best value in each column is highlighted.</div>';
    return '<div class="card">' +
      (c.msg ? '<div class="msg ' + (c.msgType === 'error' ? 'msg-error' : 'msg-ok') + '">' + escapeHtml(c.msg) + '</div>' : '') +
      head + table + renderCmpInsights() + renderCmpVideos() + renderCmpChannels() +
    '</div>';
  }
  // ── Best videos / what's working / ideas (2026-11-25) ──────────────
  // "Not organized like which video performed the best in which time and
  // what kind of videos we can make". A video is measured against its own
  // channel's usual views for that format (median of the channel's videos
  // over 30 days, at least a day old): 3.0× means three times what that
  // channel normally gets, so a small channel's hit isn't buried under a big
  // channel's ordinary upload.
  var CMP_TOPICS = [
    ['Exam strategy and time left', /last \d+ (days|months)|strategy|roadmap|\bplan\b|time (kam|left)|panic|revision|how to (prepare|crack|study)|preparation tips|kaise kare/i],
    ['Mock tests and PYQs', /mock|test series|pyq|previous year|practice question|most expected/i],
    ['Marks, rank and cutoffs', /marks|cutoff|cut-off|\brank\b|\bair\b|score|percentile/i],
    ['Jobs, PSUs and careers', /psu|recruitment|\bjobs?\b|placement|salary|career|bhel|nsic|scientist|isro|drdo|product compan/i],
    ['IIT, M.Tech and abroad', /\biit|m\.?tech|iisc|abroad|admission/i],
    ['Toppers and stories', /topper|story|felicitation|interview|journey|success/i],
    ['General Aptitude', /aptitude/i],
    ['Subject lectures', /lecture|one shot|\b\d{1,2}\s*[:|]|\b0\d\b|algorithm|data structure|probability|statistic|linear algebra|calculus|machine learning|\bml\b|artificial intelligence|\bai\b|dbms|python|network|operating system|compiler|theory of computation|digital|inference/i],
    ['Motivation and mindset', /motivat|mindset|focus|discipline|reels|mistake|reality|tier-?3|don'?t|study smarter|faster/i]
  ];
  function cmpScored(periodDays) {
    var c = state.comp, d = c.data, now = Date.now(), period = periodDays || c.period, from = now - period * 86400000;
    var names = {}; d.channels.forEach(function (ch) { names[ch.channel_id] = ch; });
    // Up to 3 days (2026-11-25, "3 day trending topics"): a 1-day-old video
    // hasn't had time to collect its views, so short windows compare views
    // per day with the channel's usual views per day instead of totals.
    var perDay = period <= 3;
    var val = function (v) { var age = Math.max(1, (now - Date.parse(v.published_at)) / 86400000); return perDay ? (v.views || 0) / age : (v.views || 0); };
    // Per day, a new video is compared with the channel's other recent ones
    // (1 to 7 days old): month-old videos' daily views have faded, which made
    // ordinary new uploads look like 15× hits. Too few recent ones: all 30 days.
    var groups = {}, recent = {};
    d.videos.forEach(function (v) {
      var age = now - Date.parse(v.published_at);
      if (age < 86400000) return;
      var k = v.channel_id + '|' + (v.kind || 'video'); (groups[k] = groups[k] || []).push(val(v));
      if (age <= 7 * 86400000) (recent[k] = recent[k] || []).push(val(v));
    });
    if (perDay) Object.keys(recent).forEach(function (k) { if (recent[k].length >= 3) groups[k] = recent[k]; });
    var base = {}; Object.keys(groups).forEach(function (k) { base[k] = cmpMedian(groups[k]); });
    return d.videos.filter(function (v) { return Date.parse(v.published_at) >= from && names[v.channel_id] && names[v.channel_id].active; }).map(function (v) {
      var b = base[v.channel_id + '|' + (v.kind || 'video')];
      var age = (now - Date.parse(v.published_at)) / 86400000;
      return { v: v, ch: names[v.channel_id], score: b ? val(v) / b : null, age: age, settled: age >= 1 };
    });
  }
  function cmpX(x) { return x == null ? '-' : (x >= 10 ? Math.round(x) : x.toFixed(1)) + '×'; }
  function cmpBestRow(r, i) {
    var v = r.v;
    return '<a class="cmp-best-row' + (r.ch.is_us ? ' is-us' : '') + '" href="https://www.youtube.com/' + (v.kind === 'short' ? 'shorts/' : 'watch?v=') + escapeHtml(v.video_id) + '" target="_blank" rel="noopener">' +
      '<span class="cmp-best-n">' + (i + 1) + '</span>' +
      '<img loading="lazy" alt="" src="https://i.ytimg.com/vi/' + escapeHtml(v.video_id) + '/mqdefault.jpg">' +
      '<span class="cmp-best-body"><b>' + escapeHtml(v.title) + '</b><span class="field-hint">' + escapeHtml(r.ch.label || r.ch.title) + (r.ch.is_us ? ' (you)' : '') + ' · ' + escapeHtml(cmpAgo(v.published_at)) + ' · ' + cmpNum(v.views) + ' views</span></span>' +
      '<span class="cmp-x' + (r.score >= 2 ? ' is-hot' : r.score < 1 ? ' is-cold' : '') + '" title="Views compared with this channel\'s usual for this format">' + cmpX(r.score) + '</span></a>';
  }
  function renderCmpInsights() {
    var c = state.comp, per = c.period === 1 ? '24 hours' : c.period + ' days';
    var rows = cmpScored(), ranked = rows.filter(function (r) { return r.settled && r.score != null; });
    var best = function (kinds) {
      return ranked.filter(function (r) { return kinds.indexOf(r.v.kind || 'video') !== -1; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 8);
    };
    var kind = c.bestKind;
    var list = best(kind === 'short' ? ['short'] : ['video', 'live']);
    var fresh = rows.filter(function (r) { return !r.settled; }).length;
    var bestHtml = '<h3 class="cmp-h">Best videos in the last ' + per + '</h3>' +
      '<div class="field-hint" style="margin-bottom:10px;">' + (c.period <= 3
        ? 'Ranked by views per day against each channel\'s usual for that format, so a video posted yesterday competes fairly with one from three days ago: 3.0× means it is pulling three times the daily views that channel normally gets. '
        : 'Ranked by views against each channel\'s usual for that format: 3.0× means three times the views that channel normally gets, so a small channel\'s hit counts as much as a big channel\'s. ') + (fresh ? fresh + ' video' + (fresh === 1 ? ' is' : 's are') + ' under a day old and not ranked yet.' : '') + '</div>' +
      '<div class="tabs subtabs" style="margin-bottom:10px;"><button type="button" class="tab-btn' + (kind !== 'short' ? ' active' : '') + '" data-cmpbest="video">Videos</button><button type="button" class="tab-btn' + (kind === 'short' ? ' active' : '') + '" data-cmpbest="short">Shorts</button></div>' +
      (list.length ? '<div class="cmp-best-list">' + list.map(cmpBestRow).join('') + '</div>' : '<div class="field-hint">Nothing to rank in this period yet' + (c.period === 1 ? ': try 7 days.' : '.') + '</div>');
    // Topics: each video goes to the first topic its title matches.
    var topics = CMP_TOPICS.map(function (t) { return { name: t[0], re: t[1], rows: [] }; });
    var other = { name: 'Other', rows: [] };
    ranked.filter(function (r) { return !r.ch.is_us; }).forEach(function (r) {
      var t = topics.filter(function (x) { return x.re.test(r.v.title); })[0] || other; t.rows.push(r);
    });
    var trows = topics.concat([other]).filter(function (t) { return t.rows.length; }).map(function (t) {
      t.med = cmpMedian(t.rows.map(function (r) { return Math.round(r.score * 100); })) / 100;
      t.top = t.rows.slice().sort(function (a, b) { return b.score - a.score; })[0];
      return t;
    }).sort(function (a, b) { return b.med - a.med; });
    var topicsHtml = '<h3 class="cmp-h">What\'s working in the last ' + per + ' <span class="field-hint">competitor videos, grouped by title</span></h3>' +
      (trows.length ? '<table class="web-ptable cmp-topics"><thead><tr><th>Topic</th><th class="web-pr">Videos</th><th class="web-pr">Typical</th><th>Best one</th></tr></thead><tbody>' + trows.map(function (t) {
        return '<tr><td><b>' + escapeHtml(t.name) + '</b></td><td class="web-pr">' + t.rows.length + '</td><td class="web-pr"><span class="cmp-x' + (t.med >= 1.5 ? ' is-hot' : t.med < 1 ? ' is-cold' : '') + '">' + cmpX(t.med) + '</span></td>' +
          '<td class="cmp-topic-best"><a href="https://www.youtube.com/' + (t.top.v.kind === 'short' ? 'shorts/' : 'watch?v=') + escapeHtml(t.top.v.video_id) + '" target="_blank" rel="noopener">' + escapeHtml(t.top.v.title) + '</a><span class="field-hint"> · ' + escapeHtml(t.top.ch.label || t.top.ch.title) + ' · ' + cmpX(t.top.score) + '</span></td></tr>';
      }).join('') + '</tbody></table><div class="field-hint" style="margin-top:6px;">Typical is the middle score of the topic\'s videos: above 1.0× the topic beats channels\' usual, below 1.0× it does worse.</div>'
        : '<div class="field-hint">Not enough settled videos in this period yet.</div>');
    return bestHtml + topicsHtml + renderCmpIdeas();
  }
  function renderCmpIdeas() {
    var c = state.comp, per = c.period === 1 ? '24 hours' : c.period + ' days';
    var doc = c.ideas[c.period];
    var btn = '<button type="button" class="btn btn-primary" id="cmp-ideas"' + (c.ideasBusy ? ' disabled' : '') + '>' + (c.ideasBusy ? 'Thinking… (about a minute)' : (doc && !doc.error ? '↻ New ideas from the last ' + per : '✨ Suggest videos from the last ' + per)) + '</button>';
    var body = '';
    if (doc === undefined) body = '<div class="field-hint">Loading…</div>';
    else if (doc && doc.error) body = '<div class="msg msg-error">Couldn\'t make ideas: ' + escapeHtml(doc.error) + '</div>';
    else if (doc) {
      body = '<div class="field-hint">Made ' + escapeHtml(cmpAgo(doc.generatedAt)) + ' from ' + doc.videosConsidered + ' competitor videos by Claude. Check facts before you publish.</div>' +
        '<p class="cmp-ideas-sum">' + escapeHtml(doc.summary) + '</p>' +
        '<div class="cmp-ideas">' + (doc.ideas || []).map(function (it) {
          return '<div class="cmp-idea"><div class="cmp-idea-top"><span class="cmp-idea-fmt">' + escapeHtml(it.format) + '</span><b>' + escapeHtml(it.title) + '</b></div>' +
            '<div class="cmp-idea-hook">“' + escapeHtml(it.hook) + '”</div>' +
            '<div class="cmp-idea-why">' + escapeHtml(it.why) + '</div>' +
            ((it.based_on || []).length ? '<div class="field-hint">Based on: ' + it.based_on.map(escapeHtml).join(' · ') + '</div>' : '') + '</div>';
        }).join('') + '</div>' +
        ((doc.working || []).length ? '<details class="cmp-working"><summary>What Claude saw working (' + doc.working.length + ')</summary>' + doc.working.map(function (w) {
          return '<div class="cmp-work"><b>' + escapeHtml(w.pattern) + '</b><div class="field-hint">' + escapeHtml(w.evidence) + '</div></div>';
        }).join('') + '</details>' : '');
    } else body = '<div class="field-hint">No ideas for this period yet. Press the button: Claude reads the competitor videos of the last ' + per + ', finds what beat their usual, and suggests GATE DA videos TAAI could make, each with a title, opening line and the evidence.</div>';
    return '<div class="cmp-ideas-card"><div class="cmp-ideas-head"><h3 class="cmp-h" style="margin:0;">Video ideas for TAAI</h3>' + btn + '</div>' +
      (c.ideasErr ? '<div class="msg msg-error">' + escapeHtml(c.ideasErr) + '</div>' : '') + body + '</div>';
  }
  function loadCmpIdeas(days) {
    var c = state.comp;
    if (c.ideas[days] !== undefined) return;
    api('/team-competitors?ideas=' + days).then(function (r) { c.ideas[days] = r.ideas || null; render(); }).catch(function () { c.ideas[days] = null; render(); });
  }
  function cmpMakeIdeas() {
    var c = state.comp, days = c.period;
    c.ideasBusy = true; c.ideasErr = null; render();
    api('/team-competitors', { method: 'POST', body: JSON.stringify({ action: 'ideas', days: days }) }).then(function (r) {
      var since = Date.parse(r.at) - 5000, tries = 0;
      (function poll() {
        tries++;
        api('/team-competitors?ideas=' + days).then(function (x) {
          var doc = x.ideas;
          if (doc && Date.parse(doc.generatedAt) >= since) { c.ideas[days] = doc; c.ideasBusy = false; render(); return; }
          if (tries >= 40) { c.ideasBusy = false; c.ideasErr = 'Still working after 3 minutes. Reload the page in a bit.'; render(); return; }
          setTimeout(poll, 5000);
        }).catch(function () { if (tries < 40) setTimeout(poll, 5000); else { c.ideasBusy = false; render(); } });
      })();
    }).catch(function (e) { c.ideasBusy = false; c.ideasErr = e.message; render(); });
  }
  function renderCmpVideos() {
    var c = state.comp, d = c.data, now = Date.now(), from = now - c.period * 86400000;
    var names = {}; d.channels.forEach(function (ch) { names[ch.channel_id] = ch; });
    var q = (c.vq || '').toLowerCase();
    var list = d.videos.filter(function (v) {
      if (Date.parse(v.published_at) < from) return false;
      if (!names[v.channel_id] || !names[v.channel_id].active) return false;
      if (c.vchannel !== 'all' && v.channel_id !== c.vchannel) return false;
      if (c.vkind !== 'all' && (v.kind || 'video') !== c.vkind) return false;
      if (q && String(v.title).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var perDay = function (v) { return (v.views || 0) / Math.max(1, (now - Date.parse(v.published_at)) / 86400000); }; // under a day old counts as one day, so a 10-hour-old video isn't scaled up
    var sorters = {
      views: function (a, b) { return (b.views || 0) - (a.views || 0); },
      perday: function (a, b) { return perDay(b) - perDay(a); },
      first: function (a, b) { return (b.views_24h == null ? -1 : b.views_24h) - (a.views_24h == null ? -1 : a.views_24h); },
      comments: function (a, b) { return (b.comments || 0) - (a.comments || 0); },
      newest: function (a, b) { return Date.parse(b.published_at) - Date.parse(a.published_at); }
    };
    list.sort(sorters[c.vsort] || sorters.views);
    var shown = list.slice(0, c.vlimit);
    var opt = function (v, l, cur) { return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + l + '</option>'; };
    return '<h3 class="cmp-h">All videos <span class="field-hint">' + list.length + ' in the last ' + (c.period === 1 ? '24 hours' : c.period + ' days') + '</span></h3>' +
      '<div class="chal-toolbar cmp-vtools">' +
        '<select id="cmp-vchannel">' + opt('all', 'All channels', c.vchannel) + d.channels.filter(function (ch) { return ch.active; }).map(function (ch) { return opt(ch.channel_id, escapeHtml(ch.label || ch.title), c.vchannel); }).join('') + '</select>' +
        '<select id="cmp-vkind">' + opt('all', 'All types', c.vkind) + opt('video', 'Videos', c.vkind) + opt('short', 'Shorts', c.vkind) + opt('live', 'Live streams', c.vkind) + '</select>' +
        '<select id="cmp-vsort">' + opt('views', 'Most views', c.vsort) + opt('perday', 'Most views per day', c.vsort) + opt('first', 'Most first-day views', c.vsort) + opt('comments', 'Most comments', c.vsort) + opt('newest', 'Newest', c.vsort) + '</select>' +
        '<input type="search" id="cmp-vq" placeholder="Search titles" value="' + escapeHtml(c.vq || '') + '">' +
      '</div>' +
      (shown.length ? '<div class="cmp-vlist">' + shown.map(function (v) {
        var ch = names[v.channel_id];
        return '<a class="cmp-v' + (ch.is_us ? ' cmp-v-us' : '') + '" href="https://www.youtube.com/' + (v.kind === 'short' ? 'shorts/' : 'watch?v=') + escapeHtml(v.video_id) + '" target="_blank" rel="noopener">' +
          '<span class="cmp-vthumb' + (v.kind === 'short' ? ' is-short' : '') + '"><img loading="lazy" alt="" src="https://i.ytimg.com/vi/' + escapeHtml(v.video_id) + '/mqdefault.jpg">' +
            (v.kind === 'short' ? '<i>Short</i>' : v.kind === 'live' ? '<i>Live</i>' : v.duration_s ? '<i>' + (v.duration_s >= 3600 ? Math.floor(v.duration_s / 3600) + ':' + String(Math.floor(v.duration_s / 60) % 60).padStart(2, '0') : Math.floor(v.duration_s / 60)) + ':' + String(v.duration_s % 60).padStart(2, '0') + '</i>' : '') + '</span>' +
          '<span class="cmp-vbody"><b>' + escapeHtml(v.title) + '</b>' +
            '<span class="field-hint">' + escapeHtml(ch.label || ch.title) + (ch.is_us ? ' (you)' : '') + ' · ' + escapeHtml(cmpAgo(v.published_at)) + '</span>' +
            '<span class="cmp-vstats"><span><b>' + cmpNum(v.views) + '</b> views</span><span><b>' + cmpNum(perDay(v)) + '</b>/day</span>' +
              (v.views_24h != null ? '<span><b>' + cmpNum(v.views_24h) + '</b> first day</span>' : '') +
              (v.likes != null ? '<span><b>' + cmpNum(v.likes) + '</b> likes</span>' : '') +
              (v.comments != null ? '<span><b>' + cmpNum(v.comments) + '</b> comments</span>' : '') + '</span>' +
          '</span></a>';
      }).join('') + '</div>' + (list.length > shown.length ? '<button type="button" class="btn" id="cmp-more" style="margin-top:10px;">Show more (' + (list.length - shown.length) + ' left)</button>' : '')
      : '<div class="field-hint">No videos match.</div>');
  }
  function renderCmpChannels() {
    var c = state.comp, d = c.data;
    return '<details class="cmp-manage"><summary>Channels monitored (' + d.channels.filter(function (ch) { return ch.active; }).length + ')</summary>' +
      '<div class="cmp-chlist">' + d.channels.map(function (ch) {
        return '<div class="cmp-chrow' + (ch.active ? '' : ' is-off') + '"><span>' + escapeHtml(ch.label || ch.title) + (ch.handle ? ' <span class="field-hint">@' + escapeHtml(ch.handle) + '</span>' : '') + (ch.active ? '' : ' <span class="field-hint">(stopped)</span>') + '</span>' +
          (ch.is_us ? '<span class="field-hint">your channel</span>' : '<button type="button" class="btn btn-small js-cmp-toggle" data-id="' + escapeHtml(ch.channel_id) + '" data-on="' + (ch.active ? '1' : '0') + '">' + (ch.active ? 'Stop monitoring' : 'Monitor again') + '</button>') + '</div>';
      }).join('') + '</div>' +
      '<div class="chal-toolbar" style="margin-top:12px;"><input type="text" id="cmp-add-input" placeholder="Channel link or @handle"><input type="text" id="cmp-add-label" placeholder="Short name (optional)"><button type="button" class="btn btn-primary" id="cmp-add"' + (c.busy ? ' disabled' : '') + '>Add channel</button></div>' +
      '<div class="field-hint">A new channel shows up after the next update (press Refresh now to update straight away). Stopping keeps its past numbers.</div>' +
    '</details>';
  }

  // ── Through the year (2026-11-25) ─────────────────────────────────────
  // "Next year, what kind of videos run well at which time of the year."
  // Every video 30+ days old (team-competitors.js ?season=1), grouped by the
  // calendar month it went up in, any year. A video's score is its views
  // against the same channel's videos of the same format published within
  // 45 days either side of it, so a video is only compared with ones of a
  // similar age: monitored videos stop at about 30 days of views, the ones
  // loaded with "Load the past 12 months" have their views to date.
  var SEASON_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var SEASON_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // What the GATE year usually looks like in each month (typical pattern, dates move every year).
  var SEASON_NOTES = [
    'Last weeks before GATE: revision, admit cards, mocks', 'GATE exam month', 'Answer keys, results and scorecards',
    'IIT / IISc M.Tech and MS applications, COAP', 'Admission rounds and offers', 'Admissions close, new batches start',
    'Fresh start for the next GATE', 'GATE registration opens', 'Registration, syllabus and strategy',
    'Registration closes, first full revisions', 'Mock tests and final stretch begins', 'Revision and full-length mocks'
  ];
  // ── Insights tab (2026-11-27): alerts, topic gaps, posting times,
  // subscriber growth, thumbnail wall, what students ask in comments. All
  // worked out in the browser from the data the YouTube tab already loads,
  // plus small extra reads (?alerts, ?growth ~2 KB, ?comments).
  function insState() {
    var c = state.comp;
    c.ins = c.ins || { gapDays: 30, wallDays: 7, wallKind: 'video', cdays: 7, comments: {}, alerts: null, growth: null, loaded: false };
    return c.ins;
  }
  function loadCmpInsights() {
    var c = state.comp, I = insState();
    if (!c.loaded && !c.loading) loadCompetitors();
    if (I.loading || I.loaded) return;
    I.loading = true;
    Promise.all([
      api('/team-competitors?alerts=1').catch(function () { return { sent: [] }; }),
      api('/team-competitors?growth=1').catch(function () { return { growth: [] }; })
    ]).then(function (r) { I.alerts = r[0].sent || []; I.growth = r[1].growth || []; I.loading = false; I.loaded = true; render(); });
    loadCmpComments(I.cdays);
  }
  function loadCmpComments(days) {
    var I = insState();
    if (I.comments[days] !== undefined) return;
    api('/team-competitors?comments=' + days).then(function (r) { I.comments[days] = r.comments || null; render(); }).catch(function () { I.comments[days] = null; render(); });
  }
  function insWeekdayHourIST(iso) {
    var d = new Date(Date.parse(iso) + 5.5 * 3600000);
    return { wd: (d.getUTCDay() + 6) % 7, h: d.getUTCHours() };
  }
  var INS_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var INS_BLOCKS = [[6, 9, '6-9 AM'], [9, 12, '9-12'], [12, 15, '12-3 PM'], [15, 18, '3-6'], [18, 21, '6-9 PM'], [21, 24, '9-12'], [0, 6, 'Night']];
  function insBlock(h) { for (var i = 0; i < INS_BLOCKS.length; i++) if (h >= INS_BLOCKS[i][0] && h < INS_BLOCKS[i][1]) return i; return 6; }
  function insVideoLink(id, kind) { return 'https://www.youtube.com/' + (kind === 'short' ? 'shorts/' : 'watch?v=') + id; }
  function renderCmpInsightsTab() {
    var c = state.comp, I = insState(), d = c.data;
    if ((c.loading && !c.loaded) || !I.loaded) return '<div class="card"><div class="field-hint">Loading…</div></div>';
    if (!d || d.ready === false) return '<div class="card"><div class="msg msg-error">Not set up yet: the developer needs to run the competitor monitor SQL first.</div></div>';
    return '<div class="card">' +
      (I.msg ? '<div class="msg ' + (I.msgType === 'error' ? 'msg-error' : 'msg-ok') + '">' + escapeHtml(I.msg) + '</div>' : '') +
      insAlertsHtml() + insGapsHtml() + insWhenHtml() + insGrowthHtml() + insWallHtml() + insCommentsHtml() +
    '</div>';
  }
  // 1. Breakout alerts already sent to Discord.
  function insAlertsHtml() {
    var I = insState(), list = (I.alerts || []).slice(0, 15);
    return '<h3 class="cmp-h" style="margin-top:0;">🔥 Breakout alerts</h3>' +
      '<div class="field-hint" style="margin-bottom:10px;">After every 6-hourly update, a competitor video that is 3 to 48 hours old, about the exam, has 1,000+ views and is pulling 3× or more its channel\'s usual daily views is added here. Every Monday at 9 AM the week\'s list goes to the team reminders channel on Discord as one message (top 10).</div>' +
      (list.length ? '<div class="ins-alerts">' + list.map(function (a) {
        return '<a class="ins-alert" href="' + escapeHtml(insVideoLink(a.video_id, a.kind)) + '" target="_blank" rel="noopener">' +
          '<img loading="lazy" alt="" src="https://i.ytimg.com/vi/' + escapeHtml(a.video_id) + '/mqdefault.jpg">' +
          '<span><b>' + escapeHtml(a.title) + '</b><span class="field-hint">' + escapeHtml(a.channel) + ' · ' + cmpNum(a.views) + ' views when spotted · ' + escapeHtml(cmpAgo(a.at)) +
          (a.posted ? ' · sent to Discord' : a.postError ? ' · not sent: ' + escapeHtml(a.postError) : ' · goes out Monday') + '</span></span>' +
          '<span class="cmp-x is-hot">' + a.score + '×</span></a>';
      }).join('') + '</div>' : '<div class="field-hint">None yet. The first ones arrive with the next update after this goes live.</div>');
  }
  // 3. Topic gaps: which topics each channel covered, and where competitors
  // are getting views on something TAAI hasn't posted about.
  function insGapsHtml() {
    var c = state.comp, I = insState(), days = I.gapDays, d = c.data, now = Date.now(), from = now - days * 86400000;
    var chans = d.channels.filter(function (ch) { return ch.active; });
    var rows = cmpScored(30).filter(function (r) { return r.settled; });
    if (days > 30) {
      if (!(c.season && c.season.loaded)) { if (!(c.season && c.season.loading)) setTimeout(loadCmpSeason, 0); return insGapsShell('<div class="field-hint">Loading older videos…</div>'); }
      seasonScored().forEach(function (r) {
        if (r.v.t >= from && r.ch.active) rows.push({ v: { channel_id: r.v.channel_id, title: r.v.title, kind: r.v.kind }, ch: r.ch, score: r.score, settled: true });
      });
    }
    var T = CMP_TOPICS.map(function (t, i) { return { name: t[0], i: i, by: {}, scores: [], us: 0, them: 0 }; });
    T.push({ name: 'Everything else', i: CMP_TOPICS.length, by: {}, scores: [], us: 0, them: 0 });
    rows.forEach(function (r) {
      var t = T[seasonTopic(r.v.title || '')];
      t.by[r.v.channel_id] = (t.by[r.v.channel_id] || 0) + 1;
      if (r.ch.is_us) t.us++; else { t.them++; if (r.score != null) t.scores.push(r.score); }
    });
    T.forEach(function (t) { t.med = t.scores.length >= 3 ? cmpMedian(t.scores.map(function (x) { return Math.round(x * 100); })) / 100 : null; t.gap = t.them >= 3 && t.us === 0 && t.i < CMP_TOPICS.length; });
    T.sort(function (a, b) { return (b.gap - a.gap) || ((b.med || 0) - (a.med || 0)); });
    var us = chans.filter(function (ch) { return ch.is_us; }), them = chans.filter(function (ch) { return !ch.is_us; });
    var cols = us.concat(them);
    var table = '<div class="students-table-wrap"><table class="students-table ins-gaps"><thead><tr><th>Topic</th><th title="Median score of competitor videos on this topic">Works?</th>' +
      cols.map(function (ch) { return '<th class="' + (ch.is_us ? 'ins-us' : '') + '">' + escapeHtml(ch.label || ch.title) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      T.map(function (t) {
        return '<tr class="' + (t.gap ? 'ins-gap-row' : '') + '"><td><b>' + escapeHtml(t.name) + '</b>' + (t.gap ? ' <span class="ins-gap-tag">Gap</span>' : '') + '</td>' +
          '<td class="cmp-n"><span class="cmp-x' + (t.med >= 1.2 ? ' is-hot' : t.med != null && t.med < 0.8 ? ' is-cold' : '') + '">' + (t.med == null ? '-' : cmpX(t.med)) + '</span></td>' +
          cols.map(function (ch) { var n = t.by[ch.channel_id] || 0; return '<td class="cmp-n' + (ch.is_us ? ' ins-us' : '') + (n ? '' : ' ins-zero') + '">' + (n || '·') + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="field-hint" style="margin-top:8px;">Videos per topic per channel (topics are guessed from titles). "Works?" is how competitor videos on that topic usually did against their own channel\'s normal views. <b>Gap</b> = at least 3 competitor videos and none from TAAI.</div>';
    return insGapsShell(table);
  }
  function insGapsShell(inner) {
    var I = insState();
    return '<div class="ins-sec-head"><h3 class="cmp-h">Topic gaps</h3><div class="tabs cmp-period">' + [[30, '30 days'], [90, '90 days']].map(function (p) {
      return '<button type="button" class="tab-btn' + (I.gapDays === p[0] ? ' active' : '') + '" data-insgap="' + p[0] + '">' + p[1] + '</button>';
    }).join('') + '</div></div>' + inner;
  }
  // 4. When they post (IST), and which posting times do best.
  function insWhenHtml() {
    var c = state.comp, d = c.data;
    var chans = d.channels.filter(function (ch) { return ch.active; });
    var rows = cmpScored(30);
    var per = chans.map(function (ch) {
      var vids = rows.filter(function (r) { return r.v.channel_id === ch.channel_id && r.v.kind !== 'short'; });
      var shorts = rows.filter(function (r) { return r.v.channel_id === ch.channel_id && r.v.kind === 'short'; }).length;
      var wd = [0, 0, 0, 0, 0, 0, 0], bl = INS_BLOCKS.map(function () { return 0; });
      vids.forEach(function (r) { var t = insWeekdayHourIST(r.v.published_at); wd[t.wd]++; bl[insBlock(t.h)]++; });
      var top = function (arr, names) { var m = Math.max.apply(null, arr); return m ? names[arr.indexOf(m)] : '-'; };
      return { ch: ch, perWeek: vids.length / (30 / 7), shortsWeek: shorts / (30 / 7), day: top(wd, INS_DAYS), block: top(bl, INS_BLOCKS.map(function (b) { return b[2]; })) };
    }).sort(function (a, b) { return b.perWeek - a.perWeek; });
    var grid = INS_DAYS.map(function () { return INS_BLOCKS.map(function () { return []; }); });
    rows.forEach(function (r) {
      if (r.ch.is_us || !r.settled || r.score == null || r.v.kind === 'short') return;
      var t = insWeekdayHourIST(r.v.published_at); grid[t.wd][insBlock(t.h)].push(r.score);
    });
    var cell = function (arr) {
      if (arr.length < 2) return '<td class="ins-heat ins-heat-0">' + (arr.length ? '<span class="field-hint">1</span>' : '') + '</td>';
      var m = cmpMedian(arr.map(function (x) { return Math.round(x * 100); })) / 100;
      var lvl = m >= 1.5 ? 4 : m >= 1.15 ? 3 : m >= 0.85 ? 2 : 1;
      return '<td class="ins-heat ins-heat-' + lvl + '" title="' + arr.length + ' videos, typically ' + cmpX(m) + ' their usual">' + cmpX(m) + '<span>' + arr.length + '</span></td>';
    };
    return '<h3 class="cmp-h">When they post</h3>' +
      '<div class="students-table-wrap"><table class="students-table ins-when"><thead><tr><th>Channel</th><th>Videos / week</th><th>Shorts / week</th><th>Usual day</th><th>Usual time (IST)</th></tr></thead><tbody>' +
      per.map(function (p) {
        return '<tr class="' + (p.ch.is_us ? 'cmp-us' : '') + '"><td>' + escapeHtml(p.ch.label || p.ch.title) + (p.ch.is_us ? ' <span class="cmp-you">You</span>' : '') + '</td><td class="cmp-n">' + p.perWeek.toFixed(1) + '</td><td class="cmp-n">' + p.shortsWeek.toFixed(1) + '</td><td>' + p.day + '</td><td>' + p.block + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="field-hint" style="margin:14px 0 6px;">Which posting times did best: competitor videos (not Shorts) of the last 30 days by the day and time they went up, each cell showing how they did against their own channel\'s usual and how many there were. Green is better than usual.</div>' +
      '<div class="students-table-wrap"><table class="ins-heatmap"><thead><tr><th></th>' + INS_BLOCKS.map(function (b) { return '<th>' + b[2] + '</th>'; }).join('') + '</tr></thead><tbody>' +
      INS_DAYS.map(function (dn, i) { return '<tr><th>' + dn + '</th>' + grid[i].map(cell).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }
  // 6. Subscriber growth: daily counts the monitor records.
  function insGrowthHtml() {
    var c = state.comp, I = insState(), d = c.data;
    var names = {}; d.channels.forEach(function (ch) { names[ch.channel_id] = ch; });
    var by = {};
    (I.growth || []).forEach(function (r) { if (names[r[0]] && names[r[0]].active) (by[r[0]] = by[r[0]] || []).push({ day: r[1], subs: r[2] }); });
    var ids = Object.keys(by);
    var days = {}; ids.forEach(function (id) { by[id].forEach(function (p) { days[p.day] = 1; }); });
    var dayList = Object.keys(days).sort();
    var head = '<h3 class="cmp-h">Subscriber growth</h3>';
    if (dayList.length < 2) return head + '<div class="field-hint">Recorded once a day since the monitor started; the chart appears after two days of data.</div>';
    var gainIn = function (pts, n) {
      var last = pts[pts.length - 1], cut = new Date(Date.parse(last.day) - n * 86400000).toISOString().slice(0, 10);
      var base = null; pts.forEach(function (p) { if (p.day <= cut) base = p; });
      if (!base) base = pts[0];
      return base === last ? null : { gain: last.subs - base.subs, pct: base.subs ? (last.subs - base.subs) / base.subs * 100 : null, since: base.day };
    };
    var colors = ['#7C3AED', '#DB2777', '#2563EB', '#059669', '#D97706', '#0891B2', '#DC2626', '#4F46E5', '#65A30D', '#9333EA', '#EA580C', '#0D9488'];
    var series = ids.map(function (id, i) { return { ch: names[id], pts: by[id], color: names[id].is_us ? '#111' : colors[i % colors.length] }; });
    // % change since each channel's first recorded day, so big and small channels share one chart.
    var W = 640, H = 220, padL = 44, padB = 22, padT = 10, x0 = Date.parse(dayList[0]), x1 = Date.parse(dayList[dayList.length - 1]) || x0 + 1;
    var maxP = 0.5, minP = 0;
    series.forEach(function (s) { var b = s.pts[0].subs; s.pts.forEach(function (p) { p.pct = b ? (p.subs - b) / b * 100 : 0; maxP = Math.max(maxP, p.pct); minP = Math.min(minP, p.pct); }); });
    var X = function (day) { return padL + (Date.parse(day) - x0) / Math.max(1, x1 - x0) * (W - padL - 10); };
    var Y = function (p) { return padT + (maxP - p) / Math.max(0.01, maxP - minP) * (H - padT - padB); };
    var ticks = [minP, (minP + maxP) / 2, maxP];
    var svg = '<svg class="ins-growth-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Subscriber growth">' +
      ticks.map(function (t) { return '<line x1="' + padL + '" x2="' + (W - 10) + '" y1="' + Y(t) + '" y2="' + Y(t) + '" class="ins-grid"/><text x="' + (padL - 6) + '" y="' + (Y(t) + 4) + '" text-anchor="end" class="ins-axis">' + (t >= 0 ? '+' : '') + t.toFixed(t >= 10 ? 0 : 1) + '%</text>'; }).join('') +
      '<text x="' + padL + '" y="' + (H - 4) + '" class="ins-axis">' + escapeHtml(pirFmtDate(dayList[0])) + '</text><text x="' + (W - 10) + '" y="' + (H - 4) + '" text-anchor="end" class="ins-axis">' + escapeHtml(pirFmtDate(dayList[dayList.length - 1])) + '</text>' +
      series.map(function (s) { return '<polyline fill="none" stroke="' + s.color + '" stroke-width="' + (s.ch.is_us ? 3 : 2) + '" points="' + s.pts.map(function (p) { return X(p.day).toFixed(1) + ',' + Y(p.pct).toFixed(1); }).join(' ') + '"/>'; }).join('') + '</svg>';
    var table = series.map(function (s) {
      var last = s.pts[s.pts.length - 1], g7 = gainIn(s.pts, 7), g30 = gainIn(s.pts, 30);
      var f = function (g) { return g ? (g.gain >= 0 ? '+' : '') + cmpNum(g.gain) + (g.pct != null ? ' <span class="field-hint">(' + (g.pct >= 0 ? '+' : '') + g.pct.toFixed(2) + '%)</span>' : '') : '-'; };
      return { s: s, last: last, g7: g7, row: '<tr class="' + (s.ch.is_us ? 'cmp-us' : '') + '"><td><span class="ins-swatch" style="background:' + s.color + '"></span>' + escapeHtml(s.ch.label || s.ch.title) + '</td><td class="cmp-n">' + cmpNum(last.subs) + '</td><td class="cmp-n">' + f(g7) + '</td><td class="cmp-n">' + f(g30) + '</td></tr>' };
    }).sort(function (a, b) { return ((b.g7 && b.g7.pct) || 0) - ((a.g7 && a.g7.pct) || 0); });
    return head + '<div class="ins-growth">' + svg + '</div>' +
      '<div class="students-table-wrap"><table class="students-table"><thead><tr><th>Channel</th><th>Subscribers</th><th>Last 7 days</th><th>Last 30 days</th></tr></thead><tbody>' + table.map(function (t) { return t.row; }).join('') + '</tbody></table></div>' +
      '<div class="field-hint" style="margin-top:6px;">Lines show % growth since each channel\'s first recorded day (TAAI in black), so a small and a big channel can be compared. YouTube rounds public subscriber counts, so small channels move in steps. Data since ' + escapeHtml(pirFmtDate(dayList[0])) + '.</div>';
  }
  // 7. Thumbnail wall: the competitor videos that beat their usual the most.
  function insWallHtml() {
    var I = insState(), now = Date.now(), from = now - I.wallDays * 86400000;
    var list = cmpScored(30).filter(function (r) {
      return !r.ch.is_us && r.settled && r.score != null && Date.parse(r.v.published_at) >= from && (I.wallKind === 'short' ? r.v.kind === 'short' : r.v.kind !== 'short');
    }).sort(function (a, b) { return b.score - a.score; }).slice(0, 24);
    return '<div class="ins-sec-head"><h3 class="cmp-h">Thumbnail wall</h3><div class="ins-sec-tools">' +
      '<div class="tabs cmp-period">' + [['video', 'Videos'], ['short', 'Shorts']].map(function (p) { return '<button type="button" class="tab-btn' + (I.wallKind === p[0] ? ' active' : '') + '" data-inswallk="' + p[0] + '">' + p[1] + '</button>'; }).join('') + '</div>' +
      '<div class="tabs cmp-period">' + [[7, '7 days'], [30, '30 days']].map(function (p) { return '<button type="button" class="tab-btn' + (I.wallDays === p[0] ? ' active' : '') + '" data-inswall="' + p[0] + '">' + p[1] + '</button>'; }).join('') + '</div></div></div>' +
      '<div class="field-hint" style="margin-bottom:10px;">The competitor thumbnails behind the videos that most beat their channel\'s usual views: look for what they share (faces, text size, colours, numbers).</div>' +
      (list.length ? '<div class="ins-wall">' + list.map(function (r) {
        return '<a class="ins-thumb' + (r.v.kind === 'short' ? ' is-short' : '') + '" href="' + escapeHtml(insVideoLink(r.v.video_id, r.v.kind)) + '" target="_blank" rel="noopener" title="' + escapeHtml(r.v.title) + '">' +
          '<img loading="lazy" alt="" src="https://i.ytimg.com/vi/' + escapeHtml(r.v.video_id) + '/' + (r.v.kind === 'short' ? 'hqdefault' : 'mqdefault') + '.jpg">' +
          '<span class="ins-thumb-x">' + cmpX(r.score) + '</span><span class="ins-thumb-cap">' + escapeHtml(r.ch.label || r.ch.title) + ' · ' + cmpNum(r.v.views) + '</span></a>';
      }).join('') + '</div>' : '<div class="field-hint">No settled competitor videos in this period yet.</div>');
  }
  // 5. What students ask in competitor comments (Claude, on button press).
  function insCommentsHtml() {
    var I = insState(), days = I.cdays, doc = I.comments[days];
    var per = days === 1 ? '24 hours' : days + ' days';
    var btn = '<button type="button" class="btn btn-primary" id="ins-comments"' + (I.cBusy ? ' disabled' : '') + '>' + (I.cBusy ? 'Reading comments… (about a minute)' : (doc && !doc.error ? '↻ Read again' : '💬 Read their comments')) + '</button>';
    var body;
    if (doc === undefined) body = '<div class="field-hint">Loading…</div>';
    else if (doc && doc.error) body = '<div class="msg msg-error">Couldn\'t read comments: ' + escapeHtml(doc.error) + '</div>';
    else if (doc) {
      var kinds = { question: 'Questions', complaint: 'Complaints', request: 'Requests', praise: 'What they like' };
      body = '<div class="field-hint">Read ' + escapeHtml(cmpAgo(doc.generatedAt)) + ': ' + doc.comments + ' comments on ' + (doc.videos || []).length + ' competitor videos, grouped by Claude. Quotes are real comments.</div>' +
        '<p class="cmp-ideas-sum">' + escapeHtml(doc.summary) + '</p>' +
        '<div class="ins-cgroups">' + (doc.groups || []).slice().sort(function (a, b) { return b.mentions - a.mentions; }).map(function (g) {
          return '<div class="ins-cg ins-cg-' + escapeHtml(g.kind) + '"><div class="ins-cg-top"><span class="ins-cg-kind">' + escapeHtml(kinds[g.kind] || g.kind) + '</span><b>' + escapeHtml(g.theme) + '</b><span class="field-hint">~' + g.mentions + ' comments</span></div>' +
            (g.examples || []).map(function (e) { return '<div class="ins-cg-q">“' + escapeHtml(e) + '”</div>'; }).join('') +
            '<div class="ins-cg-angle"><b>For TAAI:</b> ' + escapeHtml(g.taai_angle) + '</div></div>';
        }).join('') + '</div>' +
        ((doc.videos || []).length ? '<details class="cmp-working"><summary>Videos read (' + doc.videos.length + ')</summary>' + doc.videos.map(function (v) { return '<div class="field-hint"><a href="https://www.youtube.com/watch?v=' + escapeHtml(v.video_id) + '" target="_blank" rel="noopener">' + escapeHtml(v.title) + '</a> · ' + escapeHtml(v.channel) + '</div>'; }).join('') + '</details>' : '');
    } else body = '<div class="field-hint">Press the button: it reads up to 40 top comments on each of the 15 competitor videos that did best in the last ' + per + ' and groups the repeated questions, complaints and requests, with how TAAI could answer each. Runs only when pressed (one Claude call).</div>';
    return '<div class="cmp-ideas-card"><div class="cmp-ideas-head"><h3 class="cmp-h" style="margin:0;">What students ask in their comments</h3><div class="ins-sec-tools">' +
      '<div class="tabs cmp-period">' + [[7, '7 days'], [30, '30 days']].map(function (p) { return '<button type="button" class="tab-btn' + (days === p[0] ? ' active' : '') + '" data-inscdays="' + p[0] + '">' + p[1] + '</button>'; }).join('') + '</div>' + btn + '</div></div>' +
      (I.cErr ? '<div class="msg msg-error">' + escapeHtml(I.cErr) + '</div>' : '') + body + '</div>';
  }
  function insReadComments() {
    var I = insState(), days = I.cdays;
    I.cBusy = true; I.cErr = null; render();
    api('/team-competitors', { method: 'POST', body: JSON.stringify({ action: 'comments', days: days }) }).then(function (r) {
      var since = Date.parse(r.at) - 5000, tries = 0;
      (function poll() {
        tries++;
        api('/team-competitors?comments=' + days).then(function (x) {
          var doc = x.comments;
          if (doc && Date.parse(doc.generatedAt) >= since) { I.comments[days] = doc; I.cBusy = false; render(); return; }
          if (tries >= 40) { I.cBusy = false; I.cErr = 'Still working after 3 minutes. Reload the page in a bit.'; render(); return; }
          setTimeout(poll, 5000);
        }).catch(function () { if (tries < 40) setTimeout(poll, 5000); else { I.cBusy = false; render(); } });
      })();
    }).catch(function (e) { I.cBusy = false; I.cErr = e.message; render(); });
  }
  function bindCmpInsights() {
    var I = insState();
    document.querySelectorAll('[data-insgap]').forEach(function (b) { b.addEventListener('click', function () { I.gapDays = +b.getAttribute('data-insgap'); render(); }); });
    document.querySelectorAll('[data-inswall]').forEach(function (b) { b.addEventListener('click', function () { I.wallDays = +b.getAttribute('data-inswall'); render(); }); });
    document.querySelectorAll('[data-inswallk]').forEach(function (b) { b.addEventListener('click', function () { I.wallKind = b.getAttribute('data-inswallk'); render(); }); });
    document.querySelectorAll('[data-inscdays]').forEach(function (b) { b.addEventListener('click', function () { I.cdays = +b.getAttribute('data-inscdays'); loadCmpComments(I.cdays); render(); }); });
    var cb = document.getElementById('ins-comments');
    if (cb) cb.addEventListener('click', insReadComments);
  }
  // 2. Price history and sale calendar (Websites tab): every saved snapshot's
  // offers; a plan's price is followed over time and each change listed.
  function loadWebHistory() {
    var w = state.web;
    if (w.hist || w.histLoading) return;
    w.histLoading = true;
    api('/team-web-watch?history=1').then(function (r) { w.hist = r.history || []; w.histLoading = false; render(); }).catch(function (e) { w.hist = []; w.histErr = e.message; w.histLoading = false; render(); });
  }
  function renderWebHistory(comps) {
    var w = state.web, d = w.data;
    if (!w.hist) { setTimeout(loadWebHistory, 0); return '<details class="cmp-manage" open><summary>Price history and sales</summary><div class="field-hint">Loading…</div></details>'; }
    var pageById = {}; d.pages.forEach(function (p) { pageById[p.id] = p; });
    var tracks = {};
    w.hist.forEach(function (snap) {
      var p = pageById[snap.page_id]; if (!p) return;
      if (w.comp !== 'all' && p.competitor !== w.comp) return;
      (snap.offers || []).forEach(function (o) {
        if (o.v !== 2 || o.source === 'text' || o.price == null) return;
        var k = p.competitor + '|' + [String(o.product).replace(/\s*\([^)]*\)/g, ''), o.plan, o.validity].join('|').toLowerCase();
        var t = tracks[k] = tracks[k] || { comp: p.competitor, o: o, pts: [] };
        var last = t.pts[t.pts.length - 1];
        if (!last || last.price !== o.price || last.mrp !== o.mrp) t.pts.push({ at: snap.taken_at, price: o.price, mrp: o.mrp, cur: webCur(o) });
        t.o = o;
      });
    });
    var events = [];
    Object.keys(tracks).forEach(function (k) {
      var t = tracks[k];
      for (var i = 1; i < t.pts.length; i++) {
        var a = t.pts[i - 1], b = t.pts[i];
        if (a.price === b.price) continue;
        if (a.cur !== b.cur) continue; // a rupee reading vs a dollar one is not a price change
        events.push({ t: t, at: b.at, from: a.price, to: b.price, mrp: b.mrp, cur: b.cur, pct: a.price ? (b.price - a.price) / a.price * 100 : null });
      }
    });
    events.sort(function (a, b) { return Date.parse(b.at) - Date.parse(a.at); });
    var firstSnap = w.hist.length ? w.hist[0].taken_at : null;
    var monthOf = function (iso) { return new Date(Date.parse(iso) + 5.5 * 3600000).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
    var byMonth = {}, order = [];
    events.forEach(function (e) { var m = monthOf(e.at); if (!byMonth[m]) { byMonth[m] = []; order.push(m); } byMonth[m].push(e); });
    var body = events.length ? order.map(function (m) {
      return '<div class="web-dayh">' + escapeHtml(m) + '</div>' + byMonth[m].map(function (e) {
        var o = e.t.o, detail = [o.plan, o.validity].filter(Boolean).join(' · ');
        var down = e.to < e.from;
        return '<div class="ins-pchg"><span class="ins-pdate">' + escapeHtml(pirFmtDate(new Date(Date.parse(e.at) + 5.5 * 3600000).toISOString().slice(0, 10))) + '</span>' +
          '<span class="ins-pwho"><b>' + escapeHtml(e.t.comp) + '</b> · ' + escapeHtml(o.product) + (detail ? ' <span class="field-hint">(' + escapeHtml(detail) + ')</span>' : '') + '</span>' +
          '<span class="ins-pmove ' + (down ? 'is-down' : 'is-up') + '">' + webRupees(e.from, e.cur) + ' → <b>' + webRupees(e.to, e.cur) + '</b>' + (e.pct != null ? ' (' + (down ? '' : '+') + e.pct.toFixed(0) + '%)' : '') + (down ? ' sale' : ' up') + '</span></div>';
      }).join('');
    }).join('') : '<div class="field-hint">No price changes recorded yet' + (firstSnap ? ' since ' + escapeHtml(pirFmtDate(firstSnap.slice(0, 10))) : '') + '. Prices are checked twice a day; every rise and drop will be listed here by month, so over the year this becomes their sale calendar (Diwali, New Year, results day).</div>';
    var changed = Object.keys(tracks).filter(function (k) { return tracks[k].pts.length > 1; }).length;
    return '<details class="cmp-manage" open><summary>Price history and sales</summary>' +
      '<div class="field-hint" style="margin:6px 0 8px;">Every change in what they charge, newest first, grouped by month. ' + Object.keys(tracks).length + ' plans followed' + (changed ? ', ' + changed + ' changed' : '') + '. Drops are marked as sales.</div>' +
      (w.histErr ? '<div class="msg msg-error">' + escapeHtml(w.histErr) + '</div>' : '') + body + '</details>';
  }
  function loadCmpSeason() {
    var c = state.comp;
    c.season = c.season || {};
    c.season.loading = true; render();
    api('/team-competitors?season=1').then(function (d) {
      c.season.data = d; c.season.loading = false; c.season.loaded = true; c.season.error = d.ready === false ? d.error : null; render();
    }).catch(function (e) { c.season.loading = false; c.season.loaded = true; c.season.error = e.message; render(); });
  }
  function seasonScored() {
    var c = state.comp, d = c.season.data;
    if (c.season.cache && c.season.cache.d === d) return c.season.cache.rows;
    var names = {}; d.channels.forEach(function (ch) { names[ch.channel_id] = ch; });
    var vids = d.videos.map(function (a) { return { channel_id: a[0], kind: a[1], date: a[2], t: Date.parse(a[2]), views: a[3] || 0, title: a[4] || '', video_id: a[5] }; })
      .filter(function (v) { return names[v.channel_id]; });
    var groups = {};
    vids.forEach(function (v) { var k = v.channel_id + '|' + v.kind; (groups[k] = groups[k] || []).push(v); });
    var W = 45 * 86400000;
    var rows = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k].sort(function (a, b) { return a.t - b.t; });
      var lo = 0, hi = 0;
      g.forEach(function (v) {
        while (g[lo].t < v.t - W) lo++;
        while (hi < g.length && g[hi].t <= v.t + W) hi++;
        var near = g.slice(lo, hi).map(function (x) { return x.views; });
        var base = near.length >= 4 ? cmpMedian(near) : null;
        rows.push({ v: v, ch: names[v.channel_id], score: base ? v.views / base : null, month: +v.date.slice(5, 7) - 1, year: +v.date.slice(0, 4) });
      });
    });
    c.season.cache = { d: d, rows: rows };
    return rows;
  }
  function seasonTopic(title) {
    for (var i = 0; i < CMP_TOPICS.length; i++) if (CMP_TOPICS[i][1].test(title)) return i;
    return CMP_TOPICS.length;
  }
  function renderCmpSeason() {
    var c = state.comp, S = c.season || {}, d = S.data;
    if (!S.loaded) return '<div class="card"><div class="field-hint">Loading…</div></div>';
    if (S.error && !d) return '<div class="card"><div class="msg msg-error">' + escapeHtml(S.error) + '</div></div>';
    if (!d || d.ready === false) return '<div class="card"><div class="msg msg-error">Not set up yet' + (S.error ? ': ' + escapeHtml(S.error) : '') + '</div></div>';
    var all = seasonScored();
    var kind = S.kind || 'video';
    var rows = all.filter(function (r) { return r.score != null && (kind === 'short' ? r.v.kind === 'short' : r.v.kind !== 'short'); });
    var theirs = rows.filter(function (r) { return !r.ch.is_us; });
    var perMonth = SEASON_MONTHS.map(function (_, m) { return all.filter(function (r) { return r.month === m; }).length; });
    var m = S.month != null ? S.month : (new Date(Date.now() + 5.5 * 3600000).getUTCMonth() + 1) % 12;
    var years = {}; all.forEach(function (r) { years[r.year] = 1; });
    var first = all.length ? all.reduce(function (a, r) { return r.v.t < a.v.t ? r : a; }) : null;
    var last = all.length ? all.reduce(function (a, r) { return r.v.t > a.v.t ? r : a; }) : null;
    var bf = d.lastBackfill;
    var head = '<div class="field-hint" style="margin-bottom:12px;">' +
      (all.length ? escapeHtml(all.length.toLocaleString('en-IN')) + ' videos from ' + escapeHtml(pirFmtDate(first.v.date)) + ' to ' + escapeHtml(pirFmtDate(last.v.date)) + '. ' : 'No videos old enough yet. ') +
      'Each video is scored against the same channel\'s videos of the same format posted within about six weeks of it, so 2.0× means it got twice what that channel was getting at that time. Videos join this view once they are 30 days old, and every year the months fill in more.</div>' +
      '<div class="season-load">' +
        (bf && !bf.error ? '<span class="field-hint">The past 12 months were loaded ' + escapeHtml(cmpAgo(bf.ran_at)) + ' (' + bf.videos + ' videos added).</span>' :
          '<span class="field-hint">' + (bf && bf.error ? 'Last load had a problem: ' + escapeHtml(bf.error) + '. ' : '') + 'Monitoring started in November 2026, so most months are empty until you load what the channels posted over the past year.</span>') +
        (d.keyReady ? '<button type="button" class="btn" id="season-backfill"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Loading the past year… (a few minutes)' : (bf && !bf.error ? '↻ Load again' : 'Load the past 12 months')) + '</button>' : '<span class="field-hint">Needs the YouTube API key.</span>') +
      '</div>' + (S.msg ? '<div class="msg ' + (S.msgType === 'error' ? 'msg-error' : 'msg-ok') + '">' + escapeHtml(S.msg) + '</div>' : '');
    var monthsBar = '<div class="season-months">' + SEASON_MONTHS.map(function (name, i) {
      return '<button type="button" class="season-m' + (i === m ? ' active' : '') + (perMonth[i] ? '' : ' is-empty') + '" data-seasonm="' + i + '"><b>' + name + '</b><span>' + (perMonth[i] ? perMonth[i] : '-') + '</span></button>';
    }).join('') + '</div>';
    var kindTabs = '<div class="tabs subtabs" style="margin:10px 0;"><button type="button" class="tab-btn' + (kind !== 'short' ? ' active' : '') + '" data-seasonkind="video">Videos</button><button type="button" class="tab-btn' + (kind === 'short' ? ' active' : '') + '" data-seasonkind="short">Shorts</button></div>';
    // The picked month
    var inM = theirs.filter(function (r) { return r.month === m; });
    var topics = CMP_TOPICS.map(function (t) { return { name: t[0], rows: [] }; }).concat([{ name: 'Other', rows: [] }]);
    inM.forEach(function (r) { topics[seasonTopic(r.v.title)].rows.push(r); });
    var trows = topics.filter(function (t) { return t.rows.length; }).map(function (t) {
      t.med = cmpMedian(t.rows.map(function (r) { return Math.round(r.score * 100); })) / 100;
      t.top = t.rows.slice().sort(function (a, b) { return b.score - a.score; })[0];
      return t;
    }).sort(function (a, b) { return b.med - a.med; });
    var link = function (v) { return 'https://www.youtube.com/' + (v.kind === 'short' ? 'shorts/' : 'watch?v=') + escapeHtml(v.video_id); };
    var when = function (r) { return SEASON_MONTHS[r.month] + ' ' + r.year; };
    var monthHtml = '<h3 class="cmp-h">' + SEASON_FULL[m] + ' <span class="field-hint">' + escapeHtml(SEASON_NOTES[m]) + '</span></h3>' +
      (trows.length ? '<table class="web-ptable cmp-topics"><thead><tr><th>Topic</th><th class="web-pr">Posted</th><th class="web-pr">Typical</th><th>Best one</th></tr></thead><tbody>' + trows.map(function (t) {
        return '<tr><td><b>' + escapeHtml(t.name) + '</b></td><td class="web-pr">' + t.rows.length + '</td><td class="web-pr"><span class="cmp-x' + (t.med >= 1.5 ? ' is-hot' : t.med < 1 ? ' is-cold' : '') + '">' + cmpX(t.med) + '</span></td>' +
          '<td class="cmp-topic-best"><a href="' + link(t.top.v) + '" target="_blank" rel="noopener">' + escapeHtml(t.top.v.title) + '</a><span class="field-hint"> · ' + escapeHtml(t.top.ch.label || t.top.ch.title) + ' · ' + when(t.top) + ' · ' + cmpX(t.top.score) + '</span></td></tr>';
      }).join('') + '</tbody></table>' : '<div class="field-hint">No competitor ' + (kind === 'short' ? 'Shorts' : 'videos') + ' from ' + SEASON_FULL[m] + ' yet' + (perMonth[m] ? ' in this format.' : (d.keyReady ? ': load the past 12 months above.' : '.')) + '</div>');
    var best = inM.slice().sort(function (a, b) { return b.score - a.score; }).slice(0, 10);
    if (best.length) monthHtml += '<h3 class="cmp-h">Best in ' + SEASON_FULL[m] + '</h3><div class="cmp-best-list">' + best.map(function (r, i) {
      return '<a class="cmp-best-row" href="' + link(r.v) + '" target="_blank" rel="noopener"><span class="cmp-best-n">' + (i + 1) + '</span>' +
        '<img loading="lazy" alt="" src="https://i.ytimg.com/vi/' + escapeHtml(r.v.video_id) + '/mqdefault.jpg">' +
        '<span class="cmp-best-body"><b>' + escapeHtml(r.v.title) + '</b><span class="field-hint">' + escapeHtml(r.ch.label || r.ch.title) + ' · ' + escapeHtml(pirFmtDate(r.v.date)) + ' · ' + cmpNum(r.v.views) + ' views</span></span>' +
        '<span class="cmp-x' + (r.score >= 2 ? ' is-hot' : r.score < 1 ? ' is-cold' : '') + '">' + cmpX(r.score) + '</span></a>';
    }).join('') + '</div>';
    var ours = rows.filter(function (r) { return r.ch.is_us && r.month === m; });
    if (ours.length) monthHtml += '<div class="field-hint" style="margin-top:8px;">Your ' + (kind === 'short' ? 'Shorts' : 'videos') + ' in ' + SEASON_FULL[m] + ': ' + ours.length + ', typically ' + cmpX(cmpMedian(ours.map(function (r) { return Math.round(r.score * 100); })) / 100) + '.</div>';
    // Topic × month grid
    var grid = topics.map(function (t, ti) {
      var cells = SEASON_MONTHS.map(function (_, mi) {
        var rs = theirs.filter(function (r) { return r.month === mi && seasonTopic(r.v.title) === ti; });
        return { n: rs.length, med: rs.length >= 3 ? cmpMedian(rs.map(function (r) { return Math.round(r.score * 100); })) / 100 : null };
      });
      return { name: t.name, cells: cells, n: cells.reduce(function (a, x) { return a + x.n; }, 0) };
    }).filter(function (t) { return t.n; });
    var gridHtml = '<h3 class="cmp-h">Topics through the year <span class="field-hint">competitor ' + (kind === 'short' ? 'Shorts' : 'videos') + ', typical score per month (3 or more videos)</span></h3>' +
      (grid.length ? '<div class="students-table-wrap"><table class="season-grid"><thead><tr><th>Topic</th>' + SEASON_MONTHS.map(function (n, i) { return '<th class="' + (i === m ? 'is-sel' : '') + '" data-seasonm="' + i + '">' + n + '</th>'; }).join('') + '</tr></thead><tbody>' +
        grid.map(function (t) {
          return '<tr><td><b>' + escapeHtml(t.name) + '</b></td>' + t.cells.map(function (x, i) {
            var cls = x.med == null ? 'is-none' : x.med >= 1.5 ? 'is-hot' : x.med >= 1.1 ? 'is-warm' : x.med < 0.8 ? 'is-cold' : '';
            return '<td class="' + cls + (i === m ? ' is-sel' : '') + '" title="' + x.n + ' video' + (x.n === 1 ? '' : 's') + '">' + (x.med == null ? (x.n ? '<span class="field-hint">' + x.n + '</span>' : '') : cmpX(x.med)) + '</td>';
          }).join('') + '</tr>';
        }).join('') +
        '<tr class="season-total"><td>Posted</td>' + SEASON_MONTHS.map(function (_, i) { var n = theirs.filter(function (r) { return r.month === i; }).length; return '<td class="' + (i === m ? 'is-sel' : '') + '">' + (n || '') + '</td>'; }).join('') + '</tr>' +
        '</tbody></table></div><div class="field-hint" style="margin-top:6px;">Green: that topic beats channels\' usual in that month; grey numbers are months with only 1 or 2 videos (too few to judge). Tap a month to see it above.</div>'
        : '<div class="field-hint">Nothing yet.</div>');
    return '<div class="card">' + head + monthsBar + kindTabs + monthHtml + gridHtml + '</div>';
  }
  function seasonBackfill() {
    var c = state.comp, S = c.season;
    S.busy = true; S.msg = null; render();
    api('/team-competitors', { method: 'POST', body: JSON.stringify({ action: 'backfill' }) }).then(function (r) {
      var since = Date.parse(r.at) - 5000, tries = 0;
      (function poll() {
        tries++;
        api('/team-competitors?season=1').then(function (d) {
          var bf = d.lastBackfill;
          if (bf && Date.parse(bf.ran_at) >= since) {
            S.data = d; S.cache = null; S.busy = false; S.msgType = bf.error ? 'error' : 'ok';
            S.msg = bf.error ? 'Loaded ' + bf.videos + ' videos, with problems: ' + bf.error : 'Loaded ' + bf.videos + ' videos from the past year (' + bf.units + ' API units).';
            render(); return;
          }
          if (tries >= 90) { S.busy = false; S.msgType = 'error'; S.msg = 'Still loading after 9 minutes. Reload the page in a bit.'; render(); return; }
          setTimeout(poll, 6000);
        }).catch(function () { if (tries < 90) setTimeout(poll, 6000); else { S.busy = false; render(); } });
      })();
    }).catch(function (e) { S.busy = false; S.msg = e.message; S.msgType = 'error'; render(); });
  }

  // ── Whole market (2026-11-25) ─────────────────────────────────────────
  // "A general idea about GATE CSE and GATE DA except our competitors and what
  // is working." Once a day yt-market.js searches YouTube for GATE CSE / DA
  // videos of the last 30 days from any channel (lib/yt-market.js); the
  // channels already tracked here (TAAI included) are left out.
  function loadCmpMarket() {
    var c = state.comp;
    c.market = c.market || { exam: 'all', period: 30, kind: 'video' };
    c.market.loading = true; render();
    api('/team-competitors?market=1').then(function (d) {
      c.market.data = d; c.market.loading = false; c.market.loaded = true; c.market.error = null; render();
    }).catch(function (e) { c.market.loading = false; c.market.loaded = true; c.market.error = e.message; render(); });
  }
  var MKT_EXAMS = [['all', 'GATE CSE + DA'], ['cse', 'GATE CSE'], ['da', 'GATE DA']];
  // Mirrors marketRelevant()/examOf() in netlify/functions/lib/yt-market.js
  // (title only here, which also cleans scans saved before the server filter).
  var MKT_DA = /\bDA\b|\bDS\s*&?\s*AI\b|\bDSAI\b|data science/;
  var MKT_DA_I = /data science/i, MKT_CSE = /\bCSE?\b|\bCS\s*[\/&-]?\s*IT\b|\bCSIT\b/, MKT_CSE_I = /computer science/i;
  var MKT_EXAMW = /\bGATE\s*['’]?\s*(20\d\d|\d\d)\b|\b(exam|preparation|prep|strategy|syllabus|IIT|M\.?\s?Tech|AIR|rank|mock|PYQs?|marks?|score|cutoff|lectures?|one\s*shot|topper|revision|test series|weightage|paper|admit card|result|crack|admission|PhD|PSU|aspirants?|worth it)\b/i;
  var MKT_OTHER = /\b(EE|ECE|EC|ME|CE|ESE|IES|AAI|JE|AE|ICAR|SSC|RRB|DSSSB|TGT|PGT)\b/;
  var MKT_OTHER_I = /\b(Civil|Mechanical|Electrical|Electronics|Chemical|Instrumentation|Signals|Control Systems?|Network Theory|Thermodynamics|Fluid Mechanics|Surveying|Agriculture|Biotechnology|Physics|Chemistry)\b/i;
  function mktExamOf(t) {
    var da = MKT_DA.test(t) || MKT_DA_I.test(t), cse = MKT_CSE.test(t) || MKT_CSE_I.test(t);
    return da && cse ? 'both' : da ? 'da' : cse ? 'cse' : 'gate';
  }
  function mktRelevant(v) {
    var t = v.title || '';
    if (!/\bGATE\b/.test(t)) return false;
    var ex = mktExamOf(t);
    if (ex === 'gate' && !MKT_EXAMW.test(t)) return false;
    if ((MKT_OTHER.test(t) || MKT_OTHER_I.test(t)) && ex === 'gate') return false;
    return true;
  }
  function mktRows() {
    var M = state.comp.market, d = M.data, mk = d.market, now = Date.now();
    var tracked = {}; (d.tracked || []).forEach(function (id) { tracked[id] = 1; });
    var from = now - M.period * 86400000;
    return mk.videos.filter(function (v) {
      if (tracked[v.channel_id] || Date.parse(v.published_at) < from) return false;
      if (!mktRelevant(v)) return false;
      // Exam from the title; scans saved before 2026-11-27 matched a lowercase
      // "da" in descriptions, so only their CSE tag is trusted as a fallback.
      var ex = mktExamOf(v.title || '');
      if (ex === 'gate' && v.exam === 'cse') ex = 'cse';
      if (M.exam === 'cse' && ex !== 'cse' && ex !== 'both') return false;
      if (M.exam === 'da' && ex !== 'da' && ex !== 'both') return false;
      return M.kind === 'short' ? v.kind === 'short' : v.kind !== 'short';
    }).map(function (v) {
      var ch = mk.channels[v.channel_id] || {};
      var age = Math.max(1, (now - Date.parse(v.published_at)) / 86400000);
      return { v: v, ch: ch, perDay: (v.views || 0) / age, ratio: ch.subs ? (v.views || 0) / ch.subs : null };
    });
  }
  function mktVideoRow(r, i, badge) {
    var v = r.v;
    return '<a class="cmp-best-row" href="https://www.youtube.com/' + (v.kind === 'short' ? 'shorts/' : 'watch?v=') + escapeHtml(v.id) + '" target="_blank" rel="noopener">' +
      '<span class="cmp-best-n">' + (i + 1) + '</span>' +
      '<img loading="lazy" alt="" src="https://i.ytimg.com/vi/' + escapeHtml(v.id) + '/mqdefault.jpg">' +
      '<span class="cmp-best-body"><b>' + escapeHtml(v.title) + '</b><span class="field-hint">' + escapeHtml(r.ch.title || 'Unknown channel') + (r.ch.subs != null ? ' (' + cmpNum(r.ch.subs) + ' subs)' : '') + ' · ' + escapeHtml(cmpAgo(v.published_at)) + ' · ' + cmpNum(v.views) + ' views</span></span>' +
      badge + '</a>';
  }
  function renderCmpMarket() {
    var c = state.comp, M = c.market || {}, d = M.data;
    if (!M.loaded) return '<div class="card"><div class="field-hint">Loading…</div></div>';
    if (M.error && !d) return '<div class="card"><div class="msg msg-error">' + escapeHtml(M.error) + '</div></div>';
    var mk = d && d.market;
    var scanBtn = d && d.keyReady ? '<button type="button" class="btn" id="mkt-scan"' + (M.busy ? ' disabled' : '') + '>' + (M.busy ? 'Scanning… (under a minute)' : '↻ Scan now') + '</button>' : '<span class="field-hint">Needs the YouTube API key.</span>';
    var msg = M.msg ? '<div class="msg ' + (M.msgType === 'error' ? 'msg-error' : 'msg-ok') + '">' + escapeHtml(M.msg) + '</div>' : '';
    if (!mk) return '<div class="card">' + msg + '<div class="season-load"><span class="field-hint">Every day this searches YouTube for GATE CSE and GATE DA videos from the last 30 days, from every channel except the ones you already track, so you can see what is working across the whole space. No scan yet.</span>' + scanBtn + '</div></div>';
    var rows = mktRows();
    var chans = {}; rows.forEach(function (r) { chans[r.v.channel_id] = 1; });
    var head = '<div class="season-load"><span class="field-hint">' + rows.length + ' ' + (M.kind === 'short' ? 'Shorts' : 'videos') + ' from ' + Object.keys(chans).length + ' channels that you don\'t track, found by YouTube searches for GATE CSE and GATE DA (' + mk.queries.length + ' searches, most viewed first, Indian results). Scanned ' + escapeHtml(cmpAgo(mk.scannedAt)) + '.' + (mk.errors && mk.errors.length ? ' Some searches failed: ' + escapeHtml(mk.errors.join('; ')) : '') + '</span>' + scanBtn + '</div>' + msg;
    var filters = '<div class="mkt-filters">' +
      '<div class="tabs subtabs">' + MKT_EXAMS.map(function (x) { return '<button type="button" class="tab-btn' + (M.exam === x[0] ? ' active' : '') + '" data-mktexam="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      '<div class="tabs subtabs">' + [[7, '7 days'], [30, '30 days']].map(function (x) { return '<button type="button" class="tab-btn' + (M.period === x[0] ? ' active' : '') + '" data-mktperiod="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      '<div class="tabs subtabs"><button type="button" class="tab-btn' + (M.kind !== 'short' ? ' active' : '') + '" data-mktkind="video">Videos</button><button type="button" class="tab-btn' + (M.kind === 'short' ? ' active' : '') + '" data-mktkind="short">Shorts</button></div>' +
    '</div>';
    if (!rows.length) return '<div class="card">' + head + filters + '<div class="field-hint">Nothing found for this filter.</div></div>';
    var link = function (v) { return 'https://www.youtube.com/' + (v.kind === 'short' ? 'shorts/' : 'watch?v=') + escapeHtml(v.id); };
    // Topics, by typical views per day; "vs audience" is views compared with the channel's subscribers.
    var topics = CMP_TOPICS.map(function (t) { return { name: t[0], rows: [] }; }).concat([{ name: 'Other', rows: [] }]);
    rows.forEach(function (r) { topics[seasonTopic(r.v.title)].rows.push(r); });
    var trows = topics.filter(function (t) { return t.rows.length; }).map(function (t) {
      t.med = cmpMedian(t.rows.map(function (r) { return r.perDay; }));
      var ratios = t.rows.map(function (r) { return r.ratio == null ? null : Math.round(r.ratio * 1000); }).filter(function (x) { return x != null; });
      t.ratio = ratios.length ? cmpMedian(ratios) / 1000 : null;
      t.top = t.rows.slice().sort(function (a, b) { return b.perDay - a.perDay; })[0];
      return t;
    }).sort(function (a, b) { return b.med - a.med; });
    var topicHtml = '<h3 class="cmp-h">What\'s working <span class="field-hint">grouped by title, best first</span></h3>' +
      '<table class="web-ptable cmp-topics"><thead><tr><th>Topic</th><th class="web-pr">Videos</th><th class="web-pr">Views / day</th><th>Best one</th></tr></thead><tbody>' + trows.map(function (t) {
        return '<tr><td><b>' + escapeHtml(t.name) + '</b>' + (t.ratio != null ? '<div class="field-hint">typically ' + (t.ratio >= 1 ? cmpX(t.ratio) + ' their subscribers' : Math.round(t.ratio * 100) + '% of their subscribers') + '</div>' : '') + '</td><td class="web-pr">' + t.rows.length + '</td><td class="web-pr"><b>' + cmpNum(t.med) + '</b></td>' +
          '<td class="cmp-topic-best"><a href="' + link(t.top.v) + '" target="_blank" rel="noopener">' + escapeHtml(t.top.v.title) + '</a><span class="field-hint"> · ' + escapeHtml(t.top.ch.title || '') + ' · ' + cmpNum(t.top.v.views) + ' views</span></td></tr>';
      }).join('') + '</tbody></table>' +
      '<div class="field-hint" style="margin-top:6px;">Views / day is the middle value for the topic\'s videos (views since upload, divided by days online). Under the topic: how those views compare with each channel\'s subscribers.</div>';
    var top = rows.slice().sort(function (a, b) { return b.perDay - a.perDay; }).slice(0, 12);
    var topHtml = '<h3 class="cmp-h">Most watched <span class="field-hint">by views per day</span></h3><div class="cmp-best-list">' + top.map(function (r, i) {
      return mktVideoRow(r, i, '<span class="cmp-x">' + cmpNum(r.perDay) + '/day</span>');
    }).join('') + '</div>';
    var small = rows.filter(function (r) { return r.ch.subs != null && r.ch.subs >= 500 && r.ch.subs <= 200000 && r.ratio >= 0.3; })
      .sort(function (a, b) { return b.ratio - a.ratio; }).slice(0, 10);
    var smallHtml = '<h3 class="cmp-h">Beating their size <span class="field-hint">channels under 2 L subscribers whose video reached far more people than usual</span></h3>' +
      (small.length ? '<div class="cmp-best-list">' + small.map(function (r, i) {
        return mktVideoRow(r, i, '<span class="cmp-x' + (r.ratio >= 1 ? ' is-hot' : '') + '" title="Views compared with the channel\'s subscribers">' + (r.ratio >= 1 ? cmpX(r.ratio) : Math.round(r.ratio * 100) + '%') + ' subs</span>');
      }).join('') + '</div><div class="field-hint" style="margin-top:6px;">A video whose views pass the channel\'s own subscriber count was pushed by YouTube to new people: the topic or title did the work, not the channel\'s size.</div>' : '<div class="field-hint">None in this filter.</div>');
    // Channels
    var byCh = {};
    rows.forEach(function (r) { var k = r.v.channel_id; (byCh[k] = byCh[k] || { id: k, ch: r.ch, rows: [], views: 0 }); byCh[k].rows.push(r); byCh[k].views += r.v.views || 0; });
    var chList = Object.keys(byCh).map(function (k) { return byCh[k]; }).sort(function (a, b) { return b.views - a.views; }).slice(0, 15);
    var chHtml = '<h3 class="cmp-h">Channels getting views <span class="field-hint">not tracked yet</span></h3>' +
      '<div class="students-table-wrap"><table class="students-table mkt-ch"><thead><tr><th>Channel</th><th class="cmp-n">Subs</th><th class="cmp-n">Videos</th><th class="cmp-n">Views</th><th></th></tr></thead><tbody>' + chList.map(function (x) {
        var best = x.rows.slice().sort(function (a, b) { return (b.v.views || 0) - (a.v.views || 0); })[0];
        return '<tr><td class="cmp-ch">' + (x.ch.thumbnail ? '<img src="' + escapeHtml(x.ch.thumbnail) + '" alt="" loading="lazy">' : '<span class="cmp-av">' + escapeHtml(String(x.ch.title || '?').charAt(0)) + '</span>') +
          '<div><a href="https://www.youtube.com/' + (x.ch.handle ? '@' + escapeHtml(x.ch.handle) : 'channel/' + escapeHtml(x.id)) + '" target="_blank" rel="noopener">' + escapeHtml(x.ch.title || x.id) + '</a><div class="field-hint">Top: ' + escapeHtml(best.v.title) + '</div></div></td>' +
          '<td class="cmp-n">' + cmpNum(x.ch.subs) + '</td><td class="cmp-n">' + x.rows.length + '</td><td class="cmp-n">' + cmpNum(x.views) + '</td>' +
          '<td><button type="button" class="btn btn-sm js-mkt-track" data-id="' + escapeHtml(x.id) + '" data-label="' + escapeHtml(x.ch.title || '') + '">+ Track</button></td></tr>';
      }).join('') + '</tbody></table></div><div class="field-hint" style="margin-top:6px;">+ Track adds the channel to the YouTube tab, so its videos are recorded from the next update and it drops out of this list.</div>';
    return '<div class="card">' + head + filters + topicHtml + topHtml + smallHtml + chHtml + '</div>';
  }
  function mktScan() {
    var M = state.comp.market;
    M.busy = true; M.msg = null; render();
    var before = M.data && M.data.market ? Date.parse(M.data.market.scannedAt) : 0;
    api('/team-competitors', { method: 'POST', body: JSON.stringify({ action: 'market' }) }).then(function () {
      var tries = 0;
      (function poll() {
        tries++;
        api('/team-competitors?market=1').then(function (d) {
          if (d.market && Date.parse(d.market.scannedAt) > before) {
            M.data = d; M.busy = false; M.msgType = 'ok';
            M.msg = 'Scanned: ' + d.market.videos.length + ' videos from ' + Object.keys(d.market.channels).length + ' channels (' + d.market.units + ' API units).';
            render(); return;
          }
          if (tries >= 40) { M.busy = false; M.msgType = 'error'; M.msg = 'Still scanning after 2 minutes. Reload the page in a bit.'; render(); return; }
          setTimeout(poll, 3000);
        }).catch(function () { if (tries < 40) setTimeout(poll, 3000); else { M.busy = false; render(); } });
      })();
    }).catch(function (e) { M.busy = false; M.msg = e.message; M.msgType = 'error'; render(); });
  }
  function cmpPost(body, okMsg) {
    var c = state.comp;
    c.busy = true; c.msg = null; render();
    return api('/team-competitors', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
      c.busy = false; c.msg = typeof okMsg === 'function' ? okMsg(r) : okMsg; c.msgType = 'ok';
      loadCompetitors();
    }).catch(function (e) { c.busy = false; c.msg = e.message; c.msgType = 'error'; render(); });
  }
  // Refresh runs in the background (2026-11-25: as a normal request it ran
  // past Netlify's ~10s limit and the button stuck on "Updating…"). Start
  // it, then re-read every 4 seconds until a run newer than the click shows
  // up, for at most 3 minutes.
  function cmpRefreshNow() {
    var c = state.comp;
    c.busy = true; c.msg = null; render();
    api('/team-competitors', { method: 'POST', body: JSON.stringify({ action: 'refresh' }) }).then(function (r) {
      var since = Date.parse(r.at) - 5000, tries = 0;
      (function poll() {
        tries++;
        api('/team-competitors').then(function (d) {
          var run = d.lastRun;
          if (run && Date.parse(run.ran_at) >= since) {
            c.data = d; c.busy = false; c.msgType = run.error ? 'error' : 'ok';
            c.msg = 'Updated ' + run.channels + ' channels and ' + run.videos + ' videos' + (run.source === 'rss' ? ' (public feeds only: no YouTube API key)' : '') + (run.error ? '. Problems: ' + run.error : '.');
            render(); return;
          }
          if (tries >= 45) { c.busy = false; c.msgType = 'error'; c.msg = 'Still updating after 3 minutes. Reload the page in a bit to see the new numbers.'; render(); return; }
          setTimeout(poll, 4000);
        }).catch(function () { if (tries < 45) setTimeout(poll, 4000); else { c.busy = false; render(); } });
      })();
    }).catch(function (e) { c.busy = false; c.msg = e.message; c.msgType = 'error'; render(); });
  }
  function bindCompetitors() {
    var c = state.comp;
    document.querySelectorAll('[data-cmpview]').forEach(function (b) {
      b.addEventListener('click', function () {
        c.view = b.getAttribute('data-cmpview');
        if (c.view === 'web' && !state.web.loaded && !state.web.loading) { loadWebWatch(); return; }
        if (c.view === 'season' && !(c.season && (c.season.loaded || c.season.loading))) { loadCmpSeason(); return; }
        if (c.view === 'market' && !(c.market && (c.market.loaded || c.market.loading))) { loadCmpMarket(); return; }
        if (c.view === 'insights') { loadCmpInsights(); render(); return; }
        render();
      });
    });
    if (c.view === 'web') { bindWebWatch(); return; }
    if (c.view === 'insights') { bindCmpInsights(); return; }
    if (c.view === 'market') {
      var M = c.market;
      document.querySelectorAll('[data-mktexam]').forEach(function (b) { b.addEventListener('click', function () { M.exam = b.getAttribute('data-mktexam'); render(); }); });
      document.querySelectorAll('[data-mktperiod]').forEach(function (b) { b.addEventListener('click', function () { M.period = +b.getAttribute('data-mktperiod'); render(); }); });
      document.querySelectorAll('[data-mktkind]').forEach(function (b) { b.addEventListener('click', function () { M.kind = b.getAttribute('data-mktkind'); render(); }); });
      var scan = document.getElementById('mkt-scan');
      if (scan) scan.addEventListener('click', mktScan);
      document.querySelectorAll('.js-mkt-track').forEach(function (b) {
        b.addEventListener('click', function () {
          b.disabled = true; b.textContent = 'Adding…';
          api('/team-competitors', { method: 'POST', body: JSON.stringify({ action: 'add', input: b.getAttribute('data-id'), label: b.getAttribute('data-label') }) }).then(function () {
            M.msg = 'Now tracking ' + b.getAttribute('data-label') + '. It shows in the YouTube tab after the next update.'; M.msgType = 'ok';
            if (M.data) M.data.tracked = (M.data.tracked || []).concat([b.getAttribute('data-id')]);
            render(); loadCompetitors();
          }).catch(function (e) { M.msg = e.message; M.msgType = 'error'; render(); });
        });
      });
      return;
    }
    if (c.view === 'season') {
      document.querySelectorAll('[data-seasonm]').forEach(function (b) { b.addEventListener('click', function () { c.season.month = +b.getAttribute('data-seasonm'); render(); }); });
      document.querySelectorAll('[data-seasonkind]').forEach(function (b) { b.addEventListener('click', function () { c.season.kind = b.getAttribute('data-seasonkind'); render(); }); });
      var bfb = document.getElementById('season-backfill');
      if (bfb) bfb.addEventListener('click', seasonBackfill);
      return;
    }
    document.querySelectorAll('[data-cmpperiod]').forEach(function (b) { b.addEventListener('click', function () { c.period = +b.getAttribute('data-cmpperiod'); c.vlimit = 40; render(); }); });
    document.querySelectorAll('[data-cmpsort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-cmpsort');
        if (c.sort === key) c.sortDir = -c.sortDir; else { c.sort = key; c.sortDir = key === 'name' ? 1 : -1; }
        render();
      });
    });
    var refresh = document.getElementById('cmp-refresh');
    if (refresh) refresh.addEventListener('click', cmpRefreshNow);
    document.querySelectorAll('[data-cmpbest]').forEach(function (b) { b.addEventListener('click', function () { c.bestKind = b.getAttribute('data-cmpbest'); render(); }); });
    var ideasBtn = document.getElementById('cmp-ideas');
    if (ideasBtn) ideasBtn.addEventListener('click', cmpMakeIdeas);
    if (c.loaded && c.data && c.data.ready !== false) loadCmpIdeas(c.period);
    [['cmp-vchannel', 'vchannel'], ['cmp-vkind', 'vkind'], ['cmp-vsort', 'vsort']].forEach(function (p) {
      var el = document.getElementById(p[0]);
      if (el) el.addEventListener('change', function () { c[p[1]] = el.value; c.vlimit = 40; render(); });
    });
    var vq = document.getElementById('cmp-vq');
    if (vq) {
      vq.addEventListener('change', function () { c.vq = vq.value.trim(); render(); });
      vq.addEventListener('keydown', function (e) { if (e.key === 'Enter') { c.vq = vq.value.trim(); render(); } });
    }
    var more = document.getElementById('cmp-more');
    if (more) more.addEventListener('click', function () { c.vlimit += 40; render(); });
    document.querySelectorAll('.js-cmp-toggle').forEach(function (b) {
      b.addEventListener('click', function () {
        var on = b.getAttribute('data-on') === '1';
        cmpPost({ action: on ? 'remove' : 'restore', channel_id: b.getAttribute('data-id') }, on ? 'Stopped monitoring that channel.' : 'Monitoring that channel again.');
      });
    });
    var add = document.getElementById('cmp-add');
    if (add) add.addEventListener('click', function () {
      var input = document.getElementById('cmp-add-input').value.trim();
      if (!input) return;
      cmpPost({ action: 'add', input: input, label: document.getElementById('cmp-add-label').value.trim() }, function (r) { return r.existed ? 'Already in the list, monitoring it.' : 'Added. Press Refresh now to fetch its numbers.'; });
    });
  }

  // ── Competitor websites (2026-11-25) ─────────────────────────────────
  // Their course pages are read twice a day by web-monitor.js
  // (lib/web-monitor.js): prices and offers, text added or removed, and new
  // pages in a sitemap. This shows what changed, today's prices and the list
  // of pages watched.
  var WEB_KINDS = {
    price: ['💰', 'Price'], offer_new: ['🆕', 'New offer'], offer_gone: ['❌', 'Offer removed'], text: ['✏️', 'Text'],
    title: ['🏷️', 'Title'], page_new: ['📄', 'New page'], page_gone: ['🗑️', 'Page removed'], error: ['⚠️', 'Problem']
  };
  var WEB_KIND_FILTERS = { all: null, price: ['price'], offers: ['offer_new', 'offer_gone'], text: ['text', 'title'], pages: ['page_new', 'page_gone'], error: ['error'] };
  var WEB_EXTRACTORS = [['text', 'Any page (text and ₹ prices)'], ['gfg', 'GeeksforGeeks course list'], ['pw', 'PW batch list'], ['sitemap', 'Sitemap (new and removed pages)']];
  function loadWebWatch() {
    var w = state.web;
    w.loading = true; w.error = null; render();
    api('/team-web-watch').then(function (d) {
      w.data = d; w.loaded = true; w.loading = false; w.error = d.ready === false ? d.error : null; render();
    }).catch(function (e) { w.loading = false; w.loaded = true; w.error = e.message; render(); });
  }
  function webDay(iso) {
    return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
  }
  function webTime(iso) {
    return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
  function webRupees(n, cur) { cur = cur || '₹'; return n == null ? '-' : cur + Number(n).toLocaleString(cur === '₹' ? 'en-IN' : 'en-US'); }
  // GfG serves prices in the visitor's currency, and the checks run on
  // Netlify's US servers, so its prices are in dollars (cents give old
  // readings away: 119.98). Rupee prices never have cents.
  function webCur(o) { return (o && o.currency) || (o && o.price != null && o.price % 1 !== 0 ? '$' : '₹'); }
  // "At a glance" (2026-11-27, "a brief overview of what changed"): per
  // competitor, the period's price cuts and rises, new and removed offers,
  // and text edits, from the same cleaned feed (no noise, no minor edits).
  function renderWebGlance(d, pages, comps) {
    var w = state.web, days = w.glance || 7, from = Date.now() - days * 86400000;
    var dayOf = function (iso) { return pirFmtDate(new Date(Date.parse(iso) + 5.5 * 3600000).toISOString().slice(0, 10)); };
    var by = {};
    d.changes.forEach(function (c) {
      var p = pages[c.page_id];
      if (!p || c.noise || c.minor || Date.parse(c.detected_at) < from) return;
      var g = by[p.competitor] = by[p.competitor] || { cuts: [], rises: [], added: [], removed: [], text: 0, textPages: {}, days: {} };
      g.days[dayOf(c.detected_at)] = 1;
      if (c.kind === 'price' && c.price) (c.price.to < c.price.from ? g.cuts : g.rises).push(c.price);
      else if (c.kind === 'offer_new') g.added.push(c.offer || { name: c.summary.replace(/^New: /, '') });
      else if (c.kind === 'offer_gone') g.removed.push(c.offer || { name: c.summary.replace(/^Gone: /, '') });
      else if (c.kind === 'text' || c.kind === 'title') { g.text++; g.textPages[p.label || p.url] = 1; }
    });
    var pct = function (x) { return x.from ? Math.round(Math.abs(x.to - x.from) / x.from * 100) : null; };
    var priceLine = function (arr, word) {
      var ps = arr.map(pct).filter(function (v) { return v != null; });
      var lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
      var range = !ps.length ? '' : lo === hi ? ' by ' + hi + '%' : ' by ' + lo + '-' + hi + '%';
      var ex = arr[0];
      return word + ' ' + arr.length + ' price' + (arr.length === 1 ? '' : 's') + range + ' (e.g. ' + escapeHtml(ex.name) + ': ' + webRupees(ex.from, ex.cur) + ' → ' + webRupees(ex.to, ex.cur) + ')';
    };
    var names = function (arr) { return arr.slice(0, 3).map(function (o) { return escapeHtml(o.name); }).join('; ') + (arr.length > 3 ? ' and ' + (arr.length - 3) + ' more' : ''); };
    var active = comps.filter(function (c) { return by[c]; });
    var quiet = comps.filter(function (c) { return !by[c]; });
    var problems = d.pages.filter(function (p) { return p.active && p.last_error; });
    var body = active.map(function (c) {
      var g = by[c], bits = [];
      if (g.cuts.length) bits.push('<span class="web-down">' + priceLine(g.cuts, 'Cut') + '</span>');
      if (g.rises.length) bits.push('<span class="web-up">' + priceLine(g.rises, 'Raised') + '</span>');
      if (g.added.length) bits.push('New: ' + names(g.added));
      if (g.removed.length) bits.push('Removed: ' + names(g.removed));
      if (g.text) bits.push('Wording changed on ' + Object.keys(g.textPages).map(escapeHtml).join(', '));
      var when = Object.keys(g.days);
      return '<div class="web-glance-row"><b>' + escapeHtml(c) + '</b><span class="field-hint"> · ' + escapeHtml(when.length > 2 ? when.length + ' days' : when.join(', ')) + '</span><ul>' + bits.map(function (b) { return '<li>' + b + '</li>'; }).join('') + '</ul></div>';
    }).join('');
    var usd = d.changes.some(function (c) { return !c.noise && c.price && c.price.cur && c.price.cur !== '₹' && Date.parse(c.detected_at) >= from; });
    return '<div class="web-glance"><div class="ins-sec-head" style="margin-top:0;"><h3 class="cmp-h">At a glance</h3><div class="tabs cmp-period">' +
      [[7, '7 days'], [30, '30 days'], [90, '90 days']].map(function (x) { return '<button type="button" class="tab-btn' + (days === x[0] ? ' active' : '') + '" data-webglance="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div></div>' +
      (active.length ? body : '<div class="field-hint">Nothing changed on their pages in the last ' + days + ' days.</div>') +
      (active.length && quiet.length ? '<div class="field-hint" style="margin-top:6px;">No changes: ' + quiet.map(escapeHtml).join(', ') + '.</div>' : '') +
      (problems.length ? '<div class="field-hint web-glance-prob">⚠️ Couldn\'t read: ' + problems.map(function (p) { return escapeHtml(p.competitor + ' ' + (p.label || '')) + ' (' + escapeHtml(p.last_error) + ')'; }).join('; ') + '</div>' : '') +
      (usd ? '<div class="field-hint" style="margin-top:6px;">GfG shows prices in US dollars to our checker (it runs on servers outside India); the % changes are the same in rupees.</div>' : '') +
      '</div>';
  }
  function renderWebWatch() {
    var w = state.web, d = w.data;
    if (w.loading && !w.loaded) return '<div class="card"><div class="field-hint">Loading…</div></div>';
    if (!d || d.ready === false) return '<div class="card"><div class="msg msg-error">Not set up yet: the developer needs to run the website watcher SQL first.' + (w.error ? ' (' + escapeHtml(w.error) + ')' : '') + '</div></div>';
    var pages = {}; d.pages.forEach(function (p) { pages[p.id] = p; });
    var comps = []; d.pages.forEach(function (p) { if (comps.indexOf(p.competitor) === -1) comps.push(p.competitor); });
    var lastCheck = d.pages.reduce(function (a, p) { return p.last_checked_at && (!a || p.last_checked_at > a) ? p.last_checked_at : a; }, null);
    var head = '<div class="cmp-head"><div class="field-hint">Their course pages are read twice a day. Prices, new or removed offers, text changes and new pages show up below.' +
      (lastCheck ? ' Last check ' + escapeHtml(cmpAgo(lastCheck)) + '.' : ' Not checked yet: press Check now.') + '</div>' +
      '<div class="cmp-head-actions"><button type="button" class="btn" id="web-check"' + (w.busy ? ' disabled' : '') + '>' + (w.busy ? 'Checking…' : '↻ Check now') + '</button></div></div>';
    var opt = function (v, l, cur) { return '<option value="' + escapeHtml(v) + '"' + (cur === v ? ' selected' : '') + '>' + escapeHtml(l) + '</option>'; };
    var kinds = WEB_KIND_FILTERS[w.kind];
    var hiddenNoise = 0, hiddenMinor = 0;
    var list = d.changes.filter(function (c) {
      var p = pages[c.page_id];
      if (!p) return false;
      if (c.noise) { hiddenNoise++; return false; }
      if (c.minor && !w.showMinor) { hiddenMinor++; return false; }
      if (w.comp !== 'all' && p.competitor !== w.comp) return false;
      if (kinds && kinds.indexOf(c.kind) === -1) return false;
      return true;
    });
    var shown = list.slice(0, w.limit), lastDay = null;
    var feed = shown.map(function (c) {
      var p = pages[c.page_id], k = WEB_KINDS[c.kind] || ['•', c.kind];
      var day = webDay(c.detected_at), dh = '';
      if (day !== lastDay) { dh = '<div class="web-day">' + escapeHtml(day) + '</div>'; lastDay = day; }
      var canOpen = c.kind === 'text' || c.kind === 'title';
      var det = w.details[c.id], open = w.open[c.id];
      var body = '';
      if (open) {
        if (!det) body = '<div class="field-hint">Loading…</div>';
        else if (det.error) body = '<div class="msg msg-error">' + escapeHtml(det.error) + '</div>';
        else {
          var x = det.detail || {};
          if (c.kind === 'title') body = '<div class="web-diff"><div class="web-del">' + escapeHtml(x.from || '') + '</div><div class="web-add">' + escapeHtml(x.to || '') + '</div></div>';
          else body = '<div class="web-diff">' + (x.added || []).map(function (l) { return '<div class="web-add">' + escapeHtml(l) + '</div>'; }).join('') +
            (x.removed || []).map(function (l) { return '<div class="web-del">' + escapeHtml(l) + '</div>'; }).join('') + '</div>';
        }
      }
      return dh + '<div class="web-chg web-k-' + escapeHtml(c.kind) + '">' +
        '<span class="web-ico" title="' + escapeHtml(k[1]) + '">' + k[0] + '</span>' +
        '<div class="web-chg-main"><div class="web-chg-top"><span class="web-comp">' + escapeHtml(p.competitor) + '</span> · <a href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener">' + escapeHtml(p.label || p.url) + '</a><span class="field-hint"> · ' + escapeHtml(webTime(c.detected_at)) + '</span></div>' +
        '<div class="web-sum">' + (c.price ? escapeHtml(c.price.name) + ': ' + webRupees(c.price.from, c.price.cur) + ' → <b>' + webRupees(c.price.to, c.price.cur) + '</b>' +
          (c.price.from ? ' <span class="' + (c.price.to < c.price.from ? 'web-down' : 'web-up') + '">(' + (c.price.to < c.price.from ? '' : '+') + Math.round((c.price.to - c.price.from) / c.price.from * 100) + '%)</span>' : '') : escapeHtml(c.summary)) +
          (c.minor ? ' <span class="web-minor">minor</span>' : '') + '</div>' +
        (canOpen ? '<button type="button" class="link-btn js-web-open" data-id="' + c.id + '">' + (open ? 'Hide' : 'Show what changed') + '</button>' : '') + body +
        '</div></div>';
    }).join('');
    var hiddenNote = (hiddenNoise || hiddenMinor) ? '<div class="field-hint web-hidden-note">' +
      (hiddenNoise ? hiddenNoise + ' unreliable entr' + (hiddenNoise === 1 ? 'y' : 'ies') + ' hidden (bad reads, rating counts, menus). ' : '') +
      (hiddenMinor ? '<button type="button" class="link-btn" id="web-minor">Show ' + hiddenMinor + ' minor edit' + (hiddenMinor === 1 ? '' : 's') + '</button>' : (w.showMinor ? '<button type="button" class="link-btn" id="web-minor">Hide minor edits</button>' : '')) + '</div>' : '';
    var changes = renderWebGlance(d, pages, comps) + '<h3 class="cmp-h">What changed <span class="field-hint">last 90 days</span></h3>' +
      '<div class="chal-toolbar cmp-vtools"><select id="web-comp">' + opt('all', 'All competitors', w.comp) + comps.map(function (c) { return opt(c, c, w.comp); }).join('') + '</select>' +
      '<select id="web-kind">' + opt('all', 'All changes', w.kind) + opt('price', 'Prices', w.kind) + opt('offers', 'New and removed offers', w.kind) + opt('text', 'Text', w.kind) + opt('pages', 'New and removed pages', w.kind) + opt('error', 'Problems', w.kind) + '</select></div>' +
      hiddenNote + (shown.length ? '<div class="web-feed">' + feed + '</div>' + (list.length > shown.length ? '<button type="button" class="btn" id="web-more" style="margin-top:10px;">Show more (' + (list.length - shown.length) + ' left)</button>' : '')
        : '<div class="field-hint">Nothing yet. Each page\'s first check is its starting point; changes show up from the next check on.</div>');
    return '<div class="card">' +
      (w.msg ? '<div class="msg ' + (w.msgType === 'error' ? 'msg-error' : 'msg-ok') + '">' + escapeHtml(w.msg) + '</div>' : '') +
      head + changes + renderWebPrices(pages, comps) + renderWebHistory(comps) + renderWebPages(comps) + '</div>';
  }
  // One table per competitor: each course / batch with its plan and
  // validity, the price they charge, the struck-out price and % off. The same
  // plan shown on several of their pages is listed once. Prices only guessed
  // from page text (no data on the page) are kept apart, folded away.
  function renderWebPrices(pages, comps) {
    var w = state.web, d = w.data;
    var blocks = comps.filter(function (c) { return w.comp === 'all' || w.comp === c; }).map(function (comp) {
      var seen = {}, rows = [], rough = [];
      d.pages.forEach(function (p) {
        if (p.competitor !== comp || !p.active || !d.offers[p.id]) return;
        d.offers[p.id].list.forEach(function (o) {
          if (o.v !== 2) return;
          if (o.source === 'text') { rough.push({ o: o, p: p }); return; }
          // "GATE DA 2027 Core (Till Feb 2027)" and "GATE DA 2027 Core" at the same price are one plan.
          var k = [String(o.product).replace(/\s*\([^)]*\)/g, ''), o.plan, o.price].join('|').toLowerCase();
          if (seen[k]) { if (!seen[k].o.validity && o.validity) seen[k].o = o; return; }
          seen[k] = { o: o, p: p }; rows.push(seen[k]);
        });
      });
      if (!rows.length && !rough.length) return '';
      var row = function (r) {
        var o = r.o, off = o.price && o.mrp && o.mrp > o.price ? Math.round((1 - o.price / o.mrp) * 100) : null;
        var detail = [o.plan, o.validity].filter(Boolean).join(' · ');
        return '<tr><td><div class="web-prod">' + (o.url ? '<a href="' + escapeHtml(o.url) + '" target="_blank" rel="noopener">' + escapeHtml(o.product) + '</a>' : escapeHtml(o.product)) + '</div>' +
          (detail ? '<div class="web-plan">' + escapeHtml(detail) + '</div>' : '') + '</td>' +
          '<td class="web-pr">' + (o.price ? '<b>' + webRupees(o.price, webCur(o)) + '</b>' : o.price === 0 ? '<b>Free</b>' : '<span class="field-hint">Not listed</span>') +
          (o.mrp ? '<div class="web-mrp"><s>' + webRupees(o.mrp, webCur(o)) + '</s>' + (off ? ' <span class="web-off">' + off + '% off</span>' : '') + '</div>' : '') + '</td></tr>';
      };
      var srcPages = []; rows.forEach(function (r) { if (srcPages.indexOf(r.p) === -1) srcPages.push(r.p); });
      return '<div class="web-pcomp"><div class="web-pcomp-h"><b>' + escapeHtml(comp) + '</b><span class="field-hint"> · from ' + srcPages.map(function (p) { return '<a href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener">' + escapeHtml(p.label || p.url) + '</a>'; }).join(', ') + '</span></div>' +
        (rows.length ? '<table class="web-ptable"><thead><tr><th>Course / batch and plan</th><th class="web-pr">Price</th></tr></thead><tbody>' + rows.map(row).join('') + '</tbody></table>' : '') +
        (rough.length ? '<details class="web-rough"><summary>' + rough.length + ' other price mention' + (rough.length === 1 ? '' : 's') + ' found in page text (no course data on those pages)</summary><table class="web-ptable"><tbody>' + rough.map(row).join('') + '</tbody></table></details>' : '') +
      '</div>';
    }).join('');
    return '<details class="cmp-manage" open><summary>Their prices now</summary>' +
      '<div class="field-hint" style="margin-top:6px;">The price each competitor charges today, read from their own course data: GATE Wallah and GfG batch lists, GO Classes course plans, The ML Hub\'s published plans. Struck-out is their listed MRP. GO Classes and The ML Hub say their prices include GST.</div>' +
      (blocks || '<div class="field-hint">No prices read yet: press Check now.</div>') + '</details>';
  }
  function renderWebPages(comps) {
    var w = state.web, d = w.data;
    var kindLabel = {}; WEB_EXTRACTORS.forEach(function (x) { kindLabel[x[0]] = x[1]; });
    return '<details class="cmp-manage"><summary>Pages watched (' + d.pages.filter(function (p) { return p.active; }).length + ')</summary>' +
      '<div class="cmp-chlist">' + d.pages.map(function (p) {
        return '<div class="cmp-chrow' + (p.active ? '' : ' is-off') + '"><span><b>' + escapeHtml(p.competitor) + '</b> · <a href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener">' + escapeHtml(p.label || p.url) + '</a>' +
          '<span class="field-hint"> · ' + escapeHtml(kindLabel[p.extractor] || p.extractor) +
          (p.last_checked_at ? ' · checked ' + escapeHtml(cmpAgo(p.last_checked_at)) + (p.last_count != null ? ' · ' + p.last_count + (p.extractor === 'sitemap' ? ' pages' : ' prices') : '') : ' · not checked yet') + '</span>' +
          (p.last_error ? '<span class="web-err"> ⚠️ ' + escapeHtml(p.last_error) + '</span>' : '') + (p.active ? '' : ' <span class="field-hint">(stopped)</span>') + '</span>' +
          '<span class="web-row-btns">' + (p.active ? '<button type="button" class="btn btn-small js-web-checkone" data-id="' + p.id + '"' + (w.busy ? ' disabled' : '') + '>Check</button>' : '') +
          '<button type="button" class="btn btn-small js-web-toggle" data-id="' + p.id + '" data-on="' + (p.active ? '1' : '0') + '">' + (p.active ? 'Stop' : 'Watch again') + '</button></span></div>';
      }).join('') + '</div>' +
      '<div class="web-add-form">' +
        '<input type="text" id="web-add-comp" list="web-comp-list" placeholder="Whose page (e.g. GO Classes)"><datalist id="web-comp-list">' + comps.map(function (c) { return '<option value="' + escapeHtml(c) + '">'; }).join('') + '</datalist>' +
        '<input type="text" id="web-add-label" placeholder="Short name (optional)">' +
        '<input type="url" id="web-add-url" placeholder="https://… page link">' +
        '<select id="web-add-kind">' + WEB_EXTRACTORS.map(function (x) { return '<option value="' + x[0] + '">' + escapeHtml(x[1]) + '</option>'; }).join('') + '</select>' +
        '<input type="text" id="web-add-match" placeholder="Only names containing (optional)">' +
        '<button type="button" class="btn btn-primary" id="web-add"' + (w.busy ? ' disabled' : '') + '>Add page</button>' +
      '</div>' +
      '<div class="field-hint">A new page is read once straight away to get its starting point. "Only names containing" is for course lists and sitemaps, e.g. DA or gate-da. Some sites (Unacademy) block automated visits and can\'t be watched. Stopping keeps the history.</div>' +
    '</details>';
  }
  function webPost(body, okMsg) {
    var w = state.web;
    w.busy = true; w.msg = null; render();
    return api('/team-web-watch', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
      w.busy = false; w.msg = typeof okMsg === 'function' ? okMsg(r) : okMsg; w.msgType = 'ok';
      loadWebWatch();
    }).catch(function (e) { w.busy = false; w.msg = e.message; w.msgType = 'error'; render(); });
  }
  function webCheckMsg(r) {
    return 'Checked ' + r.checked + ' page' + (r.checked === 1 ? '' : 's') + (r.changed ? ', ' + r.changed + ' with changes' : ', no changes') +
      (r.skipped ? '. ' + r.skipped + ' left for the next run' : '') + (r.error ? '. Problems: ' + r.error : '.');
  }
  // All pages are read in the background (see cmpRefreshNow); wait until
  // every active page has been checked since the click, at most 3 minutes.
  function webCheckAll() {
    var w = state.web;
    w.busy = true; w.msg = null; render();
    api('/team-web-watch', { method: 'POST', body: JSON.stringify({ action: 'check' }) }).then(function (r) {
      var since = Date.parse(r.at) - 5000, tries = 0;
      (function poll() {
        tries++;
        api('/team-web-watch').then(function (d) {
          var act = d.pages.filter(function (p) { return p.active; });
          var done = act.filter(function (p) { return p.last_checked_at && Date.parse(p.last_checked_at) >= since; });
          if (done.length === act.length || tries >= 45) {
            var changes = (d.changes || []).filter(function (c) { return Date.parse(c.detected_at) >= since && c.kind !== 'error'; }).length;
            var failed = done.filter(function (p) { return p.last_error; });
            w.data = d; w.busy = false; w.msgType = failed.length || done.length < act.length ? 'error' : 'ok';
            w.msg = done.length < act.length ? 'Still checking after 3 minutes (' + done.length + ' of ' + act.length + ' pages done). Reload the page in a bit.'
              : 'Checked ' + act.length + ' pages: ' + (changes ? changes + ' change' + (changes === 1 ? '' : 's') + ' found' : 'no changes') + (failed.length ? '. Could not read: ' + failed.map(function (p) { return p.label || p.url; }).join(', ') : '.');
            render(); return;
          }
          setTimeout(poll, 4000);
        }).catch(function () { if (tries < 45) setTimeout(poll, 4000); else { w.busy = false; render(); } });
      })();
    }).catch(function (e) { w.busy = false; w.msg = e.message; w.msgType = 'error'; render(); });
  }
  function bindWebWatch() {
    var w = state.web;
    var chk = document.getElementById('web-check');
    if (chk) chk.addEventListener('click', webCheckAll);
    [['web-comp', 'comp'], ['web-kind', 'kind']].forEach(function (p) {
      var el = document.getElementById(p[0]);
      if (el) el.addEventListener('change', function () { w[p[1]] = el.value; w.limit = 60; render(); });
    });
    document.querySelectorAll('[data-webglance]').forEach(function (b) { b.addEventListener('click', function () { state.web.glance = +b.getAttribute('data-webglance'); render(); }); });
    var minorBtn = document.getElementById('web-minor');
    if (minorBtn) minorBtn.addEventListener('click', function () { state.web.showMinor = !state.web.showMinor; render(); });
    var more = document.getElementById('web-more');
    if (more) more.addEventListener('click', function () { w.limit += 60; render(); });
    document.querySelectorAll('.js-web-open').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-id');
        w.open[id] = !w.open[id];
        if (w.open[id] && !w.details[id]) {
          api('/team-web-watch?change=' + encodeURIComponent(id)).then(function (r) { w.details[id] = r.change || { error: 'Not found' }; render(); })
            .catch(function (e) { w.details[id] = { error: e.message }; render(); });
        }
        render();
      });
    });
    document.querySelectorAll('.js-web-checkone').forEach(function (b) {
      b.addEventListener('click', function () { webPost({ action: 'check', id: b.getAttribute('data-id') }, webCheckMsg); });
    });
    document.querySelectorAll('.js-web-toggle').forEach(function (b) {
      b.addEventListener('click', function () {
        var on = b.getAttribute('data-on') === '1';
        webPost({ action: on ? 'remove' : 'restore', id: b.getAttribute('data-id') }, on ? 'Stopped watching that page.' : 'Watching that page again.');
      });
    });
    var add = document.getElementById('web-add');
    if (add) add.addEventListener('click', function () {
      var url = document.getElementById('web-add-url').value.trim();
      var comp = document.getElementById('web-add-comp').value.trim();
      if (!url || !comp) { w.msg = 'Fill in whose page it is and its link.'; w.msgType = 'error'; render(); return; }
      webPost({ action: 'add', url: url, competitor: comp, label: document.getElementById('web-add-label').value.trim(), extractor: document.getElementById('web-add-kind').value, match: document.getElementById('web-add-match').value.trim() },
        function (r) { return r.existed ? 'Already in the list, watching it.' : 'Added and read once' + (r.check && r.check.error ? ', but: ' + r.check.error : '.'); });
    });
  }

  // ── 2 AM Club winner popup (2026-11-18) ──────────────────────────────
  // Name, up to two photos (desk setup + LinkedIn picture), prize and the
  // LinkedIn post. Between the two dates (IST) every tracker visitor sees it
  // once, with confetti. Photos are shrunk in the browser to a JPEG of at
  // most 1400px before saving. Preview opens the real tracker popup with
  // the form as it is now (kept in this browser only), saved or not.
  function cwDefaultForm() {
    return { enabled: false, name: '', month: 'November', prize: 5000, linkedin_text: '', linkedin_url: '', headline: '', avatar: null, show_from: '', show_until: '',
      photos: [{ src: '', caption: 'Desk setup' }, { src: '', caption: 'LinkedIn post' }] };
  }
  function loadClubWinner() {
    var cw = state.clubWinner;
    if (cw.loaded || cw.loading) return;
    cw.loading = true; render();
    api('/team-club-winner').then(function (d) {
      var f = cwDefaultForm();
      if (d.winner) {
        Object.keys(f).forEach(function (k) { if (k !== 'photos' && d.winner[k] !== undefined && d.winner[k] !== null) f[k] = d.winner[k]; });
        (d.winner.photos || []).forEach(function (p, i) { if (i < 2) f.photos[i] = { src: p.src || '', caption: p.caption || '' }; });
      }
      cw.form = f; cw.savedEnabled = !!f.enabled; cw.updatedAt = d.updated_at; cw.loaded = true;
      if (f.show_from) f.show_from = ''; // start dates aren't used any more (manual only)
    }).catch(function (e) {
      cw.form = cwDefaultForm(); cw.loaded = true;
      cw.msg = /club_winner/.test(e.message) ? 'The club_winner table doesn\'t exist yet. Run the SQL at the end of supabase/schema.sql, then reload. You can still fill this in and Preview it.' : 'Could not load: ' + e.message;
      cw.msgType = 'error';
    }).then(function () { cw.loading = false; if (state.tab === 'club-winner') render(); });
  }
  function cwStatus(f) {
    // Manual only: live from the moment it's switched on and saved; the
    // optional date only stops it (2026-11-21).
    if (!f.enabled) return { cls: 'off', text: 'Off: nobody sees it' };
    if (f.show_until && dcTodayIST() > f.show_until) return { cls: 'off', text: 'Ended on ' + dcPretty(f.show_until) };
    return { cls: 'live', text: 'Live on the tracker' + (f.show_until ? ', stops after ' + dcPretty(f.show_until) : ', until you switch it off') };
  }
  function dcPretty(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function renderClubWinner() {
    var cw = state.clubWinner;
    if (!cw.loaded) return '<p class="hint">Loading…</p>';
    var f = cw.form, st = cwStatus(f);
    var photoHtml = f.photos.map(function (p, i) {
      return '<div class="cw-photo-slot">' +
        '<div class="cw-photo-label">' + (i === 0 ? 'Photo 1 (shown big)' : 'Photo 2 (optional)') + '</div>' +
        (p.src ? '<img class="cw-thumb" src="' + escapeHtml(p.src) + '" alt="">' : '<div class="cw-thumb cw-thumb-empty">No photo</div>') +
        '<div class="cw-photo-actions">' +
          '<label class="btn btn-sm">' + (p.src ? 'Replace' : 'Upload') + '<input type="file" accept="image/*" data-cw-photo="' + i + '" hidden></label>' +
          (p.src ? '<button type="button" class="btn btn-sm" data-cw-remove="' + i + '">Remove</button>' : '') +
        '</div>' +
        '<div class="field"><input type="text" class="cw-cap" data-cw-cap="' + i + '" maxlength="80" placeholder="Caption (optional)" value="' + escapeHtml(p.caption || '') + '"></div>' +
      '</div>';
    }).join('');
    return '<div class="cw-panel">' +
      '<p class="hint">The winners popup on the progress tracker. It only goes out when you switch it on and press Save (you\'ll be asked to confirm); then everyone who opens the tracker sees it (signed in or not), with fireworks. Nothing is ever published by a date on its own.</p>' +
      '<div class="cw-status cw-status-' + st.cls + '">' + escapeHtml(st.text) + '</div>' +
      (cw.msg ? '<div class="msg msg-' + (cw.msgType === 'error' ? 'error' : 'ok') + '">' + escapeHtml(cw.msg) + '</div>' : '') +
      '<div class="cw-grid">' +
        '<label class="field cw-field"><span>Winner\'s name</span><input type="text" id="cw-name" maxlength="80" value="' + escapeHtml(f.name) + '" placeholder="As it should appear"></label>' +
        '<label class="field cw-field"><span>Month</span><input type="text" id="cw-month" maxlength="30" value="' + escapeHtml(f.month) + '"></label>' +
        '<label class="field cw-field"><span>Prize (₹)</span><input type="number" id="cw-prize" min="0" step="1" value="' + escapeHtml(f.prize) + '"></label>' +
        '<label class="field cw-field"><span>Stop showing after (optional)</span><input type="date" id="cw-until" value="' + escapeHtml(f.show_until) + '"></label>' +
      '</div>' +
      '<div class="cw-photos-row">' + photoHtml + '</div>' +
      // Used only by the downloadable LinkedIn-post image (2026-11-21).
      '<div class="cw-avatar-row">' +
        (f.avatar && f.avatar.src ? '<img class="cw-avatar" src="' + escapeHtml(f.avatar.src) + '" alt="">' : '<div class="cw-avatar cw-avatar-empty">' + escapeHtml(cwInitials(f.name)) + '</div>') +
        '<div class="cw-avatar-body">' +
          '<div class="cw-photo-label">Profile picture (for the LinkedIn-post image)</div>' +
          '<div class="cw-photo-actions">' +
            '<label class="btn btn-sm">' + (f.avatar && f.avatar.src ? 'Replace' : 'Upload') + '<input type="file" accept="image/*" id="cw-avatar-file" hidden></label>' +
            (f.avatar && f.avatar.src ? '<button type="button" class="btn btn-sm" id="cw-avatar-remove">Remove</button>' : '') +
          '</div>' +
          '<label class="field cw-field"><span>Their LinkedIn headline (optional)</span><input type="text" id="cw-headline" maxlength="120" value="' + escapeHtml(f.headline || '') + '" placeholder="e.g. GATE DA 2027 aspirant | B.Tech CSE"></label>' +
        '</div>' +
      '</div>' +
      '<label class="field cw-field cw-wide"><span>LinkedIn post text</span><textarea id="cw-text" rows="7" maxlength="3000" placeholder="Paste the winner\'s LinkedIn post">' + escapeHtml(f.linkedin_text) + '</textarea></label>' +
      '<label class="field cw-field cw-wide"><span>LinkedIn post link</span><input type="url" id="cw-url" maxlength="500" value="' + escapeHtml(f.linkedin_url) + '" placeholder="https://www.linkedin.com/posts/..."></label>' +
      '<label class="cw-switch"><input type="checkbox" id="cw-enabled"' + (f.enabled ? ' checked' : '') + '> <span>Live: everyone who opens the tracker sees it (takes effect when you press Save)</span></label>' +
      '<div class="cw-actions-row">' +
        '<button type="button" class="btn" id="cw-preview">Preview on the tracker ↗</button>' +
        '<span class="cw-dl"><select id="cw-download-style" aria-label="Image style"><option value="linkedin">LinkedIn post</option><option value="classic">Classic card</option></select><select id="cw-download-size" aria-label="Image size"><option value="square">Square 1:1 (YouTube, Instagram)</option><option value="portrait">Portrait 4:5 (Instagram, LinkedIn)</option></select><button type="button" class="btn" id="cw-download">Download PNG</button></span>' +
        '<button type="button" class="btn btn-primary" id="cw-save"' + (cw.saving ? ' disabled' : '') + '>' + (cw.saving ? 'Saving…' : 'Save') + '</button>' +
      '</div>' +
    '</div>';
  }
  function cwReadForm() {
    var f = state.clubWinner.form;
    var v = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
    f.name = v('cw-name'); f.month = v('cw-month'); f.prize = Number(v('cw-prize')) || 0;
    f.show_from = ''; f.show_until = v('cw-until');
    f.linkedin_text = v('cw-text'); f.linkedin_url = v('cw-url').trim();
    if (document.getElementById('cw-headline')) f.headline = v('cw-headline');
    var en = document.getElementById('cw-enabled'); f.enabled = !!(en && en.checked);
    document.querySelectorAll('[data-cw-cap]').forEach(function (el) { f.photos[+el.getAttribute('data-cw-cap')].caption = el.value; });
    return f;
  }
  // Shrinks an uploaded image to a JPEG data URL of at most 1400px on its
  // longest side, lowering quality if it's still too big to store.
  function cwShrink(file, maxSide) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = maxSide || 1400, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
        var x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var q = 0.85, out = c.toDataURL('image/jpeg', q);
        while (out.length > 1300000 && q > 0.4) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
        if (out.length > 1300000) reject(new Error('That image is too large even after shrinking.')); else resolve(out);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file isn\'t an image the browser can read.')); };
      img.src = url;
    });
  }
  // Both 2 AM panels sit on one page and every render() rebuilds both from
  // state, so read both before re-rendering (2026-11-19: uploading a 2nd-place
  // photo used to wipe an unsaved 1st-place name).
  function cwReadBoth() {
    if (state.clubWinner.loaded && state.clubWinner.form && document.getElementById('cw-name')) cwReadForm();
    if (state.clubRunners.loaded && state.clubRunners.form && document.getElementById('cr-month')) crReadForm();
  }
  function cwPayload(f) {
    return { enabled: f.enabled, name: f.name.trim(), month: f.month.trim(), prize: f.prize, linkedin_text: f.linkedin_text, linkedin_url: f.linkedin_url,
      headline: (f.headline || '').trim(), avatar: f.avatar && f.avatar.src ? { src: f.avatar.src } : null,
      show_from: f.show_from, show_until: f.show_until, photos: f.photos.filter(function (p) { return p.src; }) };
  }
  function bindClubWinner() {
    var cw = state.clubWinner;
    if (!cw.loaded) return;
    document.querySelectorAll('[data-cw-photo]').forEach(function (input) {
      input.addEventListener('change', function () {
        var i = +input.getAttribute('data-cw-photo'), file = input.files && input.files[0];
        if (!file) return;
        cwReadBoth();
        cwShrink(file).then(function (src) { cw.form.photos[i].src = src; cw.msg = null; render(); })
          .catch(function (e) { cw.msg = e.message; cw.msgType = 'error'; render(); });
      });
    });
    var avIn = document.getElementById('cw-avatar-file');
    if (avIn) avIn.addEventListener('change', function () {
      var file = avIn.files && avIn.files[0]; if (!file) return;
      cwReadBoth();
      cwShrink(file, 400).then(function (src) { cw.form.avatar = { src: src }; cw.msg = null; render(); })
        .catch(function (e) { cw.msg = e.message; cw.msgType = 'error'; render(); });
    });
    var avRm = document.getElementById('cw-avatar-remove');
    if (avRm) avRm.addEventListener('click', function () { cwReadBoth(); cw.form.avatar = null; render(); });
    document.querySelectorAll('[data-cw-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () { cwReadBoth(); cw.form.photos[+btn.getAttribute('data-cw-remove')].src = ''; render(); });
    });
    cwBindDownload('cw-download', 'winner', cw);
    var prev = document.getElementById('cw-preview');
    if (prev) prev.addEventListener('click', function () { cwOpenPreview(cw); });
    var save = document.getElementById('cw-save');
    if (save) save.addEventListener('click', function () {
      cwReadBoth(); var f = cwPayload(state.clubWinner.form);
      // Publishing is a deliberate act: confirm when this save turns it on.
      if (f.enabled && !cw.savedEnabled && !window.confirm('Publish the 2 AM Club announcement now?\n\nEveryone who opens the progress tracker will see it from now on.')) return;
      cw.saving = true; cw.msg = null; render();
      api('/team-club-winner', { method: 'PUT', body: JSON.stringify({ winner: f }) }).then(function (d) {
        cw.savedEnabled = f.enabled;
        cw.updatedAt = d.updated_at; cw.msg = 'Saved. ' + cwStatus(cw.form).text + '.'; cw.msgType = 'ok';
      }).catch(function (e) { cw.msg = 'Could not save: ' + e.message; cw.msgType = 'error'; })
        .then(function () { cw.saving = false; render(); });
    });
  }

  // ── Downloadable PNG of the celebration cards (2026-11-19) ─────────
  // "a downloadable png of the celebratory card to post on our other
  // socials": 1080x1350 (4:5), same night-sky look as the tracker popup.
  // Drawn from the form as it is now (saved or not). Photos are cropped
  // to 16:9 from the centre, like the popup.
  function cwLoadImg(src) {
    return new Promise(function (resolve) {
      if (!src) { resolve(null); return; }
      var im = new Image(); im.onload = function () { resolve(im); }; im.onerror = function () { resolve(null); }; im.src = src;
    });
  }
  function cwCover(ctx, im, x, y, w, h, r) {
    ctx.save(); dcRoundRect(ctx, x, y, w, h, r); ctx.clip();
    ctx.fillStyle = '#0b0b18'; ctx.fillRect(x, y, w, h);
    if (im) {
      var k = Math.max(w / im.naturalWidth, h / im.naturalHeight), dw = im.naturalWidth * k, dh = im.naturalHeight * k;
      ctx.drawImage(im, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    }
    ctx.restore();
    ctx.save(); dcRoundRect(ctx, x, y, w, h, r); ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
  }
  function cwFit(ctx, text, weight, size, maxW, min) {
    while (size > min) { ctx.font = weight + ' ' + size + 'px Poppins, system-ui, sans-serif'; if (ctx.measureText(text).width <= maxW) break; size -= 2; }
    ctx.font = weight + ' ' + size + 'px Poppins, system-ui, sans-serif';
    return size;
  }
  function cwGradText(ctx, text, cx, y, colors) {
    var w = ctx.measureText(text).width, g = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
    colors.forEach(function (c, i) { g.addColorStop(i / (colors.length - 1), c); });
    ctx.fillStyle = g; ctx.fillText(text, cx, y);
  }
  function cwGoldText(ctx, text, cx, y, size) {
    var g = ctx.createLinearGradient(0, y - size, 0, y);
    g.addColorStop(0, '#FFF7D6'); g.addColorStop(0.35, '#FDE68A'); g.addColorStop(1, '#F59E0B');
    ctx.fillStyle = g; ctx.fillText(text, cx, y);
  }
  function cwBackground(ctx, W, H) {
    var g = ctx.createLinearGradient(0, 0, W * 0.6, H);
    g.addColorStop(0, '#221a4a'); g.addColorStop(0.55, '#120f2c'); g.addColorStop(1, '#08091c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    var seed = 7; var rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (var i = 0; i < 90; i++) {
      var x = rnd() * W, y = rnd() * H, r = rnd() * 1.6 + 0.6;
      ctx.globalAlpha = 0.25 + rnd() * 0.55; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // crescent moon, top right: drawn on its own small canvas (disc minus an
    // offset disc), then placed with a soft glow.
    var mc = document.createElement('canvas'); mc.width = 120; mc.height = 120;
    var mx = mc.getContext('2d');
    mx.fillStyle = '#f3e5b5'; mx.beginPath(); mx.arc(60, 60, 38, 0, Math.PI * 2); mx.fill();
    mx.globalCompositeOperation = 'destination-out'; mx.beginPath(); mx.arc(78, 46, 34, 0, Math.PI * 2); mx.fill();
    ctx.save(); ctx.shadowColor = 'rgba(243,229,181,0.55)'; ctx.shadowBlur = 28; ctx.drawImage(mc, W - 180, 50); ctx.restore();
  }
  function cwTag(ctx, text, cx, y) {
    ctx.font = '700 26px Poppins, system-ui, sans-serif';
    var w = ctx.measureText(text).width + 56, h = 56;
    dcRoundRect(ctx, cx - w / 2, y, w, h, 28); ctx.fillStyle = 'rgba(251,191,36,0.12)'; ctx.fill();
    ctx.strokeStyle = 'rgba(251,191,36,0.5)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#FBBF24'; ctx.fillText(text, cx, y + 37);
  }
  function cwFooter(ctx, W, H) {
    // just the site address (2026-11-21: the "free progress tracker" pitch was removed on request)
    ctx.font = '600 26px Poppins, system-ui, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('taai.live', W / 2, H - 56);
  }
  function cwInitials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  // Wraps text (keeping line breaks) to lines of at most maxW; returns at
  // most maxLines lines and whether anything was cut.
  function cwWrap(ctx, text, maxW, maxLines) {
    var out = [], cut = false;
    var paras = String(text || '').replace(/\r/g, '').split('\n');
    for (var p = 0; p < paras.length; p++) {
      var words = paras[p].split(/\s+/).filter(Boolean), line = '';
      if (!words.length) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
      for (var i = 0; i < words.length; i++) {
        var t = line ? line + ' ' + words[i] : words[i];
        if (ctx.measureText(t).width <= maxW || !line) line = t;
        else { out.push(line); line = words[i]; }
      }
      out.push(line);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    // maxLines counts text lines only; blank lines between paragraphs are free (drawn as a small gap)
    for (var n = 0, k = 0; k < out.length; k++) { if (out[k] !== '') n++; if (n > maxLines) { out = out.slice(0, k); cut = true; break; } }
    while (out.length && out[out.length - 1] === '') { out.pop(); cut = true; }
    return { lines: out, cut: cut };
  }
  // The winner's post drawn as a LinkedIn-style post on the night sky
  // (2026-11-21, "a mockup of the LinkedIn post with the person's profile
  // pic in the corner and some of the pictures they shared"). No LinkedIn
  // logo and no made-up reaction counts.
  function cwDrawLinkedIn(ctx, W, H, data, photos, avatar, sq, month) {
    var P = 60, cx = W / 2;
    var sans = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    // 1st place, or 2nd/3rd (2026-11-21: one image per place, same style)
    var place = data.place || 1, ord = { 1: '1st', 2: '2nd', 3: '3rd' }[place] || '1st';
    var defHeadline = place === 1 ? 'Winner, The 2 AM Club · ' + month : ord + ' place, The 2 AM Club · ' + month;
    cwTag(ctx, 'THE 2 AM CLUB · ' + month.toUpperCase() + (place === 1 ? ' WINNER' : ' · ' + ord.toUpperCase() + ' PLACE'), cx, 44);
    cwFit(ctx, 'Congratulations, ' + data.name + '!', 800, sq ? 52 : 58, W - 2 * P, 32);
    var head = 'Congratulations, ' + data.name + '!';
    cwGradText(ctx, head, cx, sq ? 204 : 218, ['#FF7FB7', '#A78BFA', '#4D8BFF']);
    // no prize money in the image (2026-11-21, direct request)
    ctx.font = '500 28px Poppins, system-ui, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.fillText(place === 1 ? 'Winner of The 2 AM Club for ' + month : ord + ' place in The 2 AM Club for ' + month, cx, sq ? 248 : 266);
    ctx.textAlign = 'left';
    // the post card
    var x = P, y = sq ? 280 : 304, w = W - 2 * P, bottom = H - 100, h = bottom - y, pad = 34;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 14;
    dcRoundRect(ctx, x, y, w, h, 22); ctx.fillStyle = '#fff'; ctx.fill(); ctx.restore();
    ctx.save(); dcRoundRect(ctx, x, y, w, h, 22); ctx.clip();
    // header: profile picture in the corner, name, headline, "posted" line
    var av = 92, ax = x + pad, ay = y + pad;
    ctx.save(); ctx.beginPath(); ctx.arc(ax + av / 2, ay + av / 2, av / 2, 0, Math.PI * 2); ctx.clip();
    if (avatar) {
      var k = Math.max(av / avatar.naturalWidth, av / avatar.naturalHeight), dw = avatar.naturalWidth * k, dh = avatar.naturalHeight * k;
      ctx.drawImage(avatar, ax + (av - dw) / 2, ay + (av - dh) / 2, dw, dh);
    } else {
      var g = ctx.createLinearGradient(ax, ay, ax + av, ay + av); g.addColorStop(0, '#A78BFA'); g.addColorStop(1, '#4D8BFF');
      ctx.fillStyle = g; ctx.fillRect(ax, ay, av, av);
      ctx.fillStyle = '#fff'; ctx.font = '700 36px ' + sans; ctx.textAlign = 'center'; ctx.fillText(cwInitials(data.name), ax + av / 2, ay + av / 2 + 13); ctx.textAlign = 'left';
    }
    ctx.restore();
    var tx = ax + av + 20, tw = x + w - pad - tx;
    ctx.fillStyle = '#191919'; cwFitSans(ctx, data.name, 700, 32, tw, 22, sans); ctx.fillText(data.name, tx, ay + 34);
    ctx.fillStyle = '#666666'; ctx.font = '400 23px ' + sans;
    var hl = data.headline || defHeadline;
    while (ctx.measureText(hl).width > tw && hl.length > 4) hl = hl.slice(0, -2);
    if (hl !== (data.headline || defHeadline)) hl = hl.replace(/\s*\S?$/, '') + '…';
    ctx.fillText(hl, tx, ay + 66);
    ctx.fillStyle = '#8a8a8a'; ctx.font = '400 21px ' + sans; ctx.fillText('Posted on LinkedIn', tx, ay + 94);
    // post text
    var textTop = ay + av + 26, lh = 34;
    ctx.font = '400 25px ' + sans; ctx.fillStyle = '#191919';
    var maxLines = photos.filter(Boolean).length ? (sq ? 3 : 5) : (sq ? 11 : 15);
    var wr = cwWrap(ctx, data.linkedin_text || '', w - 2 * pad, maxLines), lines = wr.lines;
    var yy = textTop + 25 - lh, lastY = textTop;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      yy += (i && lines[i - 1] === '') ? lh * 0.45 : lh; // blank line between paragraphs = a small gap
      if (ln === '') continue;
      lastY = yy;
      if (i === lines.length - 1 && wr.cut) {
        var more = '…see more', mw = ctx.measureText(more).width;
        if (/\s/.test(ln)) ln = ln.replace(/\s+\S*$/, ''); // the next word was cut: drop it whole
        while (ln && ctx.measureText(ln).width + mw + 8 > w - 2 * pad) ln = ln.replace(/\s*\S+$/, '');
        ctx.fillStyle = '#191919'; ctx.fillText(ln.replace(/\s+$/, ''), x + pad, yy);
        ctx.fillStyle = '#666666'; ctx.fillText(more, x + pad + ctx.measureText(ln.replace(/\s+$/, '')).width + 6, yy);
      } else { ctx.fillStyle = '#191919'; ctx.fillText(ln, x + pad, yy); }
    }
    var textEnd = lines.length ? lastY + 18 : textTop;
    // their photos, edge to edge like a feed post
    var barH = 66, imgTop = textEnd + 14, imgBot = bottom - barH, ims = photos.filter(Boolean);
    if (ims.length && imgBot - imgTop > 120) {
      if (ims.length === 1) cwCoverPlain(ctx, ims[0], x, imgTop, w, imgBot - imgTop);
      else { var half = (w - 4) / 2; cwCoverPlain(ctx, ims[0], x, imgTop, half, imgBot - imgTop); cwCoverPlain(ctx, ims[1], x + half + 4, imgTop, half, imgBot - imgTop); }
    }
    // action bar (labels only, no counts)
    ctx.fillStyle = '#e8e8e8'; ctx.fillRect(x + pad, bottom - barH, w - 2 * pad, 2);
    ctx.fillStyle = '#5e5e5e'; ctx.font = '600 23px ' + sans; ctx.textAlign = 'center';
    ['Like', 'Comment', 'Repost', 'Send'].forEach(function (lab, j) { ctx.fillText(lab, x + w * (j + 0.5) / 4, bottom - 22); });
    ctx.restore();
    ctx.textAlign = 'center';
  }
  function cwCoverPlain(ctx, im, x, y, w, h) {
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(x, y, w, h);
    var k = Math.max(w / im.naturalWidth, h / im.naturalHeight), dw = im.naturalWidth * k, dh = im.naturalHeight * k;
    // tall phone photos keep their upper part (the screen / desk), not the middle
    var oy = dh > h ? (h - dh) * 0.32 : (h - dh) / 2;
    ctx.drawImage(im, x + (w - dw) / 2, y + oy, dw, dh);
    ctx.restore();
  }
  function cwFitSans(ctx, text, weight, size, maxW, min, fam) {
    while (size > min) { ctx.font = weight + ' ' + size + 'px ' + fam; if (ctx.measureText(text).width <= maxW) break; size -= 2; }
    ctx.font = weight + ' ' + size + 'px ' + fam;
  }
  function cwGoldTextLeft(ctx, text, x, y, size) {
    var g = ctx.createLinearGradient(0, y - size, 0, y);
    g.addColorStop(0, '#FFF7D6'); g.addColorStop(0.35, '#FDE68A'); g.addColorStop(1, '#F59E0B');
    ctx.fillStyle = g; ctx.fillText(text, x, y);
  }
  function cwExportPng(kind, size, style) {
    var sq = size === 'square';
    // kind 'runner:N' = one of the other places (slot N) as its own LinkedIn-post image
    var personIdx = /^runner:(\d)$/.test(kind) ? +kind.slice(7) : -1;
    var li = personIdx >= 0 || (kind !== 'runners' && style === 'linkedin');
    // Square 1:1 for YouTube community / Instagram, portrait 4:5 for feeds (2026-11-19).
    var W = 1080, H = sq ? 1080 : 1350, P = 72;
    var L = sq
      ? { tag: 118, l1: 228, l2: 316, sub: 368, box: 398, boxH: 140, amt: 78, photo: 566, photoMax: 410, rTop: 400, one: 560, nameY2: 300 }
      : { tag: 178, l1: 318, l2: 418, sub: 478, box: 520, boxH: 168, amt: 92, photo: 724, photoMax: 9999, rTop: 530, one: 640, nameY2: 410 };
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    cwReadBoth();
    var data = kind === 'runners' ? crPayload(state.clubRunners.form) : cwPayload(state.clubWinner.form);
    if (personIdx >= 0) {
      var rf = crPayload(state.clubRunners.form);
      data = Object.assign({ month: rf.month, place: CR_SLOTS[personIdx].place }, rf.people[personIdx]);
    }
    var month = (data.month || '').trim();
    var people = kind === 'runners' ? data.people.map(function (p, i) { return Object.assign({ place: CR_SLOTS[i].place }, p); }).filter(function (p) { return p.name; }) : null;
    if (kind === 'runners' && !people.length) return Promise.reject(new Error('Add 2nd place\'s name first.'));
    if (kind !== 'runners' && !data.name) return Promise.reject(new Error('Add the winner\'s name first.'));
    var srcs = kind === 'runners' ? people.map(function (p) { return p.photos[0] && p.photos[0].src; })
      : li ? data.photos.map(function (p) { return p.src; }).concat([data.avatar && data.avatar.src])
      : [(data.photos[0] || {}).src];
    var fontsReady = document.fonts && document.fonts.load
      ? Promise.all(['800 80px Poppins', '700 26px Poppins', '600 30px Poppins', '500 26px Poppins'].map(function (f) { return document.fonts.load(f); })).catch(function () {})
      : Promise.resolve();
    if (!dcLogo) { dcLogo = new Image(); dcLogo.src = '/logo.webp'; }
    var logoReady = dcLogo.complete ? Promise.resolve() : new Promise(function (r) { dcLogo.onload = r; dcLogo.onerror = r; });
    return Promise.all([fontsReady, logoReady, Promise.all(srcs.map(cwLoadImg))]).then(function (res) {
      var imgs = res[2];
      cwBackground(ctx, W, H);
      if (dcLogo.complete && dcLogo.naturalWidth) ctx.drawImage(dcLogo, 104, 68, 150, 80, P, P - 4, 64 * 150 / 80, 64);
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      var cx = W / 2;
      if (li) {
        cwDrawLinkedIn(ctx, W, H, data, imgs.slice(0, imgs.length - 1), imgs[imgs.length - 1], sq, month);
      } else if (kind !== 'runners') {
        cwTag(ctx, 'THE 2 AM CLUB · ' + month.toUpperCase() + ' WINNER', cx, L.tag);
        ctx.font = '700 54px Poppins, system-ui, sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText('Congratulations,', cx, L.l1);
        cwFit(ctx, data.name + '!', 800, 92, W - 2 * P, 48);
        cwGradText(ctx, data.name + '!', cx, L.l2, ['#FF7FB7', '#A78BFA', '#4D8BFF']);
        ctx.font = '500 32px Poppins, system-ui, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillText('Winner of The 2 AM Club for ' + month, cx, L.sub);
        // no prize box any more (2026-11-21): the photo takes its place
        var ph = Math.min(Math.round((W - 2 * P) * 9 / 16), L.photoMax + (L.photo - L.box)), pw = Math.round(ph * 16 / 9);
        if (pw > W - 2 * P) { pw = W - 2 * P; ph = Math.round(pw * 9 / 16); }
        cwCover(ctx, imgs[0], cx - pw / 2, L.box + 10, pw, ph, 30);
      } else {
        var two = people.length > 1, n = people.length;
        cwTag(ctx, 'THE 2 AM CLUB · ' + month.toUpperCase(), cx, L.tag);
        ctx.font = '700 56px Poppins, system-ui, sans-serif'; ctx.fillStyle = '#fff';
        ctx.fillText('Congratulations to our', cx, L.l1);
        ctx.font = '800 76px Poppins, system-ui, sans-serif';
        cwGradText(ctx, two ? 'runners-up!' : 'runner-up!', cx, L.nameY2 + (sq ? 0 : 0), ['#FF7FB7', '#A78BFA', '#4D8BFF']);
        ctx.font = '500 32px Poppins, system-ui, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.75)';
        var n2 = people.filter(function (p) { return p.place === 2; }).length, has3 = people.some(function (p) { return p.place === 3; });
        var placesTxt = (n2 > 1 ? 'Two 2nd places' : n2 ? '2nd place' : '') + (has3 ? (n2 ? ' and 3rd place' : '3rd place') : '');
        ctx.fillText(placesTxt + ' in The 2 AM Club for ' + month, cx, L.sub - (sq ? 0 : 6));
        var gap = n > 2 ? 24 : 32, cw = two ? (W - 2 * P - (n - 1) * gap) / n : L.one;
        var phh0 = Math.round((cw - 32) * 9 / 16), cardH0 = 16 + phh0 + 156;
        // centre the cards in the space between the subtitle and the footer
        var areaTop = L.sub + 40, areaBot = H - 110, top = Math.round(areaTop + Math.max(0, (areaBot - areaTop - cardH0) / 2));
        people.forEach(function (p, i) {
          var x = two ? P + i * (cw + gap) : cx - cw / 2, ccx = x + cw / 2, phh = phh0;
          var cardH = cardH0;
          dcRoundRect(ctx, x, top, cw, cardH, 30); ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 2; ctx.stroke();
          cwCover(ctx, imgs[i], x + 16, top + 16, cw - 32, phh, 22);
          var y = top + 16 + phh;
          ctx.font = '700 26px Poppins, system-ui, sans-serif'; ctx.fillStyle = p.place === 2 ? '#E5E7EB' : '#F0B27A';
          ctx.fillText((p.place === 2 ? '2ND' : '3RD') + ' PLACE', ccx, y + 58);
          cwFit(ctx, p.name, 800, n > 2 ? 38 : 46, cw - 40, 22);
          cwGradText(ctx, p.name, ccx, y + 118, ['#FF7FB7', '#A78BFA', '#4D8BFF']);
          // no prize money in the image (2026-11-21)
        });
      }
      cwFooter(ctx, W, H);
      return new Promise(function (resolve, reject) {
        c.toBlob(function (blob) {
          if (!blob) { reject(new Error('Could not make the image.')); return; }
          var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
          var slug = String(data.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          a.download = (personIdx >= 0 ? 'taai-2am-club-' + ({ 2: '2nd', 3: '3rd' }[data.place] || '2nd') + '-place-' + slug
            : kind === 'runners' ? 'taai-2am-club-runners-up' : li ? 'taai-2am-club-winner-linkedin' : 'taai-2am-club-winner') + (sq ? '-square' : '-portrait') + '.png';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
          resolve(c);
        }, 'image/png');
      });
    });
  }
  function cwBindDownload(btnId, kind, st) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', function () {
      btn.disabled = true;
      var sel = document.getElementById(btnId + '-size'), sty = document.getElementById(btnId + '-style');
      cwExportPng(kind, sel ? sel.value : 'square', sty ? sty.value : 'classic').catch(function (e) { st.msg = e.message; st.msgType = 'error'; render(); })
        .then(function () { btn.disabled = false; });
    });
  }

  // ── Other places: 2nd, another 2nd, 3rd (2026-11-21, design B) ──────
  // Shown in the SAME popup as 1st place, side by side, and published
  // together under 1st place's switch and dates (no switch here). Each
  // place is a full LinkedIn-style post: profile picture, headline, post
  // text, up to two photos. Leave a place empty if there's nobody yet;
  // saving later shows the announcement again to everyone.
  var CR_SLOTS = [{ place: 2, label: '🥈 2nd place', prize: 3000 }, { place: 2, label: '🥈 2nd place (another)', prize: 3000 }, { place: 3, label: '🥉 3rd place', prize: 2000 }];
  function crEmptyPerson(i) {
    return { place: CR_SLOTS[i].place, name: '', prize: CR_SLOTS[i].prize, linkedin_url: '', headline: '', linkedin_text: '', avatar: null, photos: [{ src: '' }, { src: '' }] };
  }
  function crDefaultForm() {
    return { month: 'November', note: '', people: CR_SLOTS.map(function (_, i) { return crEmptyPerson(i); }) };
  }
  function loadClubRunners() {
    var cr = state.clubRunners;
    if (cr.loaded || cr.loading) return;
    cr.loading = true;
    api('/team-club-winner?slot=runners').then(function (d) {
      var f = crDefaultForm(), r = d.runners;
      if (r) {
        if (r.month) f.month = r.month;
        f.note = r.note || '';
        var two = 0;
        (r.people || []).forEach(function (p) {
          var i = p.place === 3 ? 2 : two++;
          if (i > 2) return;
          var ph = (p.photos && p.photos.length ? p.photos : (p.photo ? [p.photo] : [])).slice(0, 2);
          f.people[i] = { place: CR_SLOTS[i].place, name: p.name || '', prize: p.prize || 0, linkedin_url: p.linkedin_url || '', headline: p.headline || '',
            linkedin_text: p.linkedin_text || '', avatar: p.avatar || null, photos: [ph[0] || { src: '' }, ph[1] || { src: '' }] };
        });
      }
      cr.form = f; cr.loaded = true;
    }).catch(function (e) {
      cr.form = crDefaultForm(); cr.loaded = true;
      cr.msg = 'Could not load: ' + e.message; cr.msgType = 'error';
    }).then(function () { cr.loading = false; if (state.tab === 'club-winner') render(); });
  }
  function renderClubRunners() {
    var cr = state.clubRunners;
    if (!cr.loaded) return '';
    var f = cr.form;
    var main = state.clubWinner.loaded && state.clubWinner.form ? cwStatus(state.clubWinner.form).text : '';
    var people = f.people.map(function (p, i) {
      var filled = p.name || p.linkedin_text || (p.avatar && p.avatar.src) || p.photos.some(function (x) { return x.src; });
      return '<div class="cr-slot">' +
        '<div class="cr-slot-head"><span class="cw-photo-label">' + CR_SLOTS[i].label + '</span>' +
          '<span class="cr-slot-btns">' + (p.name ? '<button type="button" class="btn btn-sm" data-cr-dl="' + i + '" title="LinkedIn-post style image of this place, in the size picked below">Download image</button>' : '') +
          (filled ? '<button type="button" class="btn btn-sm" data-cr-clear="' + i + '">Clear this place</button>' : '') + '</span></div>' +
        '<div class="cw-grid">' +
          '<label class="field cw-field"><span>Name</span><input type="text" data-cr-name="' + i + '" maxlength="80" value="' + escapeHtml(p.name) + '" placeholder="' + (i === 0 ? 'As it should appear' : 'Leave empty if nobody yet') + '"></label>' +
          '<label class="field cw-field"><span>Prize (₹)</span><input type="number" data-cr-prize="' + i + '" min="0" step="1" value="' + escapeHtml(p.prize) + '"></label>' +
        '</div>' +
        '<div class="cw-avatar-row">' +
          (p.avatar && p.avatar.src ? '<img class="cw-avatar" src="' + escapeHtml(p.avatar.src) + '" alt="">' : '<span class="cw-avatar cw-avatar-empty">' + escapeHtml(p.name.trim() ? cwInitials(p.name) : '?') + '</span>') +
          '<div class="cw-avatar-body"><span class="cw-photo-label">Profile picture</span><div class="cw-photo-actions">' +
            '<label class="btn btn-sm">' + (p.avatar && p.avatar.src ? 'Replace' : 'Upload') + '<input type="file" accept="image/*" data-cr-avatar="' + i + '" hidden></label>' +
            (p.avatar && p.avatar.src ? '<button type="button" class="btn btn-sm" data-cr-avremove="' + i + '">Remove</button>' : '') +
          '</div></div>' +
        '</div>' +
        '<label class="field cw-field"><span>Their LinkedIn headline (optional)</span><input type="text" data-cr-headline="' + i + '" maxlength="120" value="' + escapeHtml(p.headline) + '"></label>' +
        '<label class="field cw-field"><span>LinkedIn post text</span><textarea data-cr-text="' + i + '" rows="4" maxlength="3000" placeholder="Paste their LinkedIn post">' + escapeHtml(p.linkedin_text) + '</textarea></label>' +
        '<label class="field cw-field"><span>LinkedIn post link</span><input type="url" data-cr-url="' + i + '" maxlength="500" value="' + escapeHtml(p.linkedin_url) + '" placeholder="https://www.linkedin.com/posts/..."></label>' +
        '<div class="cr-photos">' + p.photos.map(function (ph, j) {
          return '<div class="cr-photo">' +
            (ph.src ? '<img class="cw-thumb" src="' + escapeHtml(ph.src) + '" alt="">' : '<div class="cw-thumb cw-thumb-empty">Photo ' + (j + 1) + '</div>') +
            '<div class="cw-photo-actions"><label class="btn btn-sm">' + (ph.src ? 'Replace' : 'Upload') + '<input type="file" accept="image/*" data-cr-photo="' + i + ':' + j + '" hidden></label>' +
            (ph.src ? '<button type="button" class="btn btn-sm" data-cr-remove="' + i + ':' + j + '">Remove</button>' : '') + '</div>' +
          '</div>';
        }).join('') + '</div>' +
      '</div>';
    }).join('');
    return '<div class="cw-panel cr-panel">' +
      '<h3 class="cr-head">Other places: 2nd, another 2nd, 3rd</h3>' +
      '<p class="hint">Shown in the same popup as 1st place, everyone side by side, and published together with it: only 1st place\'s switch above publishes it (' + escapeHtml(main || 'set above') + '). Leave a place empty if there\'s nobody in it yet. Saving a change while it\'s live shows the announcement again to everyone, so add a later winner (e.g. on the 30th) and Save.</p>' +
      (cr.msg ? '<div class="msg msg-' + (cr.msgType === 'error' ? 'error' : 'ok') + '">' + escapeHtml(cr.msg) + '</div>' : '') +
      '<div class="cw-grid">' +
        '<label class="field cw-field"><span>Month</span><input type="text" id="cr-month" maxlength="30" value="' + escapeHtml(f.month) + '"></label>' +
        '<label class="field cw-field"><span>"Still to come" note (optional)</span><input type="text" id="cr-note" maxlength="120" value="' + escapeHtml(f.note) + '" placeholder="e.g. One more 2nd place, announced on Nov 30"></label>' +
      '</div>' +
      '<div class="cr-slots">' + people + '</div>' +
      '<div class="cw-actions-row">' +
        '<button type="button" class="btn" id="cr-preview">Preview everyone on the tracker ↗</button>' +
        '<span class="cw-dl"><select id="cr-download-size" aria-label="Image size"><option value="square">Square 1:1 (YouTube, Instagram)</option><option value="portrait">Portrait 4:5 (Instagram, LinkedIn)</option></select><button type="button" class="btn" id="cr-download">Download PNG</button></span>' +
        '<button type="button" class="btn btn-primary" id="cr-save"' + (cr.saving ? ' disabled' : '') + '>' + (cr.saving ? 'Saving…' : 'Save') + '</button>' +
      '</div>' +
    '</div>';
  }
  function crReadForm() {
    var f = state.clubRunners.form;
    var v = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
    f.month = v('cr-month'); f.note = v('cr-note');
    var each = function (attr, fn) { document.querySelectorAll('[' + attr + ']').forEach(function (el) { fn(f.people[+el.getAttribute(attr)], el); }); };
    each('data-cr-name', function (p, el) { p.name = el.value; });
    each('data-cr-prize', function (p, el) { p.prize = Number(el.value) || 0; });
    each('data-cr-url', function (p, el) { p.linkedin_url = el.value.trim(); });
    each('data-cr-headline', function (p, el) { p.headline = el.value; });
    each('data-cr-text', function (p, el) { p.linkedin_text = el.value; });
    return f;
  }
  function crPayload(f) {
    return { month: f.month.trim(), note: (f.note || '').trim(),
      people: f.people.map(function (p) {
        return { name: p.name.trim(), prize: p.prize, linkedin_url: p.linkedin_url, headline: (p.headline || '').trim(), linkedin_text: p.linkedin_text || '',
          avatar: p.avatar && p.avatar.src ? { src: p.avatar.src } : null,
          photos: p.photos.filter(function (x) { return x.src; }).map(function (x) { return { src: x.src }; }) };
      }) };
  }
  // Both panels' Preview buttons open the whole announcement (1st place plus
  // the other places) from the unsaved forms.
  function cwOpenPreview(st) {
    cwReadBoth();
    var w = cwPayload(state.clubWinner.form);
    if (!w.name) { st.msg = 'Add 1st place\'s name to preview.'; st.msgType = 'error'; render(); return; }
    var r = state.clubRunners.loaded && state.clubRunners.form ? crPayload(state.clubRunners.form) : null;
    try {
      localStorage.setItem('taai_club_winner_preview', JSON.stringify(w));
      if (r) localStorage.setItem('taai_club_runners_preview', JSON.stringify(r)); else localStorage.removeItem('taai_club_runners_preview');
    } catch (e) { st.msg = 'Preview needs the photos to fit in this browser\'s storage; try smaller photos.'; st.msgType = 'error'; render(); return; }
    window.open('/gate-da-progress-tracker?winner-preview', '_blank', 'noopener');
  }
  function bindClubRunners() {
    var cr = state.clubRunners;
    if (!cr.loaded) return;
    var fail = function (e) { cr.msg = e.message; cr.msgType = 'error'; render(); };
    document.querySelectorAll('[data-cr-photo]').forEach(function (input) {
      input.addEventListener('change', function () {
        var ij = input.getAttribute('data-cr-photo').split(':'), file = input.files && input.files[0];
        if (!file) return;
        cwReadBoth();
        // smaller than 1st place's photos: up to six photos go in one save
        cwShrink(file, 1100).then(function (src) { cr.form.people[+ij[0]].photos[+ij[1]] = { src: src }; cr.msg = null; render(); }).catch(fail);
      });
    });
    document.querySelectorAll('[data-cr-avatar]').forEach(function (input) {
      input.addEventListener('change', function () {
        var i = +input.getAttribute('data-cr-avatar'), file = input.files && input.files[0];
        if (!file) return;
        cwReadBoth();
        cwShrink(file, 400).then(function (src) { cr.form.people[i].avatar = { src: src }; cr.msg = null; render(); }).catch(fail);
      });
    });
    document.querySelectorAll('[data-cr-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () { var ij = btn.getAttribute('data-cr-remove').split(':'); cwReadBoth(); cr.form.people[+ij[0]].photos[+ij[1]] = { src: '' }; render(); });
    });
    document.querySelectorAll('[data-cr-avremove]').forEach(function (btn) {
      btn.addEventListener('click', function () { cwReadBoth(); cr.form.people[+btn.getAttribute('data-cr-avremove')].avatar = null; render(); });
    });
    document.querySelectorAll('[data-cr-clear]').forEach(function (btn) {
      btn.addEventListener('click', function () { var i = +btn.getAttribute('data-cr-clear'); cwReadBoth(); cr.form.people[i] = crEmptyPerson(i); render(); });
    });
    cwBindDownload('cr-download', 'runners', cr);
    document.querySelectorAll('[data-cr-dl]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        var sel = document.getElementById('cr-download-size');
        cwExportPng('runner:' + btn.getAttribute('data-cr-dl'), sel ? sel.value : 'square', 'linkedin')
          .catch(function (e) { cr.msg = e.message; cr.msgType = 'error'; render(); })
          .then(function () { btn.disabled = false; });
      });
    });
    var prev = document.getElementById('cr-preview');
    if (prev) prev.addEventListener('click', function () { cwOpenPreview(cr); });
    var save = document.getElementById('cr-save');
    if (save) save.addEventListener('click', function () {
      cwReadBoth(); var f = crPayload(state.clubRunners.form);
      cr.saving = true; cr.msg = null; render();
      api('/team-club-winner?slot=runners', { method: 'PUT', body: JSON.stringify({ runners: f }) }).then(function () {
        cr.msg = 'Saved. Shown with 1st place: ' + (state.clubWinner.form ? cwStatus(state.clubWinner.form).text : 'see above') + '.'; cr.msgType = 'ok';
      }).catch(function (e) { cr.msg = 'Could not save: ' + e.message; cr.msgType = 'error'; })
        .then(function () { cr.saving = false; render(); });
    });
  }

  // ── Day card (2026-10-09) ────────────────────────────────────────────
  // A 1:1 (1080x1080) image of one day's tasks for a batch, for marketing
  // posts ("screenshots of the current day tasks or the next day of the
  // 120 days 70 marks batch"). Reads the same public /api/tracker-data the
  // tracker uses (guest view, ?batch=), so it always matches the live
  // schedule. Drawn straight onto a <canvas> (no library) and downloaded
  // as PNG. Day numbers follow the tracker's own badge rules.
  var DC_SUBJECT_COLORS = {
    'Linear Algebra': '#A78BFA', 'Probability': '#60A5FA', 'Statistics': '#34D399',
    'Calculus': '#F472B6', 'Machine Learning': '#FBBF24', 'Python': '#38BDF8',
    'Data Structures': '#FB923C', 'Algorithms': '#F87171', 'DBMS': '#2DD4BF',
    'AI': '#C084FC', 'AI (Logic)': '#C084FC', 'Quiz & Test Series': '#94A3B8',
  };
  var DC_BATCHES = {
    D: { label: '120 Days - 70 Marks', length: 120 },
    C: { label: '180 Days Batch C', length: 180 },
  };
  var DC_EXAM_DATE = '2027-02-06';
  var DC_C_START = '2026-08-01';

  function dcTodayIST() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function dcAddDays(iso, n) {
    var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
  }
  function dcDiffDays(a, b) { return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5); }
  function dcSelectedDate() {
    var dc = state.dayCard, today = dcTodayIST();
    if (dc.which === 'tomorrow') return dcAddDays(today, 1);
    if (dc.which === 'custom' && dc.date) return dc.date;
    return today;
  }
  function dcDayNumber(batch, iso) {
    if (batch === 'D') return Math.min(120, Math.max(0, 121 - Math.max(0, dcDiffDays(DC_EXAM_DATE, iso)))); // same rule as the tracker badge: Oct 9 = Day 1
    return Math.max(0, dcDiffDays(iso, DC_C_START) + 1);
  }
  function dcMonthKey(batch, iso) { return batch + ':' + iso.slice(0, 7); }

  function loadDayCardMonth() {
    var dc = state.dayCard, iso = dcSelectedDate(), key = dcMonthKey(dc.batch, iso);
    if (dc.months[key] || dc.loading) { drawDayCard(); return; }
    dc.loading = true; dc.error = null; render();
    fetch('/api/tracker-data?month=' + iso.slice(0, 7) + '&batch=' + encodeURIComponent(dc.batch))
      .then(function (r) { if (!r.ok) throw new Error('Could not load the schedule (' + r.status + ')'); return r.json(); })
      .then(function (d) { dc.months[key] = (d.schedule && d.schedule.days) || []; })
      .catch(function (e) { dc.error = e.message; })
      .then(function () { dc.loading = false; render(); });
  }

  function dcTasksFor(batch, iso) {
    var days = state.dayCard.months[dcMonthKey(batch, iso)];
    if (!days) return null;
    var day = days.filter(function (d) { return d.date === iso; })[0];
    return day ? day.tasks.slice().sort(function (a, b) { return a.position - b.position; }) : [];
  }

  // Caption prompt (2026-10-09, replaced the Claude-API "Generate caption"
  // button: "give me a prompt for the caption, I will generate it somewhere
  // else ... with a copyable button, filled in every day"). Built from the
  // same day as the picture; paste it into any AI chat. The facts and rules
  // are the ones the team agreed for these captions.
  // The prompt is a template (2026-10-09, "keep the prompt editable even
  // after deployment"): the saved one lives in site_settings.
  // daycard_prompt_template (edited below the prompt), the default is this
  // constant. {{placeholders}} are filled from the selected day.
  var DC_PROMPT_PLACEHOLDERS = ['batch_label', 'day_line', 'tasks', 'target_marks', 'day_length', 'roadmap_link', 'course_link'];
  var DC_DEFAULT_PROMPT = [
    'Write a short social media caption (Instagram / LinkedIn / WhatsApp channel) for TAAI, a GATE DA (Data Science and AI) exam-prep brand in India. It goes with an image of one day from TAAI\'s free "{{batch_label}}" roadmap. The image already shows the day\'s tasks, the day counter and the offer, so don\'t list the tasks again.',
    '',
    'This post: {{day_line}}.',
    'The day\'s tasks (for context only):',
    '{{tasks}}',
    '',
    'Facts you may use (use nothing else):',
    '- The roadmap is free, on TAAI\'s progress tracker. It\'s a day-by-day roadmap aimed at {{target_marks}} marks in GATE DA 2027.',
    '- By Day {{day_length}} you\'ll have done the lectures, revision, quizzes and tests, so there\'s less to worry about before the real exam.',
    '- GATE DA 2026: 49.67 marks got AIR 768 and an M.Tech in AI for Sustainability at IIT Kanpur (General category).',
    '- "100 pe 100% off" on the GATE 2028 Full Course: get an AIR under 100 in GATE DA 2027 and TAAI refunds the full GATE 2028 course fee, and you keep full access to the course. This is for students of that course; never say or imply the free roadmap earns it.',
    '',
    'Voice: sounds like a real person (a mentor or fellow aspirant) typing quickly, not a brand. Plain, direct, a little cheeky is fine. Short sentences. No corporate words (journey, unlock, elevate, game-changer, dive in), no "Here\'s what...", no exclamation spam.',
    '',
    'Structure:',
    '1. Start the caption with the 🔴 emoji followed by the campaign name "100 pe 100% off", then an intriguing first line that makes someone stop scrolling.',
    '2. One or two short lines about the roadmap and the offer.',
    '3. These two links, each on its own line, exactly:',
    '   Roadmap (free): {{roadmap_link}}',
    '   Course: {{course_link}}',
    '4. At most 3 hashtags on the last line.',
    '',
    'Rules:',
    '- Under 50 words before the links.',
    '- Always call it a "roadmap", never a "plan".',
    '- Never invent prices, deadlines, ranks, student numbers, results, quotes, or claims about how long or hard a day is.',
    '- Never call a future day "today".',
    '- No em dashes or en dashes. Apart from the opening 🔴, at most 1 emoji.',
    '- Output only the caption.',
  ].join('\n');

  // One-off festival touches (2026-10-19, "do tomorrow's post with Dussehra
  // context, just tomorrow"): keyed by the POST date, so they show only on
  // that day's Day card / Offer poster and their caption prompts. Add a date
  // here for another festival; past dates simply never match again.
  var FESTIVALS = {
    '2026-10-20': {
      tag: 'HAPPY DUSSEHRA',
      prompt: 'This post goes out on Dussehra (Vijayadashami), the festival of good winning over evil. Keep the required opening, then make the first line a short, warm Dussehra wish tied in lightly to studying (for example: burn your backlog along with Ravan, or a fresh start on an auspicious day). Keep it respectful: no jokes about religion. All facts and rules above still apply.',
    },
  };
  function festivalFor(iso) { return FESTIVALS[iso] || null; }
  function withFestivalPrompt(text, iso) {
    var f = festivalFor(iso);
    return f ? text + '\n\nFestival context for this post:\n- ' + f.prompt : text;
  }
  // Orange bordered tag beside the logo (logo ends at about x = 177).
  function drawFestivalTag(ctx, iso, P, MONO) {
    var f = festivalFor(iso); if (!f) return;
    ctx.font = '600 22px ' + MONO;
    var x = P + 125, y = P + 2, w = ctx.measureText(f.tag).width + 36, h = 50;
    ctx.fillStyle = '#111111'; ctx.fillRect(x + 5, y + 5, w, h);
    ctx.fillStyle = '#FDBA74'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#111111'; ctx.lineWidth = 3; ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
    ctx.fillStyle = '#111111'; ctx.textBaseline = 'middle'; ctx.fillText(f.tag, x + 18, y + 26); ctx.textBaseline = 'alphabetic';
  }

  function dcPromptValues(batch, iso, tasks) {
    var dayNum = dcDayNumber(batch, iso), len = DC_BATCHES[batch].length, today = dcTodayIST();
    var when = iso === today ? 'today' : iso === dcAddDays(today, 1) ? 'tomorrow' : new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    return {
      batch_label: DC_BATCHES[batch].label,
      day_line: (dayNum > 0 ? 'Day ' + dayNum + ' of ' + len : 'before Day 1') + ', which is ' + when,
      tasks: (tasks || []).map(function (t) { return '- ' + t.subject + ': ' + dcCleanTask(t.task_text); }).join('\n') || '- (nothing scheduled)',
      target_marks: batch === 'D' ? '70' : '85',
      day_length: String(len),
      // No ?batch=: visitors without an account already land on 120 Days -
      // 70 Marks by default (2026-10-09, direct request).
      roadmap_link: 'https://taai.live/gate-da-progress-tracker',
      course_link: 'https://taai.live/gate-da-courses',
    };
  }
  function dcCaptionPrompt(batch, iso, tasks) {
    var tpl = state.dayCard.template || DC_DEFAULT_PROMPT;
    var vals = dcPromptValues(batch, iso, tasks);
    return withFestivalPrompt(tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(vals, k) ? vals[k] : m; }), iso);
  }
  function loadDayCardTemplate() {
    var dc = state.dayCard;
    if (dc.templateLoaded) return;
    dc.templateLoaded = true;
    api('/site-settings').then(function (d) { dc.template = (d.row && d.row.daycard_prompt_template) || null; })
      .catch(function () { dc.template = null; })
      .then(function () { if (state.tab === 'day-card') render(); });
  }

  function renderDayCard() {
    var dc = state.dayCard, iso = dcSelectedDate();
    if (!dc.themeRestored) { dc.themeRestored = true; try { var saved = localStorage.getItem('taai_daycard_theme'); if (saved === 'auto' || DC_THEMES.some(function (t) { return t.id === saved; })) dc.theme = saved; } catch (e) {} }
    var tasks = dcTasksFor(dc.batch, iso);
    var opt = function (v, label, cur) { return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + label + '</option>'; };
    var status = dc.error ? '<div class="msg msg-error">' + escapeHtml(dc.error) + '</div>'
      : dc.loading || tasks === null ? '<div class="sub">Loading the schedule…</div>'
      : !tasks.length ? '<div class="msg msg-error">Nothing is scheduled for ' + escapeHtml(DC_BATCHES[dc.batch].label) + ' on ' + escapeHtml(iso) + '.</div>'
      : '';
    return '<div class="card daycard">' +
      '<div class="daycard-controls">' +
        '<label class="field">Batch<select id="dc-batch">' + opt('D', DC_BATCHES.D.label, dc.batch) + opt('C', DC_BATCHES.C.label, dc.batch) + '</select></label>' +
        '<label class="field">Day<select id="dc-which">' + opt('today', 'Today', dc.which) + opt('tomorrow', 'Tomorrow', dc.which) + opt('custom', 'Pick a date', dc.which) + '</select></label>' +
        (dc.which === 'custom' ? '<label class="field">Date<input type="date" id="dc-date" value="' + escapeHtml(dc.date || dcTodayIST()) + '"></label>' : '') +
        '<div class="field daycard-theme-field">Colour<div class="daycard-themes" role="radiogroup" aria-label="Colour scheme">' +
          '<button type="button" class="daycard-theme daycard-theme--auto' + (dc.theme === 'auto' ? ' selected' : '') + '" data-theme="auto" role="radio" aria-checked="' + (dc.theme === 'auto') + '" title="Changes every day (Day 1 Violet, Day 2 Ocean, ...)">Auto</button>' +
          DC_THEMES.map(function (t) { return '<button type="button" class="daycard-theme' + (dc.theme === t.id ? ' selected' : '') + '" data-theme="' + t.id + '" role="radio" aria-checked="' + (dc.theme === t.id) + '" title="' + t.name + '" aria-label="' + t.name + '" style="background:' + t.accent + '"></button>'; }).join('') +
        '</div></div>' +
        '<button class="btn btn-primary" id="dc-download"' + (tasks && tasks.length ? '' : ' disabled') + '>Download PNG</button>' +
      '</div>' +
      status +
      '<div class="daycard-preview"><canvas id="daycard-canvas" width="1080" height="1080"></canvas></div>' +
      '<div class="sub">1080 × 1080, ' + escapeHtml(dcThemeFor(dc.theme, dcDayNumber(dc.batch, iso)).name) + (dc.theme === 'auto' ? ' (Auto: changes every day)' : '') + '. Task text comes straight from the live schedule.</div>' +
      '<div class="daycard-caption">' +
        '<div class="daycard-caption-head"><strong>Caption prompt</strong>' +
          '<button class="btn btn-primary" id="dc-prompt-copy"' + (tasks && tasks.length ? '' : ' disabled') + '>Copy prompt</button>' +
        '</div>' +
        '<div class="sub">Filled in for the day above. You can edit it here before copying; paste it into any AI chat to get the caption.</div>' +
        '<textarea id="dc-prompt-text" rows="16">' + escapeHtml(tasks && tasks.length ? dcCaptionPrompt(dc.batch, iso, tasks) : '') + '</textarea>' +
        '<div class="daycard-caption-head"><span class="sub">' + (dc.template ? 'Using your saved template.' : 'Using the built-in template.') + '</span>' +
          '<button class="btn" id="dc-tpl-toggle">' + (dc.editingTemplate ? 'Close editor' : 'Edit template') + '</button>' +
        '</div>' +
        (dc.editingTemplate
          ? '<div class="sub">Placeholders filled in for each day: ' + DC_PROMPT_PLACEHOLDERS.map(function (k) { return '<code>{{' + k + '}}</code>'; }).join(' ') + '. Saved for everyone on /team, no deploy needed.</div>' +
            '<textarea id="dc-tpl-text" rows="22">' + escapeHtml(dc.templateDraft != null ? dc.templateDraft : (dc.template || DC_DEFAULT_PROMPT)) + '</textarea>' +
            '<div class="daycard-caption-head">' +
              (dc.templateMsg ? '<span class="sub">' + escapeHtml(dc.templateMsg) + '</span>' : '<span></span>') +
              '<button class="btn" id="dc-tpl-reset"' + (dc.templateSaving ? ' disabled' : '') + '>Reset to default</button>' +
              '<button class="btn btn-primary" id="dc-tpl-save"' + (dc.templateSaving ? ' disabled' : '') + '>' + (dc.templateSaving ? 'Saving…' : 'Save template') + '</button>' +
            '</div>'
          : '') +
      '</div>' +
    '</div>';
  }

  function bindDayCard() {
    var dc = state.dayCard;
    var b = document.getElementById('dc-batch');
    if (b) b.addEventListener('change', function () { dc.batch = b.value; render(); loadDayCardMonth(); });
    var w = document.getElementById('dc-which');
    if (w) w.addEventListener('change', function () { dc.which = w.value; if (dc.which === 'custom' && !dc.date) dc.date = dcTodayIST(); render(); loadDayCardMonth(); });
    var d = document.getElementById('dc-date');
    if (d) d.addEventListener('change', function () { if (d.value) { dc.date = d.value; render(); loadDayCardMonth(); } });
    Array.prototype.forEach.call(document.querySelectorAll('.daycard-theme'), function (btn) {
      btn.addEventListener('click', function () { dc.theme = btn.getAttribute('data-theme'); try { localStorage.setItem('taai_daycard_theme', dc.theme); } catch (e) {} render(); });
    });
    var dl = document.getElementById('dc-download');
    if (dl) dl.addEventListener('click', function () {
      var c = document.getElementById('daycard-canvas'); if (!c) return;
      var iso = dcSelectedDate();
      c.toBlob(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'taai-' + (dc.batch === 'D' ? '120-days' : 'batch-c') + '-' + iso + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      }, 'image/png');
    });
    var tt = document.getElementById('dc-tpl-toggle');
    if (tt) tt.addEventListener('click', function () { dc.editingTemplate = !dc.editingTemplate; dc.templateMsg = null; dc.templateDraft = null; render(); });
    var saveTpl = function (value) {
      var ta2 = document.getElementById('dc-tpl-text'); if (ta2) dc.templateDraft = ta2.value;
      dc.templateSaving = true; dc.templateMsg = null; render();
      api('/site-settings', { method: 'PUT', body: JSON.stringify({ daycard_prompt_template: value }) })
        .then(function (d) { dc.template = (d.row && d.row.daycard_prompt_template) || null; dc.templateDraft = null; dc.templateMsg = value ? 'Saved.' : 'Back to the built-in template.'; })
        .catch(function (e) { dc.templateMsg = 'Could not save: ' + e.message; })
        .then(function () { dc.templateSaving = false; render(); });
    };
    var ts = document.getElementById('dc-tpl-save');
    if (ts) ts.addEventListener('click', function () {
      var v = (document.getElementById('dc-tpl-text') || {}).value || '';
      saveTpl(v.trim() === DC_DEFAULT_PROMPT.trim() ? '' : v);
    });
    var tr = document.getElementById('dc-tpl-reset');
    if (tr) tr.addEventListener('click', function () { if (confirm('Reset the caption prompt to the built-in template?')) saveTpl(''); });
    var cp = document.getElementById('dc-prompt-copy');
    if (cp) cp.addEventListener('click', function () {
      var ta = document.getElementById('dc-prompt-text'); if (!ta) return;
      var done = function () { cp.textContent = 'Copied'; setTimeout(function () { cp.textContent = 'Copy prompt'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); document.execCommand('copy'); done(); });
      else { ta.select(); document.execCommand('copy'); done(); }
    });
    drawDayCard();
  }

  // Colour schemes for the Day card (2026-10-09: "5 different colour schemes
  // for day after day"). 'auto' rotates them by day number so consecutive
  // posts look different; any one can also be picked. The gold offer panel
  // and the 70-marks medal stay gold in every scheme (that's the offer's
  // own colour).
  var DC_THEMES = [
    { id: 'violet', name: 'Violet', bg: '#0d0a1c', glow: '139,92,246', accent: '#A78BFA', deep: '#8B5CF6', soft: '#C4B5FD', light: '#E9D5FF', pillText: '#E9E2FF' },
    { id: 'ocean', name: 'Ocean', bg: '#061320', glow: '14,165,233', accent: '#38BDF8', deep: '#0EA5E9', soft: '#7DD3FC', light: '#E0F2FE', pillText: '#E0F2FE' },
    { id: 'emerald', name: 'Emerald', bg: '#04140f', glow: '16,185,129', accent: '#34D399', deep: '#10B981', soft: '#6EE7B7', light: '#D1FAE5', pillText: '#D1FAE5' },
    { id: 'rose', name: 'Rose', bg: '#1a0812', glow: '244,63,94', accent: '#FB7185', deep: '#F43F5E', soft: '#FDA4AF', light: '#FFE4E6', pillText: '#FFE4E6' },
    { id: 'midnight', name: 'Midnight', bg: '#070b1f', glow: '99,102,241', accent: '#818CF8', deep: '#6366F1', soft: '#A5B4FC', light: '#E0E7FF', pillText: '#E0E7FF' },
  ];
  function dcThemeFor(choice, dayNum) {
    if (choice && choice !== 'auto') { for (var i = 0; i < DC_THEMES.length; i++) if (DC_THEMES[i].id === choice) return DC_THEMES[i]; }
    var n = Math.max(1, dayNum || 1);
    return DC_THEMES[(n - 1) % DC_THEMES.length];
  }
  function dcHexA(hex, a) {
    var h = hex.replace('#', ''); return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ',' + a + ')';
  }

  var dcLogo = null;
  function dcWrap(ctx, text, maxW) {
    var words = String(text).split(/\s+/), lines = [], line = '';
    words.forEach(function (wd) {
      var t = line ? line + ' ' + wd : wd;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = wd; } else line = t;
    });
    if (line) lines.push(line);
    return lines;
  }
  function dcRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function dcCleanTask(t) { return String(t || '').replace(/\s*\(Done\)\s*$/i, ''); }

  // The card is a full pitch (2026-10-09: "all the relevant info about the
  // 100 pe 100% off offer as well, and the day counter and the marks etc,
  // make it a convincing pitch"): day badge, plan + date, three stat chips
  // (target marks, days to GATE, free), the day's tasks (font steps down
  // to fit), then the gold challenge panel and the footer link.
  function drawDayCard() {
    var c = document.getElementById('daycard-canvas'); if (!c) return;
    var dc = state.dayCard, iso = dcSelectedDate(), tasks = dcTasksFor(dc.batch, iso);
    if (!dcLogo) { dcLogo = new Image(); dcLogo.onload = function () { drawDayCard(); }; dcLogo.src = '/logo.webp'; }
    var FONT = '"Poppins", "Geist", system-ui, sans-serif';
    // Layout follows the ads-create brief (concept A, "Countdown"): a giant
    // day number is the hook, two stat boxes, the tasks, then the gold
    // offer panel. Always "roadmap", never "plan".
    // Neo-brutalist poster (2026-10-15, "can the schedule poster be in neo brutalism form"): cream page,
    // 4px black borders, hard offset shadows, flat colour blocks, same content and layout as before.
    // The colour picker / Auto rotation now picks the flat pastel of the day-number block and journey bar.
    var MONO = '"Geist Mono", ui-monospace, monospace';
    var go = function () {
      var ctx = c.getContext('2d'), S = 1080, P = 72, INK = '#111111', PAPER = '#FFF4D6', YEL = '#FDE047';
      ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';
      var TH = dcThemeFor(dc.theme, dcDayNumber(dc.batch, iso)), FILL = TH.soft;
      // Flat bordered box with a hard offset shadow.
      var box = function (x, y, w, h, fill, sh, shCol, bw) {
        sh = sh == null ? 8 : sh; bw = bw || 4;
        if (sh) { ctx.fillStyle = shCol || INK; ctx.fillRect(x + sh, y + sh, w, h); }
        ctx.fillStyle = fill; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = INK; ctx.lineWidth = bw; ctx.strokeRect(x + bw / 2, y + bw / 2, w - bw, h - bw);
      };
      ctx.fillStyle = PAPER; ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = 'rgba(17,17,17,0.09)';
      for (var gx = 18; gx < S; gx += 36) for (var gy = 18; gy < S; gy += 36) { ctx.beginPath(); ctx.arc(gx, gy, 1.6, 0, Math.PI * 2); ctx.fill(); }

      var dayNum = dcDayNumber(dc.batch, iso), len = DC_BATCHES[dc.batch].length;
      var today = dcTodayIST();
      var which = iso === today ? "Today's roadmap" : iso === dcAddDays(today, 1) ? "Tomorrow's roadmap" : 'Roadmap';
      var dateShort = new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/^(\w+) /, '$1, ');

      // Header: logo + yellow batch tag.
      if (dcLogo && dcLogo.complete && dcLogo.naturalWidth) ctx.drawImage(dcLogo, 104, 68, 150, 80, P, P - 2, 56 * 150 / 80, 56);
      ctx.font = '700 25px ' + FONT;
      var pill = DC_BATCHES[dc.batch].label, pw = ctx.measureText(pill).width + 40;
      box(S - P - pw - 6, P, pw, 54, YEL, 6);
      ctx.fillStyle = INK; ctx.textBaseline = 'middle'; ctx.fillText(pill, S - P - pw - 6 + 20, P + 28); ctx.textBaseline = 'alphabetic';
      drawFestivalTag(ctx, iso, P, MONO);

      // Hero: day number in a flat colour block (left), "done before the exam" box (right).
      var heroTop = 172, hbW = 500, hbH = 250;
      box(P, heroTop, hbW, hbH, FILL, 10);
      ctx.fillStyle = INK; ctx.font = '500 26px ' + MONO;
      ctx.fillText(dayNum > 0 ? 'DAY' : 'STARTING', P + 30, heroTop + 50);
      var numText = dayNum > 0 ? String(dayNum) : 'soon';
      ctx.font = '800 150px ' + FONT; ctx.fillText(numText, P + 24, heroTop + 190);
      var nw = ctx.measureText(numText).width;
      if (dayNum > 0) { ctx.font = '600 40px ' + FONT; ctx.fillStyle = 'rgba(17,17,17,0.6)'; ctx.fillText('/ ' + len, P + 24 + nw + 10, heroTop + 190); }
      // date strip as a black tag across the bottom of the block
      ctx.fillStyle = INK; ctx.fillRect(P, heroTop + hbH - 46, hbW, 46);
      ctx.fillStyle = PAPER; ctx.font = '600 23px ' + FONT; ctx.textBaseline = 'middle';
      ctx.fillText(which + ' · ' + dateShort, P + 26, heroTop + hbH - 22); ctx.textBaseline = 'alphabetic';

      var bx = P + hbW + 40, by0 = heroTop, bw3 = S - P - bx - 10, bh3 = hbH;
      box(bx, by0, bw3, bh3, '#FFFFFF', 10);
      ctx.fillStyle = INK; ctx.font = '500 21px ' + MONO;
      ctx.fillText('DONE BEFORE THE EXAM', bx + 26, by0 + 46);
      ['Lectures', 'Revision', 'Quizzes', 'Tests'].forEach(function (lbl, i3) {
        var cx2 = bx + 26, ly2 = by0 + 92 + i3 * 40;
        ctx.fillStyle = '#BEF264'; ctx.fillRect(cx2, ly2 - 24, 28, 28);
        ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.strokeRect(cx2 + 1.5, ly2 - 22.5, 25, 25);
        ctx.lineWidth = 3.5; ctx.lineCap = 'square'; ctx.beginPath(); ctx.moveTo(cx2 + 7, ly2 - 10); ctx.lineTo(cx2 + 12, ly2 - 5); ctx.lineTo(cx2 + 21, ly2 - 17); ctx.stroke(); ctx.lineCap = 'butt';
        ctx.fillStyle = INK; ctx.font = '600 26px ' + FONT; ctx.fillText(lbl, cx2 + 42, ly2);
      });

      // Offer panel + footer from the bottom up.
      var footY = S - P + 4;
      var panelH = 214, panelY = footY - 44 - panelH;

      // Journey track: bordered bar filled to this day, square "you are here" marker, square marks badge.
      var trackY = heroTop + hbH + 66, badgeS = 92, badgeX = S - P - badgeS - 8, barX0 = P, barX1 = badgeX - 26, barH = 26;
      var frac = Math.max(0.02, Math.min(1, dayNum / len));
      box(barX0, trackY - barH / 2, barX1 - barX0, barH, '#FFFFFF', 5, null, 3);
      var fx = barX0 + (barX1 - barX0) * frac;
      ctx.fillStyle = FILL; ctx.fillRect(barX0 + 3, trackY - barH / 2 + 3, Math.max(4, fx - barX0 - 3), barH - 6);
      for (var m = 30; m < len; m += 30) { var mx = barX0 + (barX1 - barX0) * (m / len); ctx.fillStyle = INK; ctx.fillRect(mx - 1.5, trackY - barH / 2, 3, barH); }
      ctx.fillStyle = YEL; ctx.fillRect(fx - 15, trackY - 15, 30, 30); ctx.strokeStyle = INK; ctx.lineWidth = 4; ctx.strokeRect(fx - 13, trackY - 13, 26, 26);
      ctx.font = '500 20px ' + MONO; ctx.fillStyle = INK;
      var hereLbl = dayNum > 0 ? 'YOU ARE HERE · DAY ' + dayNum : 'DAY 1 IS COMING';
      var hlw = ctx.measureText(hereLbl).width;
      ctx.fillText(hereLbl, Math.min(Math.max(barX0, fx - hlw / 2), barX1 - hlw), trackY + 48);
      var goalLbl = 'DAY ' + len; ctx.fillText(goalLbl, barX1 - ctx.measureText(goalLbl).width, trackY - 26);
      box(badgeX, trackY - badgeS / 2, badgeS, badgeS, YEL, 6);
      ctx.fillStyle = INK; ctx.textAlign = 'center';
      ctx.font = '800 38px ' + FONT; ctx.fillText(dc.batch === 'D' ? '70' : '85', badgeX + badgeS / 2, trackY + 8);
      ctx.font = '500 14px ' + MONO; ctx.fillText('MARKS', badgeX + badgeS / 2, trackY + 30);
      ctx.textAlign = 'left';

      // Tasks between the track and the panel: subject first and big with a bordered colour square,
      // lecture detail smaller beside it (or below it when both don't fit).
      var top = trackY + 76, bottom = panelY - 26;
      var list = tasks || [];
      var rowX = P + 46, rowW = S - P - rowX;
      var sizes = [[42, 28], [40, 27], [38, 26], [36, 25], [34, 24], [32, 23], [30, 22]], pick = sizes[sizes.length - 1];
      var layoutRow = function (t, sz) {
        ctx.font = '700 ' + sz[0] + 'px ' + FONT; var sw = ctx.measureText(t.subject).width;
        ctx.font = '500 ' + sz[1] + 'px ' + FONT; var detail = dcCleanTask(t.task_text), dw = ctx.measureText(detail).width;
        var inline = sw + 22 + dw <= rowW;
        return { sw: sw, detail: detail, inline: inline, h: inline ? sz[0] + 22 : sz[0] + 10 + sz[1] + 22 };
      };
      for (var k = 0; k < sizes.length; k++) {
        var hs = 0;
        list.forEach(function (t) { hs += layoutRow(t, sizes[k]).h; });
        if (top + hs <= bottom) { pick = sizes[k]; break; }
      }
      var ty = top;
      list.forEach(function (t) {
        var col = DC_SUBJECT_COLORS[t.subject] || '#A78BFA';
        var L = layoutRow(t, pick), base = ty + pick[0];
        var sq = 24, sqY = base - pick[0] * 0.34 - sq / 2;
        ctx.fillStyle = col; ctx.fillRect(P, sqY, sq, sq); ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.strokeRect(P + 1.5, sqY + 1.5, sq - 3, sq - 3);
        ctx.fillStyle = INK; ctx.font = '700 ' + pick[0] + 'px ' + FONT; ctx.fillText(t.subject, rowX, base);
        ctx.font = '500 ' + pick[1] + 'px ' + FONT; ctx.fillStyle = '#3A3A3A';
        var detail = L.detail; while (ctx.measureText(detail).width > rowW && detail.length > 4) detail = detail.slice(0, -2) + '…';
        if (L.inline) ctx.fillText(detail, rowX + L.sw + 22, base);
        else ctx.fillText(detail, rowX, base + 10 + pick[1]);
        ty += L.h;
      });
      if (!list.length) {
        ctx.fillStyle = '#3A3A3A'; ctx.font = '500 30px ' + FONT;
        ctx.fillText(tasks === null ? 'Loading…' : 'Nothing scheduled for this day.', P, top + 36);
      }

      // Offer panel: black block with a yellow hard shadow.
      box(P, panelY, S - 2 * P - 10, panelH, INK, 10, YEL);
      var px = P + 34;
      ctx.font = '700 22px ' + FONT;
      var tag = '100 pe 100% off', tw = ctx.measureText(tag).width + 28;
      ctx.fillStyle = YEL; ctx.fillRect(px, panelY + 26, tw, 38);
      ctx.fillStyle = INK; ctx.textBaseline = 'middle'; ctx.fillText(tag, px + 14, panelY + 45); ctx.textBaseline = 'alphabetic';
      ctx.font = '600 22px ' + FONT; ctx.fillStyle = 'rgba(255,244,214,0.85)';
      ctx.fillText('on the GATE 2028 Full Course', px + tw + 16, panelY + 53);
      ctx.font = '700 40px ' + FONT; ctx.fillStyle = '#FFFFFF';
      ctx.fillText('AIR under 100 in GATE DA 2027', px, panelY + 110);
      ctx.fillStyle = YEL; ctx.fillText('= 100% of your fee back.', px, panelY + 156);
      ctx.font = '500 21px ' + FONT; ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText('You keep full access. Last year, 65 marks got AIR 90.', px, panelY + 193);

      // Footer: line + yellow-highlighted URL.
      ctx.font = '600 26px ' + FONT; ctx.fillStyle = INK;
      ctx.fillText('Follow the free roadmap, a task every day', P, footY);
      ctx.font = '700 26px ' + FONT;
      var url = 'taai.live', uw = ctx.measureText(url).width;
      ctx.fillStyle = YEL; ctx.fillRect(S - P - uw - 16, footY - 30, uw + 16, 40);
      ctx.fillStyle = INK; ctx.fillText(url, S - P - uw - 8, footY);
    };
    if (document.fonts && document.fonts.load) {
      Promise.all(['800 150px Poppins', '700 38px Poppins', '600 30px Poppins', '500 26px Poppins', '500 21px "Geist Mono"'].map(function (f) { return document.fonts.load(f); })).then(go, go);
    } else go();
  }

  // ── Offer poster (2026-10-18) ─────────────────────────────────────────
  // "Super early bird is expiring" poster: a countdown to the GATE 2028
  // Full Course offer deadline that asks people to fill the "100 pe 100%
  // off" challenge form (taai.live/challenge), plus a copyable caption
  // prompt. Price and deadline come live from /api/site-pricing-public
  // (full-course-2028); the challenge cutoff from /api/challenge-register.
  // OP_NEXT_PRICE mirrors netlify/functions/pricing-2028-cutover.js (the
  // automatic switch after Oct 20): update both together.
  var OP_COURSE_ID = 'full-course-2028';
  var OP_NEXT_PRICE = 11999;
  var OP_CHALLENGE_LINK = 'https://taai.live/challenge';
  var OP_COURSE_LINK = 'https://taai.live/gate-da-courses';

  function loadOfferPoster() {
    var op = state.offerPoster;
    loadOfferPosterTemplate();
    if (op.pricing || op.loading) { drawOfferPoster(); return; }
    op.loading = true; op.error = null; render();
    Promise.all([
      fetch('/api/site-pricing-public').then(function (r) { if (!r.ok) throw new Error('pricing ' + r.status); return r.json(); }),
      fetch('/api/challenge-register').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
    ]).then(function (res) {
      var rows = (res[0] && res[0].rows) || {};
      op.pricing = rows[OP_COURSE_ID] || {};
      op.cutoff = (res[1] && res[1].cutoff) || '2027-01-04';
    }).catch(function (e) { op.error = 'Could not load the course price: ' + e.message; })
      .then(function () { op.loading = false; if (state.tab === 'offer-poster') render(); });
  }

  function opPostDate() { var t = dcTodayIST(); return state.offerPoster.which === 'tomorrow' ? dcAddDays(t, 1) : t; }
  // Days left counting the post date itself: deadline day = 1 ("Last day").
  function opDaysLeft() {
    var pr = state.offerPoster.pricing;
    if (!pr || !pr.discount_deadline) return null;
    return dcDiffDays(String(pr.discount_deadline).slice(0, 10), opPostDate()) + 1;
  }
  function opRupees(n) { return '₹' + Number(n).toLocaleString('en-IN'); }
  function opDate(iso, withYear) {
    return new Date(iso + 'T00:00:00+05:30').toLocaleDateString('en-US', withYear ? { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Kolkata' } : { month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' });
  }
  // Two posters (2026-10-19, "after the offer ends we still have to circulate
  // the registration link poster; it can't show the previous lower price"):
  // 'offer' = super early bird countdown; 'challenge' = registration countdown
  // to the challenge cutoff, current price only, no old/next price. 'auto'
  // shows the offer poster while the offer runs, the challenge one after.
  function opOfferActive() { var l = opDaysLeft(); return !!state.offerPoster.pricing && l != null && l >= 1; }
  function opMode() { var m = state.offerPoster.mode; return m === 'auto' ? (opOfferActive() ? 'offer' : 'challenge') : m; }
  function opCutoffLeft() { var c = state.offerPoster.cutoff; return c ? dcDiffDays(c, opPostDate()) + 1 : null; }
  function opReady() {
    var op = state.offerPoster;
    if (!op.pricing) return false;
    if (opMode() === 'offer') return opOfferActive();
    var cl = opCutoffLeft(); return cl != null && cl >= 1;
  }

  // Editable caption template (2026-10-19, "make all the prompts editable"):
  // stored in site_settings.offer_prompt_template (NULL = this built-in
  // default), {{placeholders}} filled for the chosen post day.
  var OP_PROMPT_PLACEHOLDERS = ['post_date', 'when_line', 'price', 'offer_end', 'next_price_date', 'next_price', 'challenge_cutoff', 'challenge_link', 'course_link', 'roadmap_link'];
  var OP_DEFAULT_PROMPT = [
    'Write a short social media caption (Instagram / LinkedIn / WhatsApp channel) for TAAI, a GATE DA (Data Science and AI) exam-prep brand in India. It goes with a poster that already shows the countdown, the prices and the challenge, so keep the caption short and don\'t repeat everything.',
    '',
    'Goal: get people to enrol in the GATE 2028 Full Course before the super early bird offer ends, and then fill the "100 pe 100% off" challenge form.',
    '',
    'This post goes out on {{post_date}}: {{when_line}}.',
    '',
    'Facts you may use (use nothing else):',
    '- Super early bird price of the GATE 2028 Full Course: {{price}} until {{offer_end}}. From {{next_price_date}} it goes up to {{next_price}}.',
    '- "100 pe 100% off": get an AIR under 100 in GATE DA 2027 and TAAI refunds your full GATE 2028 course fee, and you keep full access to the course.',
    '- To be eligible you must enrol in the GATE 2028 Full Course and fill the challenge form by {{challenge_cutoff}}. Only a GATE DA 2027 result counts.',
    '- GATE DA 2026: 65 marks got AIR 90.',
    '- Why TAAI can offer this: we are a small, independent team with no investors to answer to, so we get to celebrate merit by refunding the students who earn it. (A light, friendly tone is fine here.)',
    '- The course also prepares you for GATE DA 2028 and includes 5 portfolio projects (machine learning, computer vision, LLMs).',
    '- TAAI\'s day-by-day roadmap to GATE DA 2027 is free for everyone on the progress tracker (the last link). Mention it only briefly.',
    '',
    'Voice: sounds like a real person (a mentor) typing quickly, not a brand. Plain, direct, urgent but honest. Short sentences. No corporate words (journey, unlock, elevate, game-changer, dive in), no "Here\'s what...", no exclamation spam.',
    '',
    'Structure:',
    '1. Start with the 🔴 emoji followed by "100 pe 100% off", then a first line about the deadline that makes someone stop scrolling.',
    '2. One or two short lines: the price going up, and the challenge.',
    '3. A clear call to action to fill the challenge form after enrolling.',
    '4. These three links, each on its own line, exactly:',
    '   Challenge form: {{challenge_link}}',
    '   Course: {{course_link}}',
    '   Free roadmap: {{roadmap_link}}',
    '5. At most 3 hashtags on the last line.',
    '',
    'Rules:',
    '- Under 60 words before the links.',
    '- Create urgency only from the real deadline and price rise. Never invent seat limits, numbers of students, other deadlines, results, ranks or quotes.',
    '- Never say the refund is guaranteed or that filling the form alone earns it.',
    '- No em dashes or en dashes. Apart from the opening 🔴, at most 1 emoji.',
    '- Output only the caption.',
  ].join('\n');

  var OP_CHALLENGE_PROMPT = [
    'Write a short social media caption (Instagram / LinkedIn / WhatsApp channel) for TAAI, a GATE DA (Data Science and AI) exam-prep brand in India. It goes with a poster that already shows the challenge, the registration deadline and the steps, so keep the caption short and don\'t repeat everything.',
    '',
    'Goal: get people to enrol in the GATE 2028 Full Course and fill the "100 pe 100% off" challenge form before registration closes.',
    '',
    'This post goes out on {{post_date}}: {{when_line}}.',
    '',
    'Facts you may use (use nothing else):',
    '- "100 pe 100% off": get an AIR under 100 in GATE DA 2027 and TAAI refunds your full GATE 2028 course fee, and you keep full access to the course.',
    '- To be eligible you must enrol in the GATE 2028 Full Course and fill the challenge form by {{challenge_cutoff}}. Only a GATE DA 2027 result counts.',
    '- The GATE 2028 Full Course covers both GATE DA 2027 and 2028, and content for 65+ marks of GATE DA 2027 unlocks the day you join. Its price is {{price}}.',
    '- GATE DA 2026: 65 marks got AIR 90.',
    '- Why TAAI can offer this: we are a small, independent team with no investors to answer to, so we get to celebrate merit by refunding the students who earn it. (A light, friendly tone is fine here.)',
    '- The course includes 5 portfolio projects (machine learning, computer vision, LLMs).',
    '- TAAI\'s day-by-day roadmap to GATE DA 2027 is free for everyone on the progress tracker (the last link). Mention it only briefly.',
    '',
    'Voice: sounds like a real person (a mentor) typing quickly, not a brand. Plain, direct, a little bold. Short sentences. No corporate words (journey, unlock, elevate, game-changer, dive in), no "Here\'s what...", no exclamation spam.',
    '',
    'Structure:',
    '1. Start with the 🔴 emoji followed by "100 pe 100% off", then a first line about the challenge that makes someone stop scrolling.',
    '2. One or two short lines: what the challenge is and the registration deadline.',
    '3. A clear call to action to enrol in the course and fill the challenge form.',
    '4. These three links, each on its own line, exactly:',
    '   Challenge form: {{challenge_link}}',
    '   Course: {{course_link}}',
    '   Free roadmap: {{roadmap_link}}',
    '5. At most 3 hashtags on the last line.',
    '',
    'Rules:',
    '- Under 60 words before the links.',
    '- Do not mention any offer, discount, early bird price or price rise.',
    '- Never invent seat limits, numbers of students, other deadlines, results, ranks or quotes.',
    '- Never say the refund is guaranteed or that filling the form alone earns it.',
    '- No em dashes or en dashes. Apart from the opening 🔴, at most 1 emoji.',
    '- Output only the caption.',
  ].join('\n');

  function opPromptValues() {
    var op = state.offerPoster, pr = op.pricing, left = opDaysLeft();
    var deadline = pr.discount_deadline ? String(pr.discount_deadline).slice(0, 10) : opPostDate();
    var cl = opCutoffLeft();
    var challengeWhen = cl <= 1 ? 'challenge registration closes TONIGHT (' + opDate(op.cutoff, true) + ')'
      : cl === 2 ? 'challenge registration closes TOMORROW (' + opDate(op.cutoff, true) + ')'
      : cl + ' days are left to register for the challenge, counting today (it closes ' + opDate(op.cutoff, true) + ')';
    return {
      post_date: new Date(opPostDate() + 'T00:00:00+05:30').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' }),
      when_line: opMode() === 'challenge' ? challengeWhen : left <= 1 ? 'today is the LAST day of the offer (it ends tonight, ' + opDate(deadline) + ')'
        : left === 2 ? 'the offer ends TOMORROW (' + opDate(deadline) + ', 11:59 PM)'
        : left + ' days are left in the offer, counting today (it ends ' + opDate(deadline) + ')',
      price: opRupees(pr.price),
      offer_end: opDate(deadline),
      next_price_date: opDate(dcAddDays(deadline, 1)),
      next_price: opRupees(OP_NEXT_PRICE),
      challenge_cutoff: opDate(op.cutoff, true),
      challenge_link: OP_CHALLENGE_LINK,
      course_link: OP_COURSE_LINK,
      roadmap_link: 'https://taai.live/gate-da-progress-tracker',
    };
  }
  function opDefaultPrompt() { return opMode() === 'challenge' ? OP_CHALLENGE_PROMPT : OP_DEFAULT_PROMPT; }
  function opSavedTemplate() { var op = state.offerPoster; return opMode() === 'challenge' ? op.challengeTemplate : op.template; }
  function opCaptionPrompt() {
    var tpl = opSavedTemplate() || opDefaultPrompt(), vals = opPromptValues();
    return withFestivalPrompt(tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(vals, k) ? vals[k] : m; }), opPostDate());
  }
  function loadOfferPosterTemplate() {
    var op = state.offerPoster;
    if (op.templateLoaded) return;
    op.templateLoaded = true;
    api('/site-settings').then(function (d) { op.template = (d.row && d.row.offer_prompt_template) || null; op.challengeTemplate = (d.row && d.row.challenge_prompt_template) || null; })
      .catch(function () { op.template = null; op.challengeTemplate = null; })
      .then(function () { if (state.tab === 'offer-poster') render(); });
  }

  function renderOfferPoster() {
    var op = state.offerPoster, left = opDaysLeft(), mode = op.pricing ? opMode() : null, cl = opCutoffLeft();
    var ready = opReady();
    var opt = function (v, label) { return '<option value="' + v + '"' + (v === op.which ? ' selected' : '') + '>' + label + '</option>'; };
    var mopt = function (v, label) { return '<option value="' + v + '"' + (v === op.mode ? ' selected' : '') + '>' + label + '</option>'; };
    var status = op.error ? '<div class="msg msg-error">' + escapeHtml(op.error) + '</div>'
      : op.loading || !op.pricing ? '<div class="sub">Loading the offer…</div>'
      : mode === 'offer' && !opOfferActive() ? '<div class="msg msg-error">The super early bird offer isn\'t running on the post day. Pick "Challenge registration" (or Auto) to make the registration poster instead.</div>'
      : mode === 'challenge' && (cl == null || cl < 1) ? '<div class="msg msg-error">Challenge registration closed on ' + escapeHtml(opDate(op.cutoff, true)) + '. Change the cutoff in the Challenge tab if it moved.</div>'
      : '';
    var countdownNote = !ready ? '' : mode === 'offer'
      ? ' Early bird poster. Countdown: ' + (left === 1 ? 'offer ends today' : left === 2 ? 'offer ends tomorrow' : left + ' days left') + ' on the post day.'
      : ' Challenge poster: current price only, no offer. Countdown: ' + (cl === 1 ? 'registration closes today' : cl === 2 ? 'closes tomorrow' : cl + ' days left to register') + ' on the post day.';
    return '<div class="card daycard">' +
      '<div class="daycard-controls">' +
        '<label class="field">Poster<select id="op-mode">' + mopt('auto', 'Auto (offer, then challenge)') + mopt('offer', 'Early bird offer') + mopt('challenge', 'Challenge registration') + '</select></label>' +
        '<label class="field">Post day<select id="op-which">' + opt('today', 'Today') + opt('tomorrow', 'Tomorrow') + '</select></label>' +
        '<button class="btn btn-primary" id="op-download"' + (ready ? '' : ' disabled') + '>Download PNG</button>' +
      '</div>' +
      status +
      '<div class="daycard-preview"><canvas id="offer-canvas" width="1080" height="1080"></canvas></div>' +
      '<div class="sub">1080 × 1080. Price, offer deadline and challenge cutoff come live from Site data.' + countdownNote + '</div>' +
      '<div class="daycard-caption">' +
        '<div class="daycard-caption-head"><strong>Caption prompt</strong>' +
          '<button class="btn btn-primary" id="op-prompt-copy"' + (ready ? '' : ' disabled') + '>Copy prompt</button>' +
        '</div>' +
        '<div class="sub">Filled in for the post day above. You can edit it here before copying; paste it into any AI chat to get the caption.</div>' +
        '<textarea id="op-prompt-text" rows="18">' + escapeHtml(ready ? opCaptionPrompt() : '') + '</textarea>' +
        '<div class="daycard-caption-head"><span class="sub">' + (mode === 'challenge' ? 'Challenge poster prompt. ' : 'Early bird poster prompt. ') + (opSavedTemplate() ? 'Using your saved template.' : 'Using the built-in template.') + '</span>' +
          '<button class="btn" id="op-tpl-toggle">' + (op.editingTemplate ? 'Close editor' : 'Edit template') + '</button>' +
        '</div>' +
        (op.editingTemplate
          ? '<div class="sub">Placeholders filled in for each post day: ' + OP_PROMPT_PLACEHOLDERS.map(function (k) { return '<code>{{' + k + '}}</code>'; }).join(' ') + '. Saved for everyone on /team, no deploy needed.</div>' +
            '<textarea id="op-tpl-text" rows="22">' + escapeHtml(op.templateDraft != null ? op.templateDraft : (opSavedTemplate() || opDefaultPrompt())) + '</textarea>' +
            '<div class="daycard-caption-head">' +
              (op.templateMsg ? '<span class="sub">' + escapeHtml(op.templateMsg) + '</span>' : '<span></span>') +
              '<button class="btn" id="op-tpl-reset"' + (op.templateSaving ? ' disabled' : '') + '>Reset to default</button>' +
              '<button class="btn btn-primary" id="op-tpl-save"' + (op.templateSaving ? ' disabled' : '') + '>' + (op.templateSaving ? 'Saving…' : 'Save template') + '</button>' +
            '</div>'
          : '') +
      '</div>' +
    '</div>';
  }

  function bindOfferPoster() {
    var op = state.offerPoster;
    var w = document.getElementById('op-which');
    if (w) w.addEventListener('change', function () { op.which = w.value; render(); });
    var md = document.getElementById('op-mode');
    if (md) md.addEventListener('change', function () { op.mode = md.value; op.editingTemplate = false; op.templateDraft = null; op.templateMsg = null; render(); });
    var dl = document.getElementById('op-download');
    if (dl) dl.addEventListener('click', function () {
      var c = document.getElementById('offer-canvas'); if (!c) return;
      c.toBlob(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'taai-' + (opMode() === 'challenge' ? 'challenge' : 'early-bird') + '-' + opPostDate() + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      }, 'image/png');
    });
    var tt = document.getElementById('op-tpl-toggle');
    if (tt) tt.addEventListener('click', function () { op.editingTemplate = !op.editingTemplate; op.templateMsg = null; op.templateDraft = null; render(); });
    var saveTpl = function (value) {
      var ta2 = document.getElementById('op-tpl-text'); if (ta2) op.templateDraft = ta2.value;
      op.templateSaving = true; op.templateMsg = null; render();
      var key = opMode() === 'challenge' ? 'challenge_prompt_template' : 'offer_prompt_template';
      var body = {}; body[key] = value;
      api('/site-settings', { method: 'PUT', body: JSON.stringify(body) })
        .then(function (d) { if (key === 'challenge_prompt_template') op.challengeTemplate = (d.row && d.row.challenge_prompt_template) || null; else op.template = (d.row && d.row.offer_prompt_template) || null; op.templateDraft = null; op.templateMsg = value ? 'Saved.' : 'Back to the built-in template.'; })
        .catch(function (e) { op.templateMsg = 'Could not save: ' + e.message; })
        .then(function () { op.templateSaving = false; render(); });
    };
    var ts = document.getElementById('op-tpl-save');
    if (ts) ts.addEventListener('click', function () {
      var v = (document.getElementById('op-tpl-text') || {}).value || '';
      saveTpl(v.trim() === opDefaultPrompt().trim() ? '' : v);
    });
    var tr = document.getElementById('op-tpl-reset');
    if (tr) tr.addEventListener('click', function () { if (confirm('Reset the caption prompt to the built-in template?')) saveTpl(''); });
    var cp = document.getElementById('op-prompt-copy');
    if (cp) cp.addEventListener('click', function () {
      var ta = document.getElementById('op-prompt-text'); if (!ta) return;
      var done = function () { cp.textContent = 'Copied'; setTimeout(function () { cp.textContent = 'Copy prompt'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); document.execCommand('copy'); done(); });
      else { ta.select(); document.execCommand('copy'); done(); }
    });
    drawOfferPoster();
  }

  function drawOfferPoster() {
    var c = document.getElementById('offer-canvas'); if (!c) return;
    var op = state.offerPoster;
    if (!dcLogo) { dcLogo = new Image(); dcLogo.onload = function () { drawOfferPoster(); }; dcLogo.src = '/logo.webp'; }
    var FONT = '"Poppins", "Geist", system-ui, sans-serif', MONO = '"Geist Mono", ui-monospace, monospace';
    var go = function () {
      var ctx = c.getContext('2d'), S = 1080, P = 72, INK = '#111111', PAPER = '#FFF4D6', YEL = '#FDE047';
      ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      var box = function (x, y, w, h, fill, sh, shCol, bw) {
        sh = sh == null ? 8 : sh; bw = bw || 4;
        if (sh) { ctx.fillStyle = shCol || INK; ctx.fillRect(x + sh, y + sh, w, h); }
        ctx.fillStyle = fill; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = INK; ctx.lineWidth = bw; ctx.strokeRect(x + bw / 2, y + bw / 2, w - bw, h - bw);
      };
      ctx.fillStyle = PAPER; ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = 'rgba(17,17,17,0.09)';
      for (var gx = 18; gx < S; gx += 36) for (var gy = 18; gy < S; gy += 36) { ctx.beginPath(); ctx.arc(gx, gy, 1.6, 0, Math.PI * 2); ctx.fill(); }

      var pr = op.pricing, left = opDaysLeft();
      if (!pr || !opReady()) {
        ctx.fillStyle = INK; ctx.font = '600 34px ' + FONT;
        ctx.fillText(op.loading || !pr ? 'Loading…' : opMode() === 'offer' ? 'The super early bird offer has ended.' : 'Challenge registration has closed.', P, S / 2);
        return;
      }
      var foot = function () {
        var footY = S - P + 4;
        ctx.font = '600 28px ' + FONT; ctx.fillStyle = INK; ctx.textAlign = 'left';
        ctx.fillText('Fill the form at', P, footY);
        ctx.font = '800 34px ' + FONT;
        var url = 'taai.live/challenge', uw = ctx.measureText(url).width, ux = P + 236;
        ctx.fillStyle = YEL; ctx.fillRect(ux - 10, footY - 36, uw + 20, 48);
        ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.strokeRect(ux - 8.5, footY - 34.5, uw + 17, 45);
        ctx.fillStyle = INK; ctx.fillText(url, ux, footY);
      };
      var steps = function (stY, s1, s2) {
        var stH = 108, gap = 28, stW = (S - 2 * P - 10 - gap) / 2;
        [['1', s1[0], s1[1]], ['2', s2[0], s2[1]]].forEach(function (st, i) {
          var sx = P + i * (stW + gap);
          box(sx, stY, stW, stH, i === 1 ? YEL : '#FFFFFF', 6);
          ctx.fillStyle = INK; ctx.fillRect(sx + 20, stY + 24, 56, 56);
          ctx.fillStyle = PAPER; ctx.font = '800 34px ' + FONT; ctx.textAlign = 'center'; ctx.fillText(st[0], sx + 48, stY + 64); ctx.textAlign = 'left';
          ctx.fillStyle = INK; ctx.font = '700 27px ' + FONT; ctx.fillText(st[1], sx + 96, stY + 50);
          ctx.font = '500 21px ' + FONT; ctx.fillStyle = '#3A3A3A'; ctx.fillText(st[2], sx + 96, stY + 82);
        });
      };

      if (opMode() === 'challenge') {
        // Challenge registration poster (2026-10-19): no offer, no old or
        // next price; countdown to the registration cutoff instead.
        var cl = opCutoffLeft();
        if (dcLogo && dcLogo.complete && dcLogo.naturalWidth) ctx.drawImage(dcLogo, 104, 68, 150, 80, P, P - 2, 56 * 150 / 80, 56);
        ctx.font = '500 22px ' + MONO;
        var ctag = '100 PE 100% OFF · GATE 2028 FULL COURSE', ctw = ctx.measureText(ctag).width + 36;
        ctx.fillStyle = INK; ctx.fillRect(S - P - ctw, P + 2, ctw, 50);
        ctx.fillStyle = PAPER; ctx.textBaseline = 'middle'; ctx.fillText(ctag, S - P - ctw + 18, P + 28); ctx.textBaseline = 'alphabetic';
        drawFestivalTag(ctx, opPostDate(), P, MONO);

        var hT = 168, hW = 540, hH = 300;
        box(P, hT, hW, hH, '#C4B5FD', 10);
        ctx.fillStyle = INK; ctx.font = '500 24px ' + MONO; ctx.fillText('AIR UNDER 100 IN GATE DA 2027', P + 32, hT + 52);
        ctx.font = '800 150px ' + FONT; ctx.fillText('100%', P + 24, hT + 186);
        ctx.font = '800 38px ' + FONT; ctx.fillText('OF YOUR FEE BACK', P + 32, hT + 234);
        ctx.fillStyle = INK; ctx.fillRect(P, hT + hH - 48, hW, 48);
        ctx.fillStyle = PAPER; ctx.font = '600 24px ' + FONT; ctx.textBaseline = 'middle';
        ctx.fillText('And you keep the full course.', P + 28, hT + hH - 24); ctx.textBaseline = 'alphabetic';

        var rx = P + hW + 40, rw = S - P - rx - 10;
        box(rx, hT, rw, hH, '#FFFFFF', 10);
        ctx.fillStyle = INK; ctx.font = '500 20px ' + MONO; ctx.fillText('REGISTER BY', rx + 28, hT + 50);
        ctx.font = '800 64px ' + FONT; ctx.fillText(opDate(op.cutoff), rx + 26, hT + 122);
        ctx.font = '700 30px ' + FONT; ctx.fillText(op.cutoff.slice(0, 4), rx + 28, hT + 162);
        var chip = cl === 1 ? 'Closes TODAY' : cl === 2 ? 'Closes TOMORROW' : cl + ' days left';
        ctx.font = '800 26px ' + FONT;
        var chw = ctx.measureText(chip).width + 28;
        ctx.fillStyle = cl <= 2 ? '#FCA5A5' : '#F9A8D4'; ctx.fillRect(rx + 26, hT + 196, chw, 46);
        ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.strokeRect(rx + 27.5, hT + 197.5, chw - 3, 43);
        ctx.fillStyle = INK; ctx.textBaseline = 'middle'; ctx.fillText(chip, rx + 40, hT + 220); ctx.textBaseline = 'alphabetic';

        var pY = hT + hH + 48, pH = 214;
        box(P, pY, S - 2 * P - 10, pH, INK, 10, YEL);
        var qx = P + 34;
        ctx.font = '700 22px ' + FONT;
        var t2 = 'GATE 2028 Full Course', t2w = ctx.measureText(t2).width + 28;
        ctx.fillStyle = YEL; ctx.fillRect(qx, pY + 26, t2w, 38);
        ctx.fillStyle = INK; ctx.textBaseline = 'middle'; ctx.fillText(t2, qx + 14, pY + 45); ctx.textBaseline = 'alphabetic';
        ctx.font = '700 40px ' + FONT; ctx.fillStyle = '#FFFFFF';
        ctx.fillText('Covers GATE DA 2027 and 2028.', qx, pY + 110);
        ctx.fillStyle = YEL; ctx.fillText('65+ marks of content from day one.', qx, pY + 156);
        ctx.font = '500 21px ' + FONT; ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillText('Last year, 65 marks got AIR 90.', qx, pY + 193);

        steps(pY + pH + 44, ['Enrol in the course', 'at ' + opRupees(pr.price)], ['Fill the challenge form', 'by ' + opDate(op.cutoff, true)]);
        foot();
        return;
      }
      var deadline = String(pr.discount_deadline).slice(0, 10);
      var last = left === 1;

      // Header: logo + black tag.
      if (dcLogo && dcLogo.complete && dcLogo.naturalWidth) ctx.drawImage(dcLogo, 104, 68, 150, 80, P, P - 2, 56 * 150 / 80, 56);
      ctx.font = '500 22px ' + MONO;
      var tag = 'SUPER EARLY BIRD · GATE 2028 FULL COURSE', tgw = ctx.measureText(tag).width + 36;
      ctx.fillStyle = INK; ctx.fillRect(S - P - tgw, P + 2, tgw, 50);
      ctx.fillStyle = PAPER; ctx.textBaseline = 'middle'; ctx.fillText(tag, S - P - tgw + 18, P + 28); ctx.textBaseline = 'alphabetic';
      drawFestivalTag(ctx, opPostDate(), P, MONO);

      // Hero: the countdown (urgency colour) + price box.
      var heroTop = 168, hbW = 540, hbH = 300;
      var HOT = last ? '#FCA5A5' : left === 2 ? '#FDBA74' : '#F9A8D4';
      box(P, heroTop, hbW, hbH, HOT, 10);
      ctx.fillStyle = INK; ctx.font = '500 26px ' + MONO;
      // The last two days read "OFFER ENDS TODAY / TOMORROW" (2026-10-19,
      // direct request), earlier days "ONLY N DAYS LEFT".
      var endsWord = last ? 'TODAY' : left === 2 ? 'TOMORROW' : null;
      ctx.fillText(endsWord ? 'OFFER ENDS' : 'ONLY', P + 32, heroTop + 54);
      if (endsWord) {
        var fsz = 136;
        ctx.font = '800 ' + fsz + 'px ' + FONT;
        while (ctx.measureText(endsWord).width > hbW - 56 && fsz > 60) { fsz -= 4; ctx.font = '800 ' + fsz + 'px ' + FONT; }
        ctx.fillText(endsWord, P + 26, heroTop + 158 + fsz * 0.34);
      } else {
        ctx.font = '800 190px ' + FONT; ctx.fillText(String(left), P + 24, heroTop + 222);
        var nw = ctx.measureText(String(left)).width;
        ctx.font = '800 54px ' + FONT; ctx.fillText('DAYS', P + 24 + nw + 24, heroTop + 150);
        ctx.fillText('LEFT', P + 24 + nw + 24, heroTop + 208);
      }
      ctx.fillStyle = INK; ctx.fillRect(P, heroTop + hbH - 48, hbW, 48);
      ctx.fillStyle = PAPER; ctx.font = '600 24px ' + FONT; ctx.textBaseline = 'middle';
      ctx.fillText('Offer ends ' + opDate(deadline) + ', 11:59 PM', P + 28, heroTop + hbH - 24); ctx.textBaseline = 'alphabetic';

      var bx = P + hbW + 40, bw2 = S - P - bx - 10;
      box(bx, heroTop, bw2, hbH, '#FFFFFF', 10);
      ctx.fillStyle = INK; ctx.font = '500 20px ' + MONO; ctx.fillText('NOW', bx + 28, heroTop + 50);
      ctx.font = '800 64px ' + FONT; ctx.fillText(opRupees(pr.price), bx + 26, heroTop + 120);
      ctx.font = '500 20px ' + MONO; ctx.fillStyle = 'rgba(17,17,17,0.65)';
      ctx.fillText('FROM ' + opDate(dcAddDays(deadline, 1)).toUpperCase() + ' IT GOES UP TO', bx + 28, heroTop + 172);
      ctx.font = '700 44px ' + FONT; ctx.fillStyle = '#B91C1C';
      ctx.fillText(opRupees(OP_NEXT_PRICE), bx + 26, heroTop + 222);
      ctx.font = '700 22px ' + FONT;
      var save = 'Save ' + opRupees(OP_NEXT_PRICE - pr.price), sw2 = ctx.measureText(save).width + 24;
      ctx.fillStyle = '#BEF264'; ctx.fillRect(bx + 26, heroTop + 244, sw2, 36);
      ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.strokeRect(bx + 27.5, heroTop + 245.5, sw2 - 3, 33);
      ctx.fillStyle = INK; ctx.textBaseline = 'middle'; ctx.fillText(save, bx + 38, heroTop + 263); ctx.textBaseline = 'alphabetic';

      // Challenge panel: black block with a yellow hard shadow.
      var panelY = heroTop + hbH + 48, panelH = 214;
      box(P, panelY, S - 2 * P - 10, panelH, INK, 10, YEL);
      var px = P + 34;
      ctx.font = '700 22px ' + FONT;
      var ptag = '100 pe 100% off', ptw = ctx.measureText(ptag).width + 28;
      ctx.fillStyle = YEL; ctx.fillRect(px, panelY + 26, ptw, 38);
      ctx.fillStyle = INK; ctx.textBaseline = 'middle'; ctx.fillText(ptag, px + 14, panelY + 45); ctx.textBaseline = 'alphabetic';
      ctx.font = '600 22px ' + FONT; ctx.fillStyle = 'rgba(255,244,214,0.85)';
      ctx.fillText('the GATE DA 2027 challenge', px + ptw + 16, panelY + 53);
      ctx.font = '700 40px ' + FONT; ctx.fillStyle = '#FFFFFF';
      ctx.fillText('AIR under 100 in GATE DA 2027', px, panelY + 110);
      ctx.fillStyle = YEL; ctx.fillText('= 100% of your fee back.', px, panelY + 156);
      ctx.font = '500 21px ' + FONT; ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText('You keep the course. Last year, 65 marks got AIR 90.', px, panelY + 193);

      // Two steps.
      var stY = panelY + panelH + 44, stH = 108, gap = 28, stW = (S - 2 * P - 10 - gap) / 2;
      [['1', 'Enrol in the course', 'at ' + opRupees(pr.price) + ' by ' + opDate(deadline)], ['2', 'Fill the challenge form', 'by ' + opDate(op.cutoff, true)]].forEach(function (st, i) {
        var sx = P + i * (stW + gap);
        box(sx, stY, stW, stH, i === 1 ? YEL : '#FFFFFF', 6);
        ctx.fillStyle = INK; ctx.fillRect(sx + 20, stY + 24, 56, 56);
        ctx.fillStyle = PAPER; ctx.font = '800 34px ' + FONT; ctx.textAlign = 'center'; ctx.fillText(st[0], sx + 48, stY + 64); ctx.textAlign = 'left';
        ctx.fillStyle = INK; ctx.font = '700 27px ' + FONT; ctx.fillText(st[1], sx + 96, stY + 50);
        ctx.font = '500 21px ' + FONT; ctx.fillStyle = '#3A3A3A'; ctx.fillText(st[2], sx + 96, stY + 82);
      });

      // Footer: the form link.
      var footY = S - P + 4;
      ctx.font = '600 28px ' + FONT; ctx.fillStyle = INK;
      ctx.fillText('Fill the form at', P, footY);
      ctx.font = '800 34px ' + FONT;
      var url = 'taai.live/challenge', uw = ctx.measureText(url).width;
      var ux = P + 236;
      ctx.fillStyle = YEL; ctx.fillRect(ux - 10, footY - 36, uw + 20, 48);
      ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.strokeRect(ux - 8.5, footY - 34.5, uw + 17, 45);
      ctx.fillStyle = INK; ctx.fillText(url, ux, footY);
    };
    if (document.fonts && document.fonts.load) {
      Promise.all(['800 190px Poppins', '700 40px Poppins', '600 28px Poppins', '500 21px Poppins', '500 22px "Geist Mono"'].map(function (f) { return document.fonts.load(f); })).then(go, go);
    } else go();
  }

  // A persistent, always-current reference for anyone creating a post —
  // lives here (not a one-off doc elsewhere) specifically so it can't
  // drift out of sync with the actual placeholder/mention logic below.
  function renderReference() {
    return (
      '<div class="card reference-card">' +
        '<h2 style="font-size:15px;margin-bottom:12px;">Syntax reference</h2>' +

        '<div class="ref-section"><div class="ref-heading">Sources</div>' +
          '<div class="ref-row"><strong>Custom message</strong>: whatever you type in Title/Body, posted as-is. No live data. Optionally add "Extra sections" below the Body: one per subject, each a Date/Topic/Duration table. All subjects\' rows merge into one date-ordered list in the final post (grouped by day, with the weekday shown), not shown subject-by-subject: everything still posts as a single card.</div>' +
          '<div class="ref-row"><strong>Daily: Top Focus Student</strong>: yesterday\'s single top student. Body fully replaces the default sentence if set.</div>' +
          '<div class="ref-row"><strong>Daily: Top 3</strong> / <strong>Weekly: Top 5 Leaderboard</strong>: a computed, freshly-ranked list every time it fires. Body (if set) is an intro line shown ABOVE the medal list: the list itself always shows regardless, you can\'t remove it.</div>' +
          '<div class="ref-row"><strong>Weekly: Batch Median Trend</strong>: a separate post from the Top 5 leaderboard (schedule it a few minutes after that one so it lands as a follow-up message). Reports whether the whole active cohort\'s median focus time rose or fell vs. the week before: one computed number, no ranked list.</div>' +
          '<div class="ref-row"><strong>Monthly: Most Consistent Student</strong>: reports on the month that just closed, ranked by median daily minutes (not average). Body fully replaces the default sentence if set.</div>' +
        '</div>' +

        '<div class="ref-section"><div class="ref-heading">Body placeholders</div>' +
          '<div class="ref-row">Single-student sources (Daily Top Focus Student, Monthly Consistency): <code>{{name}}</code> and <code>{{hours}}</code> only.</div>' +
          '<div class="ref-row">Ranked-list sources (Daily Top 3, Weekly Top 5): <code>{{name}}</code>/<code>{{hours}}</code> = 1st place, <code>{{name2}}</code>/<code>{{hours2}}</code> = 2nd, <code>{{name3}}</code>/<code>{{hours3}}</code> = 3rd, up through <code>{{name5}}</code>/<code>{{hours5}}</code> on the weekly one. An unused one (e.g. <code>{{name4}}</code> on a top-3 post) just renders blank.</div>' +
          '<div class="ref-row">Weekly: Batch Median Trend: no placeholders: Body, if set, is just a plain intro line shown above the number.</div>' +
          '<div class="ref-row">Custom messages: no placeholders: Body is posted exactly as typed.</div>' +
        '</div>' +

        '<div class="ref-section"><div class="ref-heading">Mentions</div>' +
          '<div class="ref-row"><strong>Tag @everyone</strong> checkbox: pings the whole server.</div>' +
          '<div class="ref-row"><strong>Additional mentions</strong> field: free text for anything else: <code>@here</code> for online members only, <code>&lt;@&amp;ROLE_ID&gt;</code> to ping a role, <code>&lt;@USER_ID&gt;</code> to ping one person. Both fields combine (e.g. @everyone + a role ping both fire together).</div>' +
          '<div class="ref-row">Getting an ID: in Discord, turn on Developer Mode (User Settings → Advanced), then right-click a role or person → Copy ID.</div>' +
        '</div>' +

        '<div class="ref-section"><div class="ref-heading">Other fields</div>' +
          '<div class="ref-row"><strong>Channel name</strong>: just a label for this list, purely for telling rows apart at a glance. Doesn\'t affect where the post actually goes: that\'s the Webhook URL.</div>' +
          '<div class="ref-row"><strong>Load a saved channel</strong>: picks from webhooks already used by an existing post and fills in the Channel name/Webhook URL fields for you. Still just a starting point: edit either field afterward if needed.</div>' +
          '<div class="ref-row"><strong>Preview</strong> button: shows exactly what would post right now, using real live data, before you save. Doesn\'t post anything or save your changes.</div>' +
          '<div class="ref-row"><strong>Send Test</strong> button: actually posts a real message right now, to whatever\'s in the "Test webhook URL" field above it (never the real Webhook URL, and never saves your changes). Point that at a private test channel so you can see the real rendered message in an actual Discord client before trusting it with the real one.</div>' +
          '<div class="ref-row"><strong>Once</strong> schedule: fires exactly one time at the date/time you set, then automatically pauses itself (doesn\'t delete, just switches to disabled).</div>' +
          '<div class="ref-row"><strong>▲/▼ buttons</strong> on each post: set which post fires first when two posts in the same channel are due at the same time (e.g. the weekly leaderboard before the weekly trend post). Only matters within one channel; has no effect on posts going to a different destination.</div>' +
          '<div class="ref-row"><strong>Posts are checked every 15 minutes</strong> (:00/:15/:30/:45), not continuously: a Time that doesn\'t land exactly on one of those fires at the next check after it, not the minute you typed.</div>' +
        '</div>' +
      '</div>'
    );
  }

  function formatHours(minutes) {
    return (minutes / 60).toFixed(1) + 'h';
  }

  var STUDENT_COLUMNS = [
    { key: 'display_name', label: 'Name' },
    { key: 'batch', label: 'Batch' },
    { key: 'score', label: 'Score' },
    { key: 'created_at', label: 'Joined' },
    { key: 'last_active', label: 'Last active' },
    { key: 'week_minutes', label: 'This week' },
    { key: 'last30_minutes', label: 'Last 30 days' },
    { key: 'total_minutes', label: 'All-time' },
    { key: 'consistency_minutes', label: 'Consistency' },
    { key: 'streak', label: 'Streak' },
    { key: 'progress_pct', label: 'Course progress' },
    { key: 'tasks_completed', label: 'Tasks done' },
  ];
  var STUDENT_BATCH_LABELS = { C: 'Batch C', D: '120 Days' };
  var STUDENTS_PAGE = 50; // rows rendered at once; "Show more" adds another page

  // Search matches name or email (case-insensitive substring). "Inactive"
  // is a days_inactive threshold computed server-side (team-students.js,
  // against the same IST "today" every other date calc here uses) rather
  // than redone client-side — 'never' is its own bucket (days_inactive
  // null, distinct from a real large number) for a student who
  // registered but never logged a session at all. Filters narrow the
  // table only. The summary cards follow the Batch filter alone (since
  // 2026-10-26, so the new 120 Days batch can be read on its own), and
  // ignore the other filters so they stay a big-picture read.
  function filteredStudents() {
    var f = state.studentFilters;
    var search = f.search.trim().toLowerCase();
    var minStreak = f.minStreak !== '' ? Number(f.minStreak) : null;
    return (state.students || []).filter(function (s) {
      if (search && s.display_name.toLowerCase().indexOf(search) === -1 && s.email.toLowerCase().indexOf(search) === -1) return false;
      if (minStreak != null && s.streak < minStreak) return false;
      if (f.flaggedOnly && !s.needs_rename) return false;
      if (f.minScore && (s.score || 0) < Number(f.minScore)) return false;
      // Joined date in IST, compared as YYYY-MM-DD with the date inputs.
      var joinedDay = s.created_at ? new Date(new Date(s.created_at).getTime() + 5.5 * 3600000).toISOString().slice(0, 10) : '';
      if (f.joinedFrom && joinedDay < f.joinedFrom) return false;
      if (f.joinedTo && joinedDay > f.joinedTo) return false;
      if (f.rankers === 'hide' && s.rankers_batch) return false;
      if (f.rankers === 'only' && !s.rankers_batch) return false;
      if (f.batch && (s.batch || 'C') !== f.batch) return false;
      // "Active in last N days": last session today or within the N-1 days before.
      if (f.active && !(s.days_inactive != null && s.days_inactive < Number(f.active))) return false;
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
  function joinedLabel(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    return isNaN(d) ? '-' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
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
  // Same numbers team-students.js puts in its summary, recomputed here over
  // the selected batch's students only (all students when no batch picked).
  function batchSummary() {
    var b = state.studentFilters.batch;
    if (!b) return state.studentSummary;
    var rows = (state.students || []).filter(function (r) { return (r.batch || 'C') === b; });
    var n = rows.length, avg = function (k) { return n ? Math.round(rows.reduce(function (a, r) { return a + (r[k] || 0); }, 0) / n) : 0; };
    return {
      total_students: n,
      active_this_week: rows.filter(function (r) { return r.week_minutes > 0; }).length,
      inactive_7d: rows.filter(function (r) { return r.days_inactive != null && r.days_inactive >= 7; }).length,
      never_active: rows.filter(function (r) { return r.days_inactive == null; }).length,
      avg_progress_pct: avg('progress_pct'),
      avg_consistency_minutes: avg('consistency_minutes'),
      needs_rename_flagged: rows.filter(function (r) { return r.needs_rename; }).length,
      gate_escalated_count: rows.filter(function (r) { return r.gate_escalated; }).length,
    };
  }

  function renderStudentSummary() {
    var sum = batchSummary();
    if (!sum) return '';
    var cards = [
      { label: state.studentFilters.batch ? (STUDENT_BATCH_LABELS[state.studentFilters.batch] || 'Batch') + ' students' : 'Students', value: sum.total_students },
      { label: 'Active this week', value: sum.active_this_week + ' / ' + sum.total_students },
      { label: 'Inactive 7+ days', value: sum.inactive_7d, warn: sum.inactive_7d > 0 },
      { label: 'Never logged in', value: sum.never_active, warn: sum.never_active > 0 },
      { label: 'Avg. course progress', value: sum.avg_progress_pct + '%' },
      { label: 'Avg. consistency', value: formatHours(sum.avg_consistency_minutes) + '/day' },
      { label: 'Flagged names', value: sum.needs_rename_flagged, warn: sum.needs_rename_flagged > 0 },
      { label: 'Blocked (needs clear)', value: sum.gate_escalated_count, warn: sum.gate_escalated_count > 0 },
    ];
    return '<div class="students-summary">' + cards.map(function (c) {
      return '<div class="students-summary-card' + (c.warn ? ' warn' : '') + '"><div class="students-summary-value">' + c.value + '</div><div class="students-summary-label">' + escapeHtml(c.label) + '</div></div>';
    }).join('') + '</div>';
  }

  // Ranker's batch tag (2026-10-26): students already picked into the
  // ranker's batch, so the team can hide them and not shortlist them again.
  function renderRankersCell(s) {
    var busy = state.rankersSaving && state.rankersSaving[s.email];
    return '<div class="rankers-cell">' + (s.rankers_batch ? '<span class="rankers-badge" title="' + escapeHtml(s.rankers_batch_at ? 'Added ' + joinedLabel(s.rankers_batch_at) : '') + '">🏅 Ranker\'s batch</span>' : '') +
      '<button type="button" class="linkish js-rankers" data-email="' + escapeHtml(s.email) + '" data-on="' + (s.rankers_batch ? '0' : '1') + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Saving…' : s.rankers_batch ? 'Remove from ranker\'s batch' : '+ Add to ranker\'s batch') + '</button></div>';
  }

  function renderStudentFilters() {
    var f = state.studentFilters;
    var inactiveOptions = [
      ['', 'Any'], ['3', '3+ days'], ['7', '7+ days'], ['14', '14+ days'], ['30', '30+ days'], ['never', 'Never active'],
    ].map(function (o) {
      return '<option value="' + o[0] + '"' + (f.inactive === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
    // One-click view for picking high performers (2026-10-26): Batch C,
    // students already in the ranker's batch hidden, best score first.
    var hpOn = f.batch === 'C' && f.rankers === 'hide' && state.studentSort.key === 'score' && state.studentSort.dir === 'desc';
    return (
      '<div class="hp-row"><button type="button" class="btn hp-btn' + (hpOn ? ' is-on' : '') + '" id="student-hp" aria-pressed="' + hpOn + '">⭐ High performers' + (hpOn ? ' ✓' : '') + '</button>' +
        '<span class="field-hint">' + (hpOn ? 'Showing Batch C, best first. Click again to go back to all students.' : 'Batch C students ranked best first, for picking the ranker\'s batch.') + '</span></div>' +
      (hpOn ? '<div class="hp-explain"><b>How the score (out of 100) is worked out</b>' +
        '<ul><li><b>Course progress, 40 points:</b> how many of the tasks due so far they have ticked.</li>' +
        '<li><b>Showing up regularly, 40 points:</b> half for how many of the batch\'s study days, from its first day, they ticked at least one task, half for their usual daily focus time on the timer over the last 45 days (a typical day of 2 hours or more gets full marks; days with no study count as zero). Days before someone joined count as missed, so a late joiner can\'t outscore students who have been steady for months.</li>' +
        '<li><b>Streak, 20 points:</b> their best run of days in a row (it doesn\'t need to be going now), plus a little for their current run.</li>' +
        '<li><b>Joined early but behind, up to −15 points:</b> if they have done less than half the tasks, they lose points depending on how long they have been in the batch and how far behind they are. Someone in from day one with almost nothing done loses close to 15; someone who joined recently loses little or nothing. Shown in red under the score.</li>' +
        '<li><b>Gone quiet, up to −10 points:</b> if they haven\'t ticked a task or used the focus timer for 7 days or more, they lose 3 points, rising to 10 points after a month away.</li></ul>' +
        '<p>The small line under each score shows these: progress · days ticked · usual focus time a day · best streak. Students already added to the ranker\'s batch are left out, so each person is only picked once.</p></div>' : '') +
      '<div class="students-filters">' +
        '<input type="text" id="student-search" placeholder="Search name or email…" value="' + escapeHtml(f.search) + '">' +
        '<label>Batch <select id="student-batch-filter">' +
          [['', 'All'], ['C', 'Batch C'], ['D', '120 Days']].map(function (o) {
            return '<option value="' + o[0] + '"' + (f.batch === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') + '</select></label>' +
        '<label>Active in last <select id="student-active-filter">' +
          [['', 'Any'], ['7', '7 days'], ['14', '14 days'], ['30', '30 days']].map(function (o) {
            return '<option value="' + o[0] + '"' + (f.active === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') + '</select></label>' +
        '<label>Inactive for <select id="student-inactive-filter">' + inactiveOptions + '</select></label>' +
        '<label>Joined from <input type="date" id="student-joined-from" value="' + escapeHtml(f.joinedFrom || '') + '"></label>' +
        '<label>to <input type="date" id="student-joined-to" value="' + escapeHtml(f.joinedTo || '') + '"></label>' +
        '<label>Min score <input type="number" min="0" max="100" id="student-min-score" placeholder="0" value="' + escapeHtml(f.minScore || '') + '" style="width:64px;"></label>' +
        '<label>Ranker\'s batch <select id="student-rankers-filter">' +
          [['', 'Any'], ['hide', 'Hide tagged'], ['only', 'Only tagged']].map(function (o) {
            return '<option value="' + o[0] + '"' + ((f.rankers || '') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') + '</select></label>' +
        '<label>Min streak <input type="number" min="0" id="student-min-streak" placeholder="0" value="' + escapeHtml(f.minStreak) + '" style="width:64px;"></label>' +
        '<label><input type="checkbox" id="student-flagged-only"' + (f.flaggedOnly ? ' checked' : '') + '> 🚩 Flagged names only</label>' +
        ((f.search || f.inactive || f.active || f.minScore || f.joinedFrom || f.joinedTo || f.rankers || f.minStreak !== '' || f.flaggedOnly || f.batch) ? '<button type="button" class="btn btn-small" id="student-filter-clear">Clear filters</button>' : '') +
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

  // The flag badge itself is read-only — no admin flag/unflag action
  // (see CLAUDE.md's "Name moderation" section: dropped at direct
  // request, "delegate everything to claude"). needs_rename is set/
  // cleared entirely by Claude (name-check-scan.js's nightly pass,
  // rename.js's own check when a gated student tries to resolve it)
  // with zero human step in that loop — this just shows what Claude has
  // already decided, for visibility, not for the team to act on.
  //
  // gate_escalated is different — added later, on direct request for a
  // real /team clear/rename action once a student has burned all 3
  // gated attempts this month and is genuinely stuck (see
  // team-clear-name-check.js). This IS a human step, deliberately: the
  // whole point of escalating is "self-service is over, a person needs
  // to look at this."
  function renderNameFlagCell(s) {
    var html = '';
    if (s.needs_rename) {
      html += '<div class="name-flag-badge" title="' + escapeHtml(s.name_check_reason || '') + '">🚩 Flagged by Claude</div>';
    }
    if (s.gate_escalated) {
      var status = state.clearBlockStatus[s.email];
      var working = status === 'saving';
      html += '<div class="name-flag-badge name-flag-badge--escalated">⛔ Blocked: needs manual clear</div>';
      html += '<div class="name-clear-actions">' +
        '<input type="text" class="js-clear-rename-input" data-email="' + escapeHtml(s.email) + '" placeholder="New name (optional)">' +
        '<button type="button" class="btn btn-small js-clear-rename" data-email="' + escapeHtml(s.email) + '"' + (working ? ' disabled' : '') + '>' + (working ? 'Working…' : 'Rename') + '</button>' +
        '<button type="button" class="btn btn-small js-clear-block" data-email="' + escapeHtml(s.email) + '"' + (working ? ' disabled' : '') + '>Clear block</button>' +
        '</div>';
      if (status === 'error') html += '<div class="field-hint" style="color:#f87171;">Action failed: try again.</div>';
    }
    // Advisory-only — see schema.sql's own comment on name_review_note.
    // Shown regardless of needs_rename/gate_escalated above, since the
    // whole point is surfacing a name Claude itself judged fine on its
    // own but that shares a word with another account's flagged history.
    // No action buttons here, deliberately — nothing to clear, just a
    // prompt to look and decide by hand.
    if (s.name_review_note) {
      html += '<div class="name-flag-badge name-flag-badge--review" title="' + escapeHtml(s.name_review_note) + '">👀 Worth a look</div>';
    }
    return html;
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
    var viewKey = JSON.stringify([state.studentFilters, state.studentSort]);
    if (viewKey !== state.studentsViewKey) { state.studentsViewKey = viewKey; state.studentsShown = STUDENTS_PAGE; }
    var shown = visible.slice(0, state.studentsShown);
    var rowsHtml = shown.map(function (s) {
      var saveState = state.noteSaving[s.email] || '';
      return (
        '<tr data-email="' + escapeHtml(s.email) + '">' +
          '<td class="students-name-cell"><div class="students-name">' + escapeHtml(s.display_name) + '</div><div class="field-hint"><a href="mailto:' + escapeHtml(s.email) + '">' + escapeHtml(s.email) + '</a></div>' + renderNameFlagCell(s) + renderRankersCell(s) + '</td>' +
          '<td><span class="batch-chip batch-chip-' + escapeHtml(s.batch || 'C') + '">' + escapeHtml(STUDENT_BATCH_LABELS[s.batch] || s.batch || 'Batch C') + '</span></td>' +
          '<td class="nowrap" title="' + escapeHtml('Progress ' + (s.due_progress_pct || 0) + '% · days ticked ' + (s.tick_day_pct || 0) + '% · usual focus time ' + formatHours(s.focus_median_45_minutes || 0) + '/day (last 45 days)' + (s.score_penalty ? ' · −' + s.score_penalty + ' joined early but behind' : '') + (s.inactive_penalty ? ' · −' + s.inactive_penalty + ' not active for ' + (s.days_inactive == null ? 'ever' : s.days_inactive + ' days') : '') + ' · longest streak ' + (s.longest_streak || 0) + ' · current ' + s.streak) + '"><b class="score-num">' + (s.score || 0) + '</b><div class="field-hint score-parts">' + (s.due_progress_pct || 0) + '% · ' + (s.tick_day_pct || 0) + '% · ' + formatHours(s.focus_median_45_minutes || 0) + '/day · ' + (s.longest_streak || 0) + 'd' + (s.score_penalty ? ' <span class="score-penalty">−' + s.score_penalty + ' joined early, behind</span>' : '') + (s.inactive_penalty ? ' <span class="score-penalty">−' + s.inactive_penalty + ' ' + (s.days_inactive == null ? 'never active' : 'quiet ' + s.days_inactive + 'd') + '</span>' : '') + '</div></td>' +
          '<td class="nowrap">' + joinedLabel(s.created_at) + '</td>' +
          '<td class="nowrap"><span class="inactivity-dot ' + inactivityClass(s.days_inactive) + '"></span>' + lastActiveLabel(s) + '</td>' +
          '<td>' + formatHours(s.week_minutes) + '</td>' +
          '<td>' + formatHours(s.last30_minutes || 0) + '</td>' +
          '<td>' + formatHours(s.total_minutes) + '</td>' +
          '<td class="nowrap">' + formatHours(s.consistency_minutes) + '/day</td>' +
          '<td>' + s.streak + '</td>' +
          '<td><div class="progress-cell"><span class="progress-bar"><span style="width:' + s.progress_pct + '%"></span></span>' + s.progress_pct + '%</div></td>' +
          '<td>' + s.tasks_completed + '</td>' +
          '<td class="students-notes-cell">' +
            '<input type="text" class="js-note-input note-input' + (saveState ? ' is-' + saveState : '') + '" data-email="' + escapeHtml(s.email) + '" value="' + escapeHtml(s.notes) + '" placeholder="Add a note" maxlength="500" title="Enter or click away to save">' +
          '</td>' +
        '</tr>'
      );
    }).join('');
    var moreLeft = visible.length - shown.length;
    var moreHtml = moreLeft > 0
      ? '<div class="students-more"><button type="button" class="btn" id="students-more">Show ' + Math.min(STUDENTS_PAGE, moreLeft) + ' more</button>' +
        '<button type="button" class="btn btn-ghost" id="students-all">Show all ' + visible.length + '</button>' +
        '<span class="field-hint">Showing ' + shown.length + ' of ' + visible.length + '</span></div>'
      : '';

    var countLabel = visible.length === state.students.length
      ? 'Students (' + state.students.length + ')'
      : 'Students (' + visible.length + ' of ' + state.students.length + ')';

    return (
      '<div class="card students-card">' +
        renderStudentSummary() +
        '<div class="students-head"><h2 style="font-size:16px;margin:0;">' + countLabel + '</h2>' +
          (visible.length ? '<button type="button" class="btn btn-small" id="students-csv">Download CSV (' + visible.length + ')</button>' : '') + '</div>' +
        renderStudentFilters() +
        renderInactivityLegend() +
        '<div class="field-hint" style="margin:10px 0;">Click a column to sort. Score (0-100) = 40% progress on tasks due so far + 40% consistency (batch study days ticked from the batch\'s first day, and usual daily focus time over the last 45 days, 2h+ = full; days before joining count as missed) + 20% streak (mostly the longest ever), compared within each batch, minus up to 15 for students in the batch a long time with under half the tasks done, and up to 10 for no tick or focus session in 7+ days; the small line under it shows progress · days ticked · usual focus a day · longest streak. Consistency = median daily focus time this month, counting quiet days as zero. Course progress = tasks done out of everything scheduled so far for that student\'s batch. Notes save when you press Enter or click away.</div>' +
        (visible.length ? '<div class="students-table-wrap"><table class="students-table"><thead><tr>' + headerHtml + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' + moreHtml
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

  function loadResourceStats() {
    var rs = state.resourceStats;
    rs.loading = true; rs.error = null;
    render();
    api('/team-resource-stats').then(function (data) {
      rs.data = data; rs.loading = false; render();
    }).catch(function (err) {
      rs.loading = false; rs.error = err.message; render();
    });
    api('/team-resource-leads').then(function (d) { rs.leads = d; render(); }).catch(function (e) { rs.leads = { ready: false, error: e.message }; render(); });
  }

  // One-time survey answers from the Resources page (2026-11-27). Labels
  // mirror the survey card in gate-da-free-notes.html.
  var RES_SURVEY = [
    ['sv_year', 'Year', [['y2', '2nd year or earlier'], ['y3', '3rd year'], ['final', 'Final year'], ['grad', 'Graduated, working'], ['full', 'Preparing full-time']]],
    ['sv_gate', 'Preparing for', [['da27', 'GATE DA 2027'], ['da28', 'GATE DA 2028'], ['cse', 'GATE CSE'], ['both', 'GATE CSE and DA'], ['jobs', 'Job interviews (DS/AI)'], ['undecided', 'Not decided']]],
    ['sv_src', 'Found us via', [['youtube', 'YouTube'], ['telegram', 'Telegram'], ['whatsapp', 'WhatsApp group'], ['friend', 'A friend'], ['google', 'Google'], ['discord', 'Discord'], ['other', 'Other']]]
  ];
  function resSurveyHtml(sv) {
    var done = sv.sv_done || {};
    var ans = (done.answered || {}).total || 0, skip = (done.skipped || {}).total || 0;
    var head = '<div class="res-survey-head"><b>Who uses the page</b><span class="field-hint"> · one-time survey before the first download or video: ' + ans + ' answered' + (skip ? ', ' + skip + ' skipped (an early version allowed skipping)' : '') + '</span></div>';
    if (!ans) return '<div class="res-survey">' + head + '<div class="field-hint" style="margin:0;">No answers yet. Each new visitor is asked once, right before their first PDF, video or slides.</div></div>';
    return '<div class="res-survey">' + head + '<div class="res-survey-grid">' + RES_SURVEY.map(function (q) {
      var data = Object.assign({}, sv[q[0]] || {}), typed = [];
      Object.keys(data).forEach(function (k) {
        if (k.indexOf('other:') !== 0) return;
        typed.push({ t: k.slice(6), n: data[k].total || 0 });
        data.other = { total: ((data.other || {}).total || 0) + (data[k].total || 0) };
        delete data[k];
      });
      typed.sort(function (a, b) { return b.n - a.n; });
      var tot = q[2].reduce(function (a, o) { return a + ((data[o[0]] || {}).total || 0); }, 0);
      var rows = q[2].map(function (o) { return { label: o[1], n: (data[o[0]] || {}).total || 0 }; }).sort(function (a, b) { return b.n - a.n; });
      return '<div class="res-sq"><div class="res-sq-title">' + escapeHtml(q[1]) + ' <span class="field-hint">(' + tot + ')</span></div>' + rows.map(function (r) {
        var pc = tot ? Math.round(r.n / tot * 100) : 0;
        return '<div class="res-sq-row"><span class="res-sq-label">' + escapeHtml(r.label) + '</span><span class="res-sq-bar"><i style="width:' + pc + '%"></i></span><span class="res-sq-n">' + r.n + (tot ? ' · ' + pc + '%' : '') + '</span></div>';
      }).join('') + (typed.length ? '<div class="res-sq-typed">"Other" answers: ' + typed.slice(0, 12).map(function (x) { return escapeHtml(x.t) + (x.n > 1 ? ' (' + x.n + ')' : ''); }).join(', ') + (typed.length > 12 ? ' and ' + (typed.length - 12) + ' more' : '') + '</div>' : '') + '</div>';
    }).join('') + '</div></div>';
  }
  // Emails left at the end of the survey (2026-11-27): "Want a discount code
  // sent to you?". Answers shown with each, a "code sent" tick, CSV download.
  function resLabel(kind, v) {
    if (!v) return '';
    if (v.indexOf('other:') === 0) return 'Other: ' + v.slice(6);
    var q = RES_SURVEY.filter(function (x) { return x[0] === kind; })[0];
    var o = q && q[2].filter(function (x) { return x[0] === v; })[0];
    return o ? o[1] : v;
  }
  function resLeadsHtml(L) {
    var head = '<div class="res-survey-head" style="margin-top:18px;"><b>Emails for a discount code</b>';
    if (!L) return '<div class="res-survey">' + head + '</div><div class="field-hint" style="margin:0;">Loading…</div></div>';
    if (L.ready === false) return '<div class="res-survey">' + head + '</div><div class="field-hint" style="margin:0;">Not set up yet: the resource_leads table is missing (run the SQL at the end of supabase/schema.sql). ' + escapeHtml(L.error || '') + '</div></div>';
    var rows = L.leads || [], sent = rows.filter(function (r) { return r.sent_at; }).length;
    head += '<span class="field-hint"> · ' + rows.length + ' left their email' + (rows.length ? ', ' + sent + ' sent a code' : '') + '</span>' +
      (rows.length ? ' <button type="button" class="btn btn-small" id="res-leads-csv">Download CSV</button>' : '') + '</div>';
    if (!rows.length) return '<div class="res-survey">' + head + '<div class="field-hint" style="margin:0;">None yet. People who answer the survey can leave their email to be sent a discount code; they show up here with their answers.</div></div>';
    return '<div class="res-survey">' + head + '<div class="students-table-wrap"><table class="students-table res-leads"><thead><tr><th>Email</th><th>Year</th><th>Preparing for</th><th>Found us via</th><th>Left on</th><th>Code sent</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td><a href="mailto:' + escapeHtml(r.email) + '">' + escapeHtml(r.email) + '</a></td><td>' + escapeHtml(resLabel('sv_year', r.year)) + '</td><td>' + escapeHtml(resLabel('sv_gate', r.prep)) + '</td><td>' + escapeHtml(resLabel('sv_src', r.source)) + '</td>' +
          '<td>' + escapeHtml(fmtPostedOn(new Date(Date.parse(r.created_at) + 5.5 * 3600000).toISOString().slice(0, 10))) + '</td>' +
          '<td><label class="res-sent"><input type="checkbox" class="js-lead-sent" data-email="' + escapeHtml(r.email) + '"' + (r.sent_at ? ' checked' : '') + '> ' + (r.sent_at ? 'Sent' : 'Not yet') + '</label></td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }
  function resLeadsCsv() {
    var rows = (state.resourceStats.leads || {}).leads || [];
    var q = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var csv = ['Email,Year,Preparing for,Found us via,Left on (IST),Code sent'].concat(rows.map(function (r) {
      return [r.email, resLabel('sv_year', r.year), resLabel('sv_gate', r.prep), resLabel('sv_src', r.source), new Date(Date.parse(r.created_at) + 5.5 * 3600000).toISOString().slice(0, 16).replace('T', ' '), r.sent_at ? 'yes' : 'no'].map(q).join(',');
    })).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'taai-free-notes-emails.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }
  // Visits summary shown above Notes and Lectures.
  function renderResourceStatsPanel() {
    var rs = state.resourceStats;
    var refresh = '<button type="button" class="btn btn-small" id="res-stats-refresh"' + (rs.loading ? ' disabled' : '') + '>' + (rs.loading ? 'Loading…' : 'Refresh') + '</button>';
    var body;
    if (rs.error) body = '<div class="msg msg-error">' + escapeHtml(rs.error) + '</div>';
    else if (!rs.data) body = '<div class="field-hint" style="margin:0;">Loading counts…</div>';
    else if (rs.data.ready === false) body = '<div class="field-hint" style="margin:0;">Counting isn\'t set up yet (the resource_stats table is missing). ' + escapeHtml(rs.data.error || '') + '</div>';
    else {
      var v = rs.data.visits;
      var nv = rs.data.newVisitors || { total: 0, d7: 0, d30: 0, today: 0 };
      var max = Math.max.apply(null, v.daily.map(function (d) { return d.count; }).concat([1]));
      var bars = v.daily.map(function (d) {
        var f = Math.min(d.fresh || 0, d.count);
        return '<span class="res-vbar" style="height:' + Math.max(2, Math.round(d.count / max * 100)) + '%" title="' + escapeHtml(fmtPostedOn(d.day) + ': ' + d.count + ' visit' + (d.count === 1 ? '' : 's') + ', ' + f + ' new') + '">' +
          (f ? '<span class="res-vbar-new" style="height:' + Math.round(f / Math.max(d.count, 1) * 100) + '%"></span>' : '') + '</span>';
      }).join('');
      var stat = function (n, f, label) { return '<div class="res-vstat"><b>' + n.toLocaleString('en-IN') + '</b><span>' + label + '</span><em>' + f.toLocaleString('en-IN') + ' new</em></div>'; };
      body = '<div class="res-vstats">' + stat(v.today, nv.today, 'visits today') + stat(v.d7, nv.d7, 'last 7 days') + stat(v.d30, nv.d30, 'last 30 days') + stat(v.total, nv.total, 'all time') + '</div>' +
        '<div class="res-vbars" aria-label="Visits per day, last 30 days">' + bars + '</div>' +
        '<div class="field-hint" style="margin:6px 0 0;">Visits per day, last 30 days; the brighter part of each bar is new visitors. A visit counts once per browser tab; a new visitor is a browser opening the page for the first time (a new phone, another browser or cleared site data counts again). Downloads and plays count once per item per 10 minutes. Counting started 8 Nov 2026.</div>';
    }
    if (rs.data && rs.data.ready !== false) body += resSurveyHtml(rs.data.survey || {}) + resLeadsHtml(rs.leads);
    return '<section class="pricing-group res-stats-panel"><div class="res-section-head"><div class="pricing-group-heading">Resources page visits</div>' + refresh + '</div>' + body + '</section>';
  }

  // "12 downloads · 3 this week" line on a note/lecture card.
  function resourceCountsHtml(type, id) {
    var d = state.resourceStats.data;
    if (!d || d.ready === false) return '';
    var it = (d.items || {})[String(id || '').toLowerCase()] || {};
    var part = function (k, noun) {
      var c = it[k] || { total: 0, d7: 0 };
      return '<span><b>' + c.total + '</b> ' + noun + (c.total === 1 ? '' : 's') + (c.d7 ? ' · ' + c.d7 + ' this week' : '') + '</span>';
    };
    var parts = type === 'notes' ? [part('note', 'download')] : [part('play', 'play'), part('slides', 'slides download')];
    return '<div class="res-counts">' + parts.join('') + '</div>';
  }

  function loadLmsSync(runNow) {
    var ls = state.lmsSync;
    if (runNow) ls.checking = true; else ls.loading = true;
    ls.error = null;
    render();
    api('/lms-price-check', runNow ? { method: 'POST' } : {}).then(function (data) {
      ls.data = data;
      ls.loading = false;
      ls.checking = false;
      // A check can change prices; reload the cards so they show it.
      if (runNow && data.sync && data.sync.summary && data.sync.summary.applied) loadSiteData('pricing');
      else render();
    }).catch(function (err) {
      ls.loading = false;
      ls.checking = false;
      ls.error = err.message;
      render();
    });
  }

  function fmtRupee(n) { return n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN'); }
  function fmtAgo(iso) {
    if (!iso) return 'never';
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var h = Math.round(mins / 60);
    if (h < 48) return h + ' h ago';
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  function renderLmsSyncPanel() {
    var ls = state.lmsSync;
    var d = ls.data;
    var btn = '<button class="btn btn-secondary btn-sm" id="lms-check-now"' + (ls.checking ? ' disabled' : '') + '>' + (ls.checking ? 'Checking…' : 'Check LMS now') + '</button>';
    var head = '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">' +
      '<div style="font-weight:600;">LMS price sync</div>' + btn + '</div>' +
      '<div class="field-hint" style="margin:6px 0 10px;">Every 15 minutes the site checks each course\'s price on learn.taai.live. When the LMS price changes, the site\'s price follows. A price you set here stays until the LMS price changes again. Once a course\'s discount deadline has passed, the price you set here is final: LMS changes are shown but not applied (clear the deadline, or set a new one, to follow the LMS again).</div>';
    var body;
    if (ls.error) body = '<div class="msg msg-error">' + escapeHtml(ls.error) + '</div>';
    else if (!d) body = '<div class="field-hint">Loading…</div>';
    else if (!d.available) body = '<div class="msg msg-error">Not set up yet: the lms_price_sync tables need to be created in Supabase (see the end of supabase/schema.sql).</div>';
    else {
      var pricing = state.siteData.rows.pricing || [];
      var nameOf = {}, siteOf = {};
      pricing.forEach(function (r) { nameOf[r.id] = r.name; siteOf[r.id] = r.price; });
      var lines = ['<div class="field-hint">Last checked: ' + escapeHtml(fmtAgo(d.lastRun && d.lastRun.checked_at)) + (d.lastRun && d.lastRun.note ? ' (' + escapeHtml(d.lastRun.note) + ')' : '') + '</div>'];
      var deadlineOf = {};
      pricing.forEach(function (r) { deadlineOf[r.id] = r.discount_deadline; });
      var todayStr = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10); // IST
      var postDiscount = function (id) { return !!deadlineOf[id] && todayStr > String(deadlineOf[id]).slice(0, 10); };
      var allDiffs = (d.courses || []).filter(function (c) { return c.lms_price != null && siteOf[c.id] != null && c.lms_price !== siteOf[c.id]; });
      var kept = allDiffs.filter(function (c) { return postDiscount(c.id); });
      var diffs = allDiffs.filter(function (c) { return !postDiscount(c.id); });
      if (kept.length) {
        lines.push('<div style="margin-top:8px;font-size:13px;">Discount period over, site price kept (the LMS hasn\'t been updated to match yet):</div><ul style="margin:4px 0 0 18px;font-size:13px;">' +
          kept.map(function (c) { return '<li>' + escapeHtml(nameOf[c.id] || c.id) + ': site ' + fmtRupee(siteOf[c.id]) + ', LMS ' + fmtRupee(c.lms_price) + '</li>'; }).join('') + '</ul>');
      }
      if (diffs.length) {
        lines.push('<div style="margin-top:8px;font-size:13px;">Different from the LMS right now (left as is; they\'ll follow the next LMS change, or edit them below):</div><ul style="margin:4px 0 0 18px;font-size:13px;">' +
          diffs.map(function (c) { return '<li>' + escapeHtml(nameOf[c.id] || c.id) + ': site ' + fmtRupee(siteOf[c.id]) + ', LMS ' + fmtRupee(c.lms_price) + '</li>'; }).join('') + '</ul>');
      }
      var held = (d.courses || []).filter(function (c) { return c.status === 'held'; });
      if (held.length) {
        lines.push('<div class="msg msg-error" style="margin-top:8px;">' + held.map(function (c) { return escapeHtml((nameOf[c.id] || c.id) + ': ' + (c.note || 'held')); }).join('<br>') + '</div>');
      }
      var unavailable = (d.courses || []).filter(function (c) { return c.status === 'unavailable'; });
      if (unavailable.length) {
        lines.push('<div class="field-hint" style="margin-top:8px;">Not readable on the LMS (private or not found): ' + unavailable.map(function (c) { return escapeHtml(nameOf[c.id] || c.id); }).join(', ') + '</div>');
      }
      if (d.log && d.log.length) {
        lines.push('<div style="margin-top:10px;font-size:13px;font-weight:600;">Recent LMS price changes</div><ul style="margin:4px 0 0 18px;font-size:13px;">' +
          d.log.slice(0, 8).map(function (e) {
            var what = e.status === 'applied' ? 'site updated ' + fmtRupee(e.site_old) + ' → ' + fmtRupee(e.site_new)
              : e.status === 'matched' ? 'site already matched'
              : e.status === 'held' ? 'not applied (check it)'
              : e.status === 'kept' ? 'site price kept (discount period over)'
              : 'not applied';
            return '<li>' + escapeHtml((e.course_name || e.course_id) + ': LMS ' + fmtRupee(e.lms_old) + ' → ' + fmtRupee(e.lms_new) + ', ' + what + ' · ' + fmtAgo(e.created_at)) + '</li>';
          }).join('') + '</ul>');
      }
      body = lines.join('');
    }
    return '<div class="pricing-group" style="border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:18px;">' + head + body + '</div>';
  }

  // ── Site settings (a 5th, non-list sub-tab — see the state comment
  // above) ────────────────────────────────────────────────────────────
  // Currently just one toggle (hide the homepage's financial-assistance
  // CTA card), but built as {row-fetch, single PUT} rather than a
  // one-off special case, so a second toggle later is just another
  // field on the same row + another switch in renderSiteSettingsPanel().

  function loadSiteSettings() {
    var ss = state.siteSettings;
    ss.loading = true;
    ss.error = null;
    render();
    api('/site-settings').then(function (data) {
      ss.hideFinancialAssistance = !!(data.row && data.row.hide_financial_assistance);
      ss.scheduleRunout = data.scheduleRunout || [];
      ss.miniFlt = (data.row && data.row.mini_flt) || MINI_FLT_DEFAULT;
      ss.topStrip = (data.row && data.row.top_strip) || TOP_STRIP_DEFAULT;
      ss.loaded = true;
      ss.loading = false;
      render();
    }).catch(function (err) {
      ss.loading = false;
      ss.error = err.message;
      render();
    });
  }

  // Optimistic: flips the switch immediately, reverts it if the save
  // actually fails — the same instant-feeling toggle UX as a native
  // settings page, rather than making the admin wait on a round-trip to
  // see the switch move.
  function saveSiteSettingsToggle(field, value) {
    var ss = state.siteSettings;
    var prev = ss[field];
    ss[field] = value;
    ss.saving = true;
    ss.error = null;
    render();
    var payload = {};
    payload[field === 'hideFinancialAssistance' ? 'hide_financial_assistance' : field] = value;
    api('/site-settings', { method: 'PUT', body: JSON.stringify(payload) }).then(function (data) {
      ss.hideFinancialAssistance = !!(data.row && data.row.hide_financial_assistance);
      ss.saving = false;
      render();
    }).catch(function (err) {
      ss[field] = prev;
      ss.saving = false;
      ss.error = err.message;
      render();
    });
  }

  // "No more schedule coming" for one batch: stores that batch's current last
  // schedule date (or clears it), then re-reads the panel so the status updates.
  function saveScheduleRunoutOff(batch, lastDate, on) {
    var ss = state.siteSettings;
    var payload = { schedule_reminder_off: {} };
    payload.schedule_reminder_off[batch] = on ? lastDate : null;
    ss.runoutSaving = batch; ss.error = null;
    render();
    api('/site-settings', { method: 'PUT', body: JSON.stringify(payload) }).then(function () {
      return api('/site-settings');
    }).then(function (data) {
      ss.scheduleRunout = data.scheduleRunout || [];
      ss.runoutSaving = null;
      render();
    }).catch(function (err) {
      ss.runoutSaving = null; ss.error = err.message;
      render();
    });
  }

  function scheduleRunoutHtml() {
    var ss = state.siteSettings;
    var list = ss.scheduleRunout || [];
    if (!list.length) return '';
    var fmt = function (d) { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); };
    var addDays = function (d, n) { var t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
    var rows = list.map(function (b) {
      if (!b.lastDate) return '';
      var left = b.daysLeft;
      var leftText = left > 1 ? left + ' days left' : left === 1 ? 'ends tomorrow' : left === 0 ? 'ends today' : 'ran out ' + (-left) + ' day' + (left === -1 ? '' : 's') + ' ago';
      var status = b.off ? 'Reminders off: marked "no more schedule coming".'
        : left <= 5 ? 'Reminding @team and @owner every day until the next schedule is loaded.'
        : 'Reminders start on ' + fmt(addDays(b.lastDate, -5)) + ' (5 days before it runs out).';
      var id = 'runout-off-' + b.batch;
      return '<div class="site-setting-row">' +
        '<div class="site-setting-info">' +
          '<div class="site-setting-title">' + escapeHtml(b.label) + ': no more schedule coming</div>' +
          '<div class="field-hint">Last scheduled day: ' + escapeHtml(fmt(b.lastDate)) + ' (' + escapeHtml(leftText) + '). ' + escapeHtml(status) + '</div>' +
        '</div>' +
        '<label class="site-setting-switch' + (ss.runoutSaving === b.batch ? ' is-saving' : '') + '" for="' + id + '">' +
          '<input type="checkbox" id="' + id + '" data-runout-batch="' + escapeHtml(b.batch) + '" data-runout-last="' + escapeHtml(b.lastDate) + '"' + (b.off ? ' checked' : '') + (ss.runoutSaving ? ' disabled' : '') + '>' +
          '<span class="site-setting-switch-track"></span>' +
        '</label>' +
      '</div>';
    }).join('');
    return '<h3 style="margin:28px 0 6px;font-size:16px;">Schedule run-out reminders</h3>' +
      '<div class="field-hint" style="margin-bottom:10px;">From 5 days before a batch\'s loaded schedule ends, a daily Discord post tags @team and @owner. Switch a batch on below if no more schedule will be uploaded for it. Loading a newer schedule turns its reminders back on by itself.</div>' +
      rows;
  }

  // Shared by both places a Site data sub-tab can become the active one
  // (the top-level "site-data" tab click, and clicking a sub-tab button
  // itself) — dispatches to whichever loader this type actually needs,
  // and reports back whether a load was kicked off (so the caller knows
  // whether to skip its own render(), since the loader already renders).
  function ensureSiteDataLoaded(type) {
    if (type === 'settings') {
      if (state.siteSettings.loaded || state.siteSettings.loading) return false;
      loadSiteSettings();
      return true;
    }
    if (type === 'pricing' && !state.lmsSync.data && !state.lmsSync.loading) loadLmsSync(false);
    if ((type === 'notes' || type === 'lectures') && !state.resourceStats.data && !state.resourceStats.loading) loadResourceStats();
    if (state.siteData.rows[type] !== null) return false;
    loadSiteData(type);
    return true;
  }

  // "+ New note" / "+ New lecture" in the section bar (none for Pricing,
  // Settings, or while a form is open).
  function siteDataNewButtonHtml() {
    var sd = state.siteData, type = sd.subTab;
    var editingThis = sd.editing && sd.editing.type === type ? sd.editing.row : null;
    if (editingThis || type === 'pricing' || type === 'settings') return '';
    return '<button class="btn btn-primary" id="sitedata-new">' + SITE_DATA_NEW_LABEL[type] + '</button>';
  }
  function renderSiteDataTabs() {
    var html = Object.keys(SITE_DATA_RESOURCES).map(function (type) {
      var cfg = SITE_DATA_RESOURCES[type];
      var active = state.siteData.subTab === type;
      var rows = state.siteData.rows[type];
      var countLabel = rows ? ' <span class="tab-count">' + rows.length + '</span>' : '';
      return '<button class="tab-btn' + (active ? ' active' : '') + '" data-sitetab="' + type + '">' + cfg.label + countLabel + '</button>';
    }).join('');
    var settingsActive = state.siteData.subTab === 'settings';
    html += '<button class="tab-btn' + (settingsActive ? ' active' : '') + '" data-sitetab="settings">Settings</button>';
    return html;
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
        ? '<div class="empty">No pricing rows yet: these are added directly (with their matching course card), not through this page.</div>'
        : '<div class="empty">No rows yet. Click "+ New' + (type === 'notes' ? ' note' : ' lecture') + '" above to add one.</div>';
    }
    return type === 'pricing' ? renderLmsSyncPanel() + renderPricingGroups(rows) : renderResourceStatsPanel() + renderResourceSections(type, rows);
  }

  // Notes and Lectures as cards, one section per subject in the same order as the
  // Resources page's tabs (2026-10-22, was a flat table). Each section has its own
  // "+ Add" that opens the form with that subject already picked. Subjects with
  // nothing yet are listed at the end as quick-add chips instead of empty boxes.
  function ytId(url) {
    var m = String(url || '').match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
    return m ? m[1] : null;
  }
  function fmtPostedOn(d) {
    if (!d) return '';
    var dt = new Date(String(d).slice(0, 10) + 'T00:00:00');
    return isNaN(dt) ? String(d) : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function resourceCardHtml(type, r) {
    var actions = '<div class="pricing-card-actions">' + siteDataRowActionsHtml(type, r.id) + '</div>';
    var date = r.posted_on ? '<div class="res-card-date">' + escapeHtml(fmtPostedOn(r.posted_on)) + '</div>' : '';
    if (type === 'lectures') {
      var vid = ytId(r.youtube_url);
      var thumb = vid
        ? '<a class="res-thumb" href="' + escapeHtml(r.youtube_url) + '" target="_blank" rel="noopener" title="Open on YouTube"><img src="https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg" alt="" loading="lazy"><span class="res-play">▶</span></a>'
        : '<div class="res-thumb res-thumb-missing">' + (r.youtube_url ? 'Not a YouTube link' : 'No video link') + '</div>';
      var links = [];
      if (r.youtube_url) links.push('<a href="' + escapeHtml(r.youtube_url) + '" target="_blank" rel="noopener">Video ↗</a>');
      if (r.slides_url) links.push('<a href="' + escapeHtml(r.slides_url) + '" target="_blank" rel="noopener">Slides ↗</a>');
      else links.push('<span class="res-missing">No slides</span>');
      return '<div class="pricing-card res-card">' + thumb +
        '<div class="res-card-body">' +
          (r.lecture_number != null && r.lecture_number !== '' ? '<div class="res-kicker">Lecture ' + escapeHtml(r.lecture_number) + '</div>' : '') +
          '<div class="pricing-card-name">' + escapeHtml(r.title || '(untitled)') + '</div>' + date +
          '<div class="res-links">' + links.join('') + '</div>' + resourceCountsHtml(type, r.id) +
        '</div>' + actions + '</div>';
    }
    return '<div class="pricing-card res-card">' +
      '<div class="res-card-body">' +
        '<div class="res-kicker">PDF note</div>' +
        '<div class="pricing-card-name">' + escapeHtml(r.title || '(untitled)') + '</div>' +
        (r.description ? '<div class="res-desc">' + escapeHtml(r.description) + '</div>' : '') + date +
        '<div class="res-links">' + (r.file_url ? '<a href="' + escapeHtml(r.file_url) + '" target="_blank" rel="noopener">Open PDF ↗</a>' : '<span class="res-missing">No file link</span>') + '</div>' + resourceCountsHtml(type, r.id) +
      '</div>' + actions + '</div>';
  }
  function renderResourceSections(type, rows) {
    var bySubject = {};
    rows.forEach(function (r) { (bySubject[r.subject] = bySubject[r.subject] || []).push(r); });
    var order = SITE_SUBJECT_OPTIONS.map(function (o) { return o.id; });
    Object.keys(bySubject).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    var noun = type === 'notes' ? 'note' : 'lecture';
    var sortRows = function (list) {
      return list.slice().sort(function (a, b) {
        if (type === 'lectures') {
          var an = Number(a.lecture_number), bn = Number(b.lecture_number);
          if (!isNaN(an) && !isNaN(bn) && an !== bn) return an - bn;
        }
        return String(b.posted_on || '').localeCompare(String(a.posted_on || ''));
      });
    };
    var sections = order.filter(function (id) { return bySubject[id]; }).map(function (id) {
      var list = sortRows(bySubject[id]);
      return '<section class="pricing-group res-section">' +
        '<div class="res-section-head"><div class="pricing-group-heading">' + escapeHtml(subjectLabel(id)) +
          ' <span class="field-hint" style="margin:0;font-weight:500;">' + list.length + ' ' + noun + (list.length === 1 ? '' : 's') + '</span></div>' +
          '<button type="button" class="btn btn-small js-res-add" data-subject="' + escapeHtml(id) + '">+ Add ' + noun + '</button></div>' +
        '<div class="pricing-cards res-cards">' + list.map(function (r) { return resourceCardHtml(type, r); }).join('') + '</div>' +
      '</section>';
    }).join('');
    var empty = SITE_SUBJECT_OPTIONS.filter(function (o) { return !bySubject[o.id]; });
    var emptyHtml = empty.length
      ? '<div class="res-empty"><span class="field-hint" style="margin:0;">No ' + noun + 's yet:</span>' +
        empty.map(function (o) { return '<button type="button" class="res-empty-chip js-res-add" data-subject="' + escapeHtml(o.id) + '">+ ' + escapeHtml(o.label) + '</button>'; }).join('') + '</div>'
      : '';
    return sections + emptyHtml;
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
    // Deliberately "link set" / "no link set", not "Live"/"Coming Soon"
    // — corrected 2026-09-23 alongside the live cutover, since /team has
    // no way to know from this field alone whether a course is actually
    // purchasable. enroll_url only OVERRIDES the live page's Enrol Now
    // button destination; leaving it blank falls back to that course's
    // own built-in link in code, which may well already be live — it
    // does NOT mean "Coming Soon" the way the old label implied. The
    // 2028 preview card reads "No enrol link set" here too, correctly,
    // but is only actually gated to Coming Soon by its own comingSoon
    // flag in code, not by this field.
    var statusHtml = row.enroll_url
      ? '<span class="pricing-status pricing-status-live">● Enrol link set</span>'
      : '<span class="pricing-status pricing-status-soon">No enrol link set</span>';
    var soldOutHtml = row.sold_out_date
      ? '<div class="pricing-soldout-note">🔒 Sold-out cutover: ' + escapeHtml(row.sold_out_date) + ' <span class="field-hint" style="margin:0;">(live on taai.live)</span></div>'
      : '';
    var priceHtml = row.price != null
      ? '<span class="pricing-card-price-main">₹' + escapeHtml(row.price) + '</span>' + (row.price_old != null ? '<span class="pricing-card-price-old">₹' + escapeHtml(row.price_old) + '</span>' : '')
      : '<span class="pricing-card-price-none">No price set</span>';
    var discountHtml = row.discount ? '<span class="pricing-card-discount">' + escapeHtml(/^\d+(\.\d+)?$/.test(String(row.discount).trim()) ? row.discount + '% off' : row.discount) + (row.discount_reason ? ' · ' + escapeHtml(row.discount_reason) : '') + '</span>' : '';
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
        (comboRows.length > 1 ? ' Drag a card by its ⠿ handle to reorder: this order is live on taai.live.' : '') +
        '</div>';
    }
    var individualHintHtml = individualRows.length > 1
      ? '<div class="pricing-group-hint">Drag a card by its ⠿ handle to reorder: this order is live on taai.live.</div>'
      : '';
    var testSeriesHintHtml = testSeriesRows.length > 1
      ? '<div class="pricing-group-hint">Drag a card by its ⠿ handle to reorder: admin-only preview for now, the test series page doesn\'t read this order yet.</div>'
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
  // list is and whether it's actually live yet.
  var SITE_DATA_INTRO = {
    pricing: 'Every course, bundle, and test series shown on the site: its price, discount, validity, sold-out date, enrolment link, and order. Grouped below into Bundled courses, Individual courses, and Test series.',
    notes: 'Downloadable PDF notes, organized by subject.',
    lectures: 'Video lectures and their slides, organized by subject.',
    settings: 'Site-wide switches for what shows on taai.live.',
  };
  // Pricing went live 2026-09-23 and Notes/Lectures on 2026-10-15 (the
  // Resources page reads them via /api/site-resources-public; the Google
  // Sheet is no longer used). Kept as a
  // per-type sentence rather than one blanket line so this stays
  // accurate if/when Notes/Lectures ever get their own cutover later.
  var SITE_DATA_LIVE_NOTE = {
    pricing: 'Changes here go live on taai.live immediately: no deploy needed.',
    notes: 'Changes here show on the taai.live Resources page within about a minute. No deploy needed.',
    lectures: 'Changes here show on the taai.live Resources page within about a minute. No deploy needed.',
    settings: 'Changes here go live on taai.live immediately: no deploy needed.',
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
    // "+ New" button. Settings has no rows to create at all.
    var showNewButton = type !== 'pricing' && type !== 'settings';

    return (
      '<div class="card">' +
        '<div class="field-hint" style="margin-bottom:16px;">' + SITE_DATA_INTRO[type] + ' ' + SITE_DATA_LIVE_NOTE[type] + '</div>' +
        (type === 'settings' ? renderSiteSettingsPanel() : (editingThis ? renderSiteDataForm(type, editingThis) : renderSiteDataList(type))) +
      '</div>'
    );
  }


  // Free All India Mini FLT promo (2026-11-23). Copy of
  // netlify/functions/lib/mini-flt.js's MINI_FLT_DEFAULT, shown until a value
  // has been saved.
  var MINI_FLT_DEFAULT = {
    enabled: true,
    topics: ['Linear Algebra', 'Python', 'Machine Learning'],
    url: 'https://learn.taai.live/learn/home/Mixed-Subject-Wise-Test/section/766425/lesson/4936517?embedPlayer=1&disableLessonChange=true&visitorFlow=true',
    minutes: 90,
  };

  function miniFltPanelHtml() {
    var ss = state.siteSettings;
    var m = ss.miniFlt || MINI_FLT_DEFAULT;
    var dis = ss.mfltSaving ? ' disabled' : '';
    return '<h3 style="margin:28px 0 6px;font-size:16px;">Free Mini FLT promo</h3>' +
      '<div class="field-hint" style="margin-bottom:10px;">The free test popup (once per browser on the home page, and once on the progress tracker after the 2 AM Club winners), the card on the test series page, and the top strip when it\'s set to show the Mini FLT. Change the topics, link and length when a new Mini FLT goes live: a new link shows the popup once more to everyone. Changes show on the site within about a minute.</div>' +
      (ss.mfltError ? '<div class="msg msg-error">' + escapeHtml(ss.mfltError) + '</div>' : '') +
      (ss.mfltMsg ? '<div class="msg msg-ok">' + escapeHtml(ss.mfltMsg) + '</div>' : '') +
      '<div class="site-setting-row">' +
        '<div class="site-setting-info"><div class="site-setting-title">Show the Mini FLT promo</div>' +
        '<div class="field-hint">Switch off to hide it everywhere, for example between tests.</div></div>' +
        '<label class="site-setting-switch" for="mflt-enabled"><input type="checkbox" id="mflt-enabled"' + (m.enabled ? ' checked' : '') + dis + '><span class="site-setting-switch-track"></span></label>' +
      '</div>' +
      '<div class="field" style="margin-top:12px;"><label for="mflt-topics">Topics in the live test</label>' +
        '<input type="text" id="mflt-topics" value="' + escapeHtml((m.topics || []).join(', ')) + '"' + dis + '>' +
        '<div class="field-hint">Separate with commas, up to 6. Example: Linear Algebra, Python, Machine Learning</div></div>' +
      '<div class="field" style="margin-top:12px;"><label for="mflt-url">Test link</label>' +
        '<input type="url" id="mflt-url" value="' + escapeHtml(m.url || '') + '"' + dis + '>' +
        '<div class="field-hint">Must start with https://learn.taai.live/</div></div>' +
      '<div class="field" style="margin-top:12px;"><label for="mflt-minutes">Test length (minutes)</label>' +
        '<input type="number" id="mflt-minutes" min="10" max="300" step="1" value="' + escapeHtml(String(m.minutes || 90)) + '" style="max-width:140px"' + dis + '>' +
        '<div class="field-hint">Shown as "a 90-minute paper" and "90 min".</div></div>' +
      '<div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;">' +
        '<button type="button" class="btn btn-primary" id="mflt-save"' + dis + '>' + (ss.mfltSaving ? 'Saving…' : 'Save Mini FLT promo') + '</button>' +
        '<a class="btn" id="mflt-open" href="' + escapeHtml(m.url || '#') + '" target="_blank" rel="noopener">Open test link</a>' +
      '</div>';
  }

  function saveMiniFlt() {
    var ss = state.siteSettings;
    var val = {
      enabled: document.getElementById('mflt-enabled').checked,
      topics: document.getElementById('mflt-topics').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
      url: document.getElementById('mflt-url').value.trim(),
      minutes: Number(document.getElementById('mflt-minutes').value) || 90,
    };
    ss.miniFlt = val; ss.mfltSaving = true; ss.mfltError = null; ss.mfltMsg = null;
    render();
    api('/site-settings', { method: 'PUT', body: JSON.stringify({ mini_flt: val }) }).then(function (data) {
      ss.miniFlt = (data.row && data.row.mini_flt) || val;
      ss.mfltSaving = false; ss.mfltMsg = 'Saved. The site shows it within about a minute.';
      render();
    }).catch(function (err) {
      ss.mfltSaving = false;
      ss.mfltError = /mini_flt/.test(err.message) ? 'The database column for this isn\'t set up yet (run the SQL at the end of supabase/schema.sql). Until then the site shows the built-in default.' : err.message;
      render();
    });
  }

  // The rolling strip at the top of the pages (2026-11-23). Copy of
  // netlify/functions/lib/mini-flt.js's TOP_STRIP_DEFAULT.
  var TOP_STRIP_DEFAULT = { enabled: true, mode: 'mini_flt', message: '', button: '', url: '', style: 'light' };
  function topStripPanelHtml() {
    var ss = state.siteSettings;
    var t = ss.topStrip || TOP_STRIP_DEFAULT;
    var dis = ss.stripSaving ? ' disabled' : '';
    var custom = t.mode === 'custom';
    return '<h3 style="margin:28px 0 6px;font-size:16px;">Top strip</h3>' +
      '<div class="field-hint" style="margin-bottom:10px;">The rolling strip at the very top of every main page and the progress tracker (dark there). Show the Mini FLT, or your own announcement. Changes show on the site within about a minute.</div>' +
      (ss.stripError ? '<div class="msg msg-error">' + escapeHtml(ss.stripError) + '</div>' : '') +
      (ss.stripMsg ? '<div class="msg msg-ok">' + escapeHtml(ss.stripMsg) + '</div>' : '') +
      '<div class="site-setting-row">' +
        '<div class="site-setting-info"><div class="site-setting-title">Show the top strip</div>' +
        '<div class="field-hint">Off: no strip, the thin scroll bar is back.</div></div>' +
        '<label class="site-setting-switch" for="strip-enabled"><input type="checkbox" id="strip-enabled"' + (t.enabled ? ' checked' : '') + dis + '><span class="site-setting-switch-track"></span></label>' +
      '</div>' +
      '<div class="field" style="margin-top:12px;"><label for="strip-mode">What it shows</label>' +
        '<select id="strip-mode"' + dis + '>' +
          '<option value="mini_flt"' + (custom ? '' : ' selected') + '>The Mini FLT (from the setting above; a tap opens the Mini FLT card)</option>' +
          '<option value="custom"' + (custom ? ' selected' : '') + '>My own announcement (a tap goes to the link)</option>' +
        '</select></div>' +
      '<div id="strip-custom-fields"' + (custom ? '' : ' hidden') + '>' +
        '<div class="field" style="margin-top:12px;"><label for="strip-message">Message</label>' +
          '<input type="text" id="strip-message" maxlength="200" value="' + escapeHtml(t.message || '') + '"' + dis + '>' +
          '<div class="field-hint">The line that scrolls, up to 200 characters. Example: GATE 2028 Full Course early bird price ends Sunday</div></div>' +
        '<div class="field" style="margin-top:12px;"><label for="strip-button">Button text (optional)</label>' +
          '<input type="text" id="strip-button" maxlength="30" value="' + escapeHtml(t.button || '') + '" style="max-width:260px"' + dis + '>' +
          '<div class="field-hint">Up to 30 characters, e.g. See the offer</div></div>' +
        '<div class="field" style="margin-top:12px;"><label for="strip-url">Link</label>' +
          '<input type="text" id="strip-url" value="' + escapeHtml(t.url || '') + '"' + dis + '>' +
          '<div class="field-hint">A full link (https://…) or a page on this site like /gate-da-courses. Other websites open in a new tab.</div></div>' +
      '</div>' +
      '<div class="field" style="margin-top:12px;"><label for="strip-style">Style on the main pages</label>' +
        '<select id="strip-style" style="max-width:260px"' + dis + '>' +
          '<option value="light"' + (t.style === 'dark' ? '' : ' selected') + '>Yellow</option>' +
          '<option value="dark"' + (t.style === 'dark' ? ' selected' : '') + '>Dark</option>' +
        '</select><div class="field-hint">The progress tracker always uses the dark one.</div></div>' +
      '<div style="margin-top:12px;"><button type="button" class="btn btn-primary" id="strip-save"' + dis + '>' + (ss.stripSaving ? 'Saving…' : 'Save top strip') + '</button></div>';
  }

  function saveTopStrip() {
    var ss = state.siteSettings;
    var val = {
      enabled: document.getElementById('strip-enabled').checked,
      mode: document.getElementById('strip-mode').value,
      message: document.getElementById('strip-message').value.trim(),
      button: document.getElementById('strip-button').value.trim(),
      url: document.getElementById('strip-url').value.trim(),
      style: document.getElementById('strip-style').value,
    };
    ss.topStrip = val; ss.stripSaving = true; ss.stripError = null; ss.stripMsg = null;
    render();
    api('/site-settings', { method: 'PUT', body: JSON.stringify({ top_strip: val }) }).then(function (data) {
      ss.topStrip = (data.row && data.row.top_strip) || val;
      ss.stripSaving = false; ss.stripMsg = 'Saved. The site shows it within about a minute.';
      render();
    }).catch(function (err) {
      ss.stripSaving = false;
      ss.stripError = /top_strip/.test(err.message) ? 'The database column for this isn\'t set up yet (run the SQL at the end of supabase/schema.sql). Until then the strip shows the Mini FLT.' : err.message;
      render();
    });
  }

  function renderSiteSettingsPanel() {
    var ss = state.siteSettings;
    if (ss.loading && !ss.loaded) return '<div class="field-hint">Loading…</div>';
    var errorHtml = ss.error ? '<div class="msg msg-error">' + escapeHtml(ss.error) + '</div>' : '';
    var checked = ss.hideFinancialAssistance;
    return (
      errorHtml +
      '<div class="site-setting-row">' +
        '<div class="site-setting-info">' +
          '<div class="site-setting-title">Hide the "Can\'t afford it right now?" card</div>' +
          '<div class="field-hint">Hides the financial-assistance section near the bottom of the homepage. Nothing else on the page changes: the mobile "Take a Trial" bar stays as-is.</div>' +
        '</div>' +
        '<label class="site-setting-switch' + (ss.saving ? ' is-saving' : '') + '" for="setting-hide-financial-assistance">' +
          '<input type="checkbox" id="setting-hide-financial-assistance" data-setting-field="hideFinancialAssistance"' + (checked ? ' checked' : '') + (ss.saving ? ' disabled' : '') + '>' +
          '<span class="site-setting-switch-track"></span>' +
        '</label>' +
      '</div>' +
      miniFltPanelHtml() +
      topStripPanelHtml() +
      scheduleRunoutHtml()
    );
  }

  // ── Site data > Challenge ────────────────────────────────────────────
  function loadChallenge() {
    var ch = state.challenge;
    ch.loading = true; ch.error = null;
    render();
    api('/team-challenge').then(function (data) {
      ch.rows = data.rows || [];
      ch.cutoff = data.cutoff;
      ch.open = !!data.open;
      ch.error = data.error || null;
      ch.loaded = true; ch.loading = false;
      render();
    }).catch(function (err) { ch.loading = false; ch.error = err.message; render(); });
  }

  function saveChallengeCutoff(value) {
    var ch = state.challenge;
    ch.saving = true; ch.error = null; ch.msg = null;
    render();
    api('/site-settings', { method: 'PUT', body: JSON.stringify({ challenge_cutoff: value }) }).then(function () {
      ch.saving = false; ch.msg = 'Cutoff saved.';
      ch.loaded = false;
      loadChallenge();
    }).catch(function (err) { ch.saving = false; ch.error = err.message; render(); });
  }

  function deleteChallengeRow(id, name) {
    if (!window.confirm('Delete the challenge registration for ' + name + '? They will be able to submit the form again.')) return;
    var ch = state.challenge;
    api('/team-challenge?id=' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
      ch.rows = ch.rows.filter(function (r) { return r.id !== id; });
      ch.msg = 'Deleted.';
      render();
    }).catch(function (err) { ch.error = err.message; render(); });
  }

  function fmtIstDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' IST';
  }

  function chalRowText(r) {
    return [r.full_name, r.email, r.phone, r.gate_enrollment_id, r.upi_id].join(' ').toLowerCase();
  }
  function renderChallengePanel() {
    var ch = state.challenge;
    if (ch.loading && !ch.loaded) return '<div class="card"><div class="field-hint">Loading…</div></div>';
    var rowsHtml = ch.rows.length ? (
      '<div class="chal-toolbar">' +
        '<input type="search" id="chal-search" placeholder="Search name, email, phone, GATE ID or UPI" value="' + escapeHtml(ch.q || '') + '">' +
        '<button type="button" class="btn" id="chal-csv">Download CSV</button>' +
      '</div>' +
      '<div class="students-table-wrap"><table class="students-table sitedata-table chal-table"><thead><tr>' +
        '<th>Name</th><th>Email</th><th>Mobile</th><th>GATE enrollment ID</th><th>Date of birth</th><th>GATE application</th><th>UPI ID</th><th>Submitted</th><th></th>' +
      '</tr></thead><tbody>' +
      ch.rows.map(function (r) {
        var hide = ch.q && chalRowText(r).indexOf(ch.q.toLowerCase()) === -1;
        return '<tr data-chal-text="' + escapeHtml(chalRowText(r)) + '"' + (hide ? ' hidden' : '') + '>' +
          '<td>' + escapeHtml(r.full_name) + '</td>' +
          '<td><a href="mailto:' + escapeHtml(r.email) + '">' + escapeHtml(r.email) + '</a></td>' +
          '<td>' + escapeHtml(r.phone) + '</td>' +
          '<td><code>' + escapeHtml(r.gate_enrollment_id) + '</code></td>' +
          '<td>' + escapeHtml(String(r.dob || '')) + '</td>' +
          '<td>' + (r.registration_pdf_url ? '<a href="' + escapeHtml(r.registration_pdf_url) + '" target="_blank" rel="noopener noreferrer">Open PDF ↗</a>' : '<span class="field-hint">None</span>') + '</td>' +
          '<td><code>' + escapeHtml(r.upi_id || '') + '</code></td>' +
          '<td>' + escapeHtml(fmtIstDateTime(r.submitted_at)) + '</td>' +
          '<td><button class="btn btn-small btn-danger js-chal-delete" data-id="' + escapeHtml(r.id) + '" data-name="' + escapeHtml(r.full_name) + '">Delete</button></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>'
    ) : '<div class="field-hint">No registrations yet.</div>';
    return (
      '<div class="card">' +
      '<div class="field-hint" style="margin-bottom:12px;">Students who filled the "100 pe 100% off" challenge form. Their details are locked; deleting a row lets them submit again (only do that when they emailed about a genuine mistake). Check each PDF opens, and check their course purchase date on learn.taai.live.</div>' +
      (ch.error ? '<div class="msg msg-error">' + escapeHtml(ch.error) + '</div>' : '') +
      (ch.msg ? '<div class="msg msg-ok">' + escapeHtml(ch.msg) + '</div>' : '') +
      '<div class="chal-stats">' +
        '<div class="chal-stat"><b>' + ch.rows.length + '</b><span>registered</span></div>' +
        '<div class="chal-stat"><b>' + (ch.open ? 'Open' : 'Closed') + '</b><span>form status</span></div>' +
        '<div class="chal-stat"><b>' + escapeHtml(ch.cutoff || '') + '</b><span>cutoff (11:59 PM IST)</span></div>' +
      '</div>' +
      '<h3 style="margin:18px 0 10px;font-size:15px;">Registrations</h3>' +
      rowsHtml +
      '<h3 style="margin:26px 0 4px;font-size:15px;">Settings</h3>' +
      '<div class="site-setting-row chal-cutoff-row">' +
        '<div class="site-setting-info">' +
          '<div class="site-setting-title">Registration cutoff</div>' +
          '<div class="field-hint">The form closes at 11:59 PM IST on this date. It should be the GATE DA 2027 admit card day (4 Jan 2027 on gate2027.iitm.ac.in as of 18 Oct 2026). Change it if IIT Madras moves that date. Clear it to go back to 4 Jan 2027.</div>' +
        '</div>' +
        '<form id="chal-cutoff-form" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
          '<input type="date" name="cutoff" value="' + escapeHtml(ch.cutoff || '') + '"' + (ch.saving ? ' disabled' : '') + '>' +
          '<button type="submit" class="btn btn-primary"' + (ch.saving ? ' disabled' : '') + '>' + (ch.saving ? 'Saving…' : 'Save') + '</button>' +
        '</form>' +
      '</div>' +
      '<div class="site-setting-row chal-cutoff-row">' +
        '<div class="site-setting-info">' +
          '<div class="site-setting-title">Form link</div>' +
          '<div class="field-hint">Opens the courses page with the registration form already open. Share it anywhere.</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
          '<code>https://taai.live/challenge</code>' +
          '<button type="button" class="btn" id="chal-copy-link">Copy link</button>' +
        '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function downloadChallengeCsv() {
    var cols = ['full_name', 'email', 'phone', 'gate_enrollment_id', 'dob', 'registration_pdf_url', 'upi_id', 'submitted_at'];
    var esc = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [cols.join(',')].concat(state.challenge.rows.map(function (r) { return cols.map(function (k) { return esc(r[k]); }).join(','); }));
    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'challenge-registrations-' + dcTodayIST() + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
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

  // Price/old price/discount are three independent fields with nothing
  // relating them — direct report: "does the discount percentage auto
  // calculate the price?" (no), followed by "yes" to adding a real
  // auto-calculated/auto-checked field, then a direct follow-up asking
  // for the reverse too ("if we give the discounted price, can you
  // auto calculate the discount percentage?" — already true; "if
  // discount is given, [can] price [be] auto calculated" — wasn't yet).
  // Rather than force `discount` into a pure computed number (it's also
  // used as free custom text, e.g. "SAVE BIG", not just a %), this adds
  // a live BIDIRECTIONAL hint under the field instead, computed from
  // whichever two of {price, price_old, discount} are already filled:
  // price+old price known, discount empty → offers to fill discount;
  // discount+old price known, price empty → offers to fill price; all
  // three present → match/mismatch check. Purely a client-side
  // authoring aid — doesn't change what's stored or validated
  // server-side, `discount` stays free text there.
  function bindPricingDiscountCheck() {
    if (state.siteData.subTab !== 'pricing') return;
    var form = document.getElementById('sitedata-form');
    if (!form) return;
    var priceEl = form.querySelector('input[name="price"]');
    var priceOldEl = form.querySelector('input[name="price_old"]');
    var discountEl = form.querySelector('input[name="discount"]');
    if (!priceEl || !priceOldEl || !discountEl) return;

    var hintEl = document.createElement('div');
    hintEl.id = 'discount-calc-hint';
    hintEl.className = 'field-hint';
    discountEl.insertAdjacentElement('afterend', hintEl);

    function update() {
      var price = parseInt(priceEl.value, 10);
      var priceOld = parseInt(priceOldEl.value, 10);
      var discountRaw = discountEl.value.trim();
      var priceValid = Number.isFinite(price);
      var priceOldValid = Number.isFinite(priceOld) && priceOld > 0;
      var enteredPct = discountRaw === '' ? null : parseFloat(discountRaw);
      // Same isNaN() rule gate-da-courses.html's own ComboCard already
      // uses to decide whether `discount` is a plain number (append "%
      // off") or custom text (show as-is) — matching it here so this
      // check agrees with what actually renders live.
      var enteredIsNumeric = discountRaw !== '' && !isNaN(discountRaw);

      hintEl.className = 'field-hint';
      hintEl.innerHTML = '';
      if (!priceOldValid) return;

      if (priceValid && priceOld > price) {
        // Forward: price + old price known → check/offer discount.
        var computedPct = Math.round((priceOld - price) / priceOld * 100);
        if (discountRaw === '') {
          hintEl.innerHTML = 'Price implies <strong>' + computedPct + '% off</strong>: <button type="button" class="chip" id="discount-fill-btn">Use ' + computedPct + '%</button>';
          document.getElementById('discount-fill-btn').addEventListener('click', function () {
            discountEl.value = String(computedPct);
            update();
          });
        } else if (enteredIsNumeric && Math.round(enteredPct) === computedPct) {
          hintEl.classList.add('field-hint--ok');
          hintEl.textContent = '✓ Matches the price math (' + computedPct + '% off).';
        } else if (enteredIsNumeric) {
          hintEl.classList.add('field-hint--warn');
          hintEl.textContent = '⚠ Doesn\'t match the price math: price implies ' + computedPct + '% off, this field says ' + enteredPct + '%.';
        } else {
          hintEl.innerHTML = 'Price implies <strong>' + computedPct + '% off</strong> (this field has custom text, not a plain %: nothing to check it against).';
        }
      } else if (!priceValid && enteredIsNumeric && enteredPct > 0 && enteredPct < 100) {
        // Reverse: discount % + old price known, price still blank →
        // offer to fill price. Only kicks in while price is genuinely
        // empty — once a real price is typed, the forward branch above
        // takes over and treats that price as the thing to check the
        // discount against, not the other way around.
        var computedPrice = Math.round(priceOld * (1 - enteredPct / 100));
        hintEl.innerHTML = enteredPct + '% off ₹' + priceOld.toLocaleString('en-IN') + ' is <strong>₹' + computedPrice.toLocaleString('en-IN') + '</strong>: <button type="button" class="chip" id="price-fill-btn">Use ₹' + computedPrice + '</button>';
        document.getElementById('price-fill-btn').addEventListener('click', function () {
          priceEl.value = String(computedPrice);
          update();
        });
      }
    }

    priceEl.addEventListener('input', update);
    priceOldEl.addEventListener('input', update);
    discountEl.addEventListener('input', update);
    update();
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

  // ── Piracy (2026-11-12) ───────────────────────────────────────────────
  // Log of every Telegram link reported in a takedown notice, its live
  // status (piracy-check.js looks at Telegram's public pages daily), and a
  // notice generator that fills the team's agreed notice format. Notices are
  // copied and sent by a person; nothing is emailed from here.
  var PIR_COURSES = [
    ['https://learn.taai.live/learn/Maths--ML---AI-Bundle---GATE-2026', 'Maths + ML Bundle'],
    ['https://learn.taai.live/learn/batch/GATE-2028', 'GATE 2028 Full Course'],
    ['https://learn.taai.live/learn/batch/GATE-2027/content', 'GATE 2027 Full Course'],
    ['https://learn.taai.live/learn/Mathematics-Course-by-manoj-sir-gate-2026-gateda', 'Mathematics Bundle'],
    ['https://learn.taai.live/learn/Probability', 'Probability'],
    ['https://learn.taai.live/learn/Linear-Algebra--Mathematics-', 'Linear Algebra'],
    ['https://learn.taai.live/learn/Statistics', 'Statistics'],
    ['https://learn.taai.live/learn/Calculus-and-Optimization', 'Calculus and Optimization'],
    ['https://learn.taai.live/learn/Python-Programming', 'Python Programming'],
    ['https://learn.taai.live/learn/Test-Series', 'Test Series'],
    ['', 'No specific course (all courses)'],
  ];
  var PIR_DEFAULT_SIGNATURE = "Best regards,\nManoj Kumar\nProprietor\nTAAI (Tomorrow's Architect of AI)\nEmail: support@taai.live";
  var PIR_STATUS = {
    reported: ['Not checked yet', 'pir-st-wait'],
    up: ['Still up', 'pir-st-up'],
    removed: ['Removed', 'pir-st-removed'],
    moved: ['Username reused', 'pir-st-moved'],
    unchecked: ["Private, can't check", 'pir-st-private'],
  };
  var PIR_DRAFT_KEY = 'taai_piracy_draft_v1';

  function pirToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  }
  function pirFmtDate(d) {
    if (!d) return '';
    return new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function pirNewSection() {
    return { name: '', link: '', subs: '', scope: 'whole', messages: '', nature: '', accounts: '', actAccounts: true };
  }
  function pirNewDraft() {
    return { label: pirFmtDate(pirToday()) + ' notice', kind: 'Distribution', description: '', course: PIR_COURSES[0][0], sections: [pirNewSection()] };
  }
  function pirLoadDraft() {
    try { var d = JSON.parse(localStorage.getItem(PIR_DRAFT_KEY) || 'null'); if (d && d.sections && d.sections.length) return d; } catch (e) {}
    return pirNewDraft();
  }
  function pirSaveDraft() {
    try { localStorage.setItem(PIR_DRAFT_KEY, JSON.stringify(state.piracy.draft)); } catch (e) {}
  }

  // Same rules as lib/piracy.js normalizeTgLink / tgKey (kept in sync by hand).
  function pirNorm(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    var bot = s.match(/^-100(\d{6,})$/);
    if (bot) return 'https://t.me/c/' + bot[1];
    if (/^\d{8,}$/.test(s)) return 'https://t.me/c/' + s;
    if (s.charAt(0) === '@') s = 'https://t.me/' + s.slice(1);
    s = s.replace(/^(https?:\/\/)?(www\.)?(t\.me|telegram\.me|telegram\.dog)\//i, 'https://t.me/');
    if (!/^https:\/\/t\.me\//.test(s)) { if (/^[A-Za-z0-9_+]/.test(s)) s = 'https://t.me/' + s; else return ''; }
    s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
    s = s.replace(/^https:\/\/t\.me\/s\//, 'https://t.me/').replace(/^https:\/\/t\.me\/joinchat\//, 'https://t.me/+');
    return s;
  }
  function pirKey(link) {
    var s = pirNorm(link);
    var m = s.match(/^https:\/\/t\.me\/([A-Za-z0-9_]{4,})(\/\d+)?$/);
    if (m && m[1] !== 'c') return 'https://t.me/' + m[1].toLowerCase() + (m[2] || '');
    return s;
  }
  function pirType(link) {
    if (/^https:\/\/t\.me\/c\//.test(link)) return 'private';
    if (/^https:\/\/t\.me\/\+/.test(link)) return 'invite';
    if (/^https:\/\/t\.me\/[A-Za-z0-9_]+\/\d+$/.test(link)) return 'message';
    return 'channel';
  }
  function pirLines(text) {
    return String(text || '').split(/[\n,]+/).map(function (l) { return l.trim(); }).filter(Boolean);
  }
  // "https://t.me/x – uploader", "@x - seller", "@x: admin", "@x uploader"
  function pirAccounts(text) {
    return String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
      var m = l.match(/^(\S+)\s*(?:[–—:-]\s*|\s+)(.*)$/);
      var link = pirNorm((m ? m[1] : l).replace(/[:–—,;-]+$/, ''));
      return link ? { link: link, role: (m ? m[2] : '').trim() } : null;
    }).filter(Boolean);
  }
  function pirPrivateId(link) { var m = link.match(/^https:\/\/t\.me\/c\/(\d+)/); return m ? m[1] : null; }

  function pirChannelRef(sec) {
    var link = pirNorm(sec.link);
    var subs = parseInt(String(sec.subs || '').replace(/[^\d]/g, ''), 10);
    var subsTxt = subs > 0 ? subs.toLocaleString('en-IN') + ' subscribers' : '';
    var id = link ? pirPrivateId(link) : null;
    if (id) return (sec.name || 'Private channel') + ' (private channel, ID: ' + id + (subsTxt ? ', ' + subsTxt : '') + ')';
    if (!link) return sec.name || '[channel]';
    return (sec.name ? sec.name + ' – ' : '') + link + (subsTxt ? ' (' + subsTxt + ')' : '');
  }

  // Builds the notice in the team's agreed format (see the "TAAI Telegram
  // Takedown Notices – Context & Log" doc) and lists warnings.
  function pirBuildNotice(draft, rows) {
    var secs = draft.sections.filter(function (s) { return s.link || s.messages || s.name; });
    var multi = secs.length > 1;
    var where = function (i) { return multi ? 'under section ' + (i + 1) : 'below'; };
    var requests = [];
    var blocks = [];
    var anyWhole = false, anyMsgs = false;
    secs.forEach(function (sec, i) {
      var ref = pirChannelRef(sec);
      var msgs = pirLines(sec.messages).map(pirNorm).filter(Boolean);
      var accts = pirAccounts(sec.accounts);
      var b = [];
      if (multi) b.push((i + 1) + '. ' + (sec.name || pirNorm(sec.link) || 'Channel ' + (i + 1)).toUpperCase());
      if (sec.scope === 'whole') {
        anyWhole = true;
        requests.push('Remove the channel ' + ref + ' in its entirety, as it consists of TAAI\'s paid course content.');
        b.push('INFRINGING CHANNEL\n' + (pirNorm(sec.link) || ref));
        if (msgs.length) b.push('SAMPLE INFRINGING MESSAGES\nThe entire channel consists of TAAI\'s paid course content. The following messages are provided as representative samples only and are not an exhaustive list:\n' + msgs.map(function (m) { return '- ' + m; }).join('\n'));
      } else if (sec.scope === 'suspected') {
        requests.push('Review the suspected channel ' + ref + ' and remove it if it distributes TAAI\'s paid course content.');
        b.push('SUSPECTED CHANNEL\n' + (pirNorm(sec.link) || ref) + (msgs.length ? '\n' + msgs.map(function (m) { return '- ' + m; }).join('\n') : ''));
      } else {
        anyMsgs = true;
        requests.push('Remove the infringing message' + (msgs.length === 1 ? '' : 's') + ' listed ' + where(i) + '.');
        b.push('INFRINGING MESSAGE' + (msgs.length === 1 ? '' : 'S') + '\n' + (msgs.length ? msgs.map(function (m) { return '- ' + m; }).join('\n') : '[message links]'));
      }
      b.push('CHANNEL\n' + ref);
      if (sec.nature) b.push('NATURE OF INFRINGEMENT\n' + sec.nature.trim());
      if (accts.length) {
        b.push('ASSOCIATED ACCOUNT' + (accts.length === 1 ? '' : 'S') + '\n' + accts.map(function (a) { return '- ' + a.link + (a.role ? ' – ' + a.role : ''); }).join('\n'));
        if (sec.actAccounts && sec.scope === 'whole') requests.push('Take appropriate action against the account' + (accts.length === 1 ? '' : 's') + ' listed ' + where(i) + ', which run, upload to or sell through this channel.');
      }
      blocks.push(b.join('\n\n'));
    });
    var removeWhat = anyWhole && anyMsgs ? 'channels and messages' : anyWhole ? (secs.filter(function (s) { return s.scope === 'whole'; }).length > 1 ? 'channels' : 'channel') : anyMsgs ? 'messages' : 'content';
    var desc = String(draft.description || '').trim().replace(/[.\s]+$/, '');
    var subject = 'Copyright and Trademark Infringement Notice – Unauthorized ' + draft.kind + ' of TAAI Paid Course Content on Telegram';
    var body = [
      'Dear Grievance Officer,',
      'I am Manoj Kumar, Proprietor of TAAI (Tomorrow\'s Architect of AI), and I own the rights to the educational content and trademark associated with TAAI.',
      'It has come to our attention that ' + (desc || '[describe what the channel(s) are doing]') + ' without our authorization.',
      'We are therefore submitting this as a formal notice of copyright and trademark infringement and request that Telegram:\n' + requests.map(function (r, i) { return (i + 1) + '. ' + r; }).join('\n'),
    ].concat(blocks).concat([
      'ORIGINAL TAAI CONTENT\nOur legitimate educational content is available through our official learning platform: https://learn.taai.live/learn' + (draft.course ? '\nSpecific course: ' + draft.course : ''),
      'SUPPORTING DOCUMENTATION\nWe have attached relevant documentation establishing our rights and authority, including:\n- Trademark documentation.\n- Copyright and ownership documentation.\n- Proof of ownership of the original educational content.\n- Screenshots of the reported messages.',
      'We request that you treat this communication as a formal infringement notice and remove the identified ' + removeWhat + ' promptly.',
      'We would also appreciate written confirmation once the content has been removed.',
      'Should you require any additional information or verification of our ownership, I am available to provide it. Our educational content is hosted and delivered through Learnyst, our Learning Management System (LMS) provider, and their legal team can assist with coordination and verification where necessary.',
      'Thank you for your prompt attention to this matter.',
      state.piracy.signature || PIR_DEFAULT_SIGNATURE,
    ]).join('\n\n');

    // Warnings: already reported, look-alike characters in invite codes,
    // messages from a different channel than the section's.
    var warnings = [];
    var byKey = {};
    (rows || []).forEach(function (r) { byKey[pirKey(r.link)] = r; });
    var seen = {};
    secs.forEach(function (sec, i) {
      var chan = pirNorm(sec.link);
      var all = [chan].concat(pirLines(sec.messages).map(pirNorm)).concat(pirAccounts(sec.accounts).map(function (a) { return a.link; })).filter(Boolean);
      all.forEach(function (l) {
        var k = pirKey(l);
        if (seen[k]) return; seen[k] = true;
        var r = byKey[k];
        if (r) warnings.push({ type: 'dup', text: l + ' was already reported on ' + pirFmtDate(r.last_reported_on) + (r.notice_label ? ' (' + r.notice_label + ')' : '') + (r.times_reported > 1 ? ', ' + r.times_reported + ' times' : '') + '. Status: ' + (PIR_STATUS[r.status] || [r.status])[0] + '.' });
        if (pirType(l) === 'invite' && /[lI]/.test(l.slice(15))) warnings.push({ type: 'invite', text: l + ' contains l or I. They look identical in screenshots and invite links are case-sensitive, so copy the link rather than retyping it.' });
      });
      var chanUser = (chan.match(/^https:\/\/t\.me\/(c\/\d+|[A-Za-z0-9_]+)$/) || [])[1];
      if (chanUser) pirLines(sec.messages).map(pirNorm).forEach(function (m) {
        var mu = (m.match(/^https:\/\/t\.me\/(c\/\d+|[A-Za-z0-9_]+)\/\d+$/) || [])[1];
        if (mu && mu.toLowerCase() !== chanUser.toLowerCase()) warnings.push({ type: 'mismatch', text: (multi ? 'Section ' + (i + 1) + ': ' : '') + m + ' is from a different channel than ' + chan + '.' });
      });
      if (sec.scope === 'whole' && !pirLines(sec.messages).length) warnings.push({ type: 'hint', text: (multi ? 'Section ' + (i + 1) + ': ' : '') + 'add 3 to 5 sample message links so Telegram can see the content quickly.' });
    });
    if (!desc) warnings.push({ type: 'hint', text: 'Fill in the "It has come to our attention that…" sentence.' });
    return { subject: subject, body: body, warnings: warnings, sections: secs };
  }

  function pirLogItems(draft) {
    var items = [];
    draft.sections.forEach(function (sec) {
      var chan = pirNorm(sec.link);
      var subs = parseInt(String(sec.subs || '').replace(/[^\d]/g, ''), 10) || null;
      if (chan) items.push({ link: chan, kind: pirType(chan) === 'message' ? 'message' : pirType(chan), scope: sec.scope, channel_name: sec.name, subscribers: subs });
      pirLines(sec.messages).map(pirNorm).filter(Boolean).forEach(function (m) {
        items.push({ link: m, kind: pirType(m) === 'private' ? 'private' : 'message', scope: sec.scope, channel_name: sec.name });
      });
      pirAccounts(sec.accounts).forEach(function (a) { items.push({ link: a.link, kind: 'account', scope: 'account', role: a.role, channel_name: sec.name }); });
    });
    return items;
  }

  function loadPiracy() {
    var p = state.piracy;
    p.loading = true; p.error = null;
    render();
    api('/team-piracy').then(function (data) {
      p.rows = data.rows || [];
      p.signature = data.signature || null;
      p.terms = data.terms || null;
      p.candidates = data.candidates || [];
      p.candidatesReady = !!data.candidatesReady;
      p.runs = data.runs || [];
      p.ingest = data.ingest || null;
      p.error = data.error || null;
      p.loaded = true; p.loading = false;
      render();
    }).catch(function (err) { p.loading = false; p.error = err.message; render(); });
  }

  function pirLastChecked(rows) {
    var t = null;
    rows.forEach(function (r) { if (r.checked_at && (!t || r.checked_at > t)) t = r.checked_at; });
    return t;
  }

  // Gmail auto-log (2026-11-13): an Apps Script in the support@taai.live
  // mailbox sends every notice emailed out to piracy-ingest.js, which logs
  // its links. This panel shows the script (with the key filled in) and the
  // last emails it logged.
  function pirAppsScript(key) {
    return [
      '// TAAI takedown auto-log. Runs inside the separate Gmail you BCC on notices.',
      '// Sends every notice BCC\'d from support@taai.live to taai.live/team > Piracy.',
      "var ENDPOINT = 'https://taai.live/api/piracy-ingest';",
      "var KEY = '" + key + "';",
      "var SEARCH = 'from:support@taai.live (subject:infringement OR subject:takedown) newer_than:14d';",
      '',
      'function logTakedownNotices() {',
      '  var props = PropertiesService.getScriptProperties();',
      '  GmailApp.search(SEARCH, 0, 50).forEach(function (thread) {',
      '    thread.getMessages().forEach(function (m) {',
      "      if (m.getFrom().toLowerCase().indexOf('telegram') !== -1) return; // Telegram's replies",
      '      var id = m.getId();',
      '      if (props.getProperty(id)) return;',
      '      var res = UrlFetchApp.fetch(ENDPOINT, {',
      "        method: 'post', contentType: 'application/json', muteHttpExceptions: true,",
      '        payload: JSON.stringify({ key: KEY, messageId: id, subject: m.getSubject(),',
      '          sentAt: m.getDate().toISOString(), body: m.getPlainBody() })',
      '      });',
      "      if (res.getResponseCode() === 200) props.setProperty(id, '1');",
      '    });',
      '  });',
      '}',
      '',
      '// Run this once: logs recent notices now, then checks every 15 minutes.',
      'function setup() {',
      '  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });',
      "  ScriptApp.newTrigger('logTakedownNotices').timeBased().everyMinutes(15).create();",
      '  logTakedownNotices();',
      '}',
    ].join('\n');
  }

  function renderPiracyIngest() {
    var g = state.piracy.ingest;
    if (!g) return '';
    var recent = (g.recent || []);
    var status = !g.ready
      ? '<div class="msg msg-error">Not set up yet: the developer needs to run the piracy_ingested SQL first.</div>'
      : recent.length
        ? '<div class="field-hint" style="margin-bottom:8px;">Last emails logged:</div><ul class="pir-ingest-list">' + recent.map(function (r) {
            return '<li><b>' + escapeHtml(pirFmtDate(r.sent_on)) + '</b> ' + escapeHtml(r.subject || '(no subject)') +
              ' <span class="field-hint">' + r.links + ' link' + (r.links === 1 ? '' : 's') + (r.added ? ', ' + r.added + ' new' : '') + '</span></li>';
          }).join('') + '</ul>'
        : '<div class="field-hint">Nothing logged from Gmail yet.</div>';
    return '<details class="pir-ingest">' +
      '<summary>📧 Auto-log notices by BCC' + (recent.length ? ' <span class="pir-ingest-on">On</span>' : ' <span class="field-hint">not set up yet</span>') + '</summary>' +
      '<div class="pir-ingest-body">' +
        status +
        '<p>Write the notice anywhere (Claude chat is fine), send it from support@taai.live with "Infringement" or "Takedown" in the subject, and <b>BCC the log inbox</b>. Within 15 minutes every Telegram link in it is added to this log. The script only reads that separate inbox, never the official mailbox, and only mail from support@taai.live. The same email is never counted twice.</p>' +
        '<p><b>One-time setup (5 minutes):</b></p>' +
        '<ol>' +
          '<li>Create a new Gmail account just for this, e.g. taai.takedown.log@gmail.com, and stay signed in to it.</li>' +
          '<li>Open <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener noreferrer">script.google.com</a> as that account (it opens a new project).</li>' +
          '<li>Delete what\'s in the editor and paste the script below. Name the project "TAAI takedown log".</li>' +
          '<li>Choose <b>setup</b> in the function menu at the top and press <b>Run</b>. Allow access to Gmail when Google asks (click Advanced, then Go to TAAI takedown log).</li>' +
          '<li>From now on, BCC that address on every takedown notice you send.</li>' +
        '</ol>' +
        '<div class="pir-ingest-copy"><button type="button" class="btn btn-small" id="pir-ingest-copy">Copy script</button><span class="field-hint">Keep it private: the key lets anyone add links to this log.</span></div>' +
        '<textarea readonly class="pir-ingest-script" id="pir-ingest-script" rows="10">' + escapeHtml(pirAppsScript(g.key)) + '</textarea>' +
      '</div>' +
    '</details>';
  }

  function renderPiracyLog() {
    var p = state.piracy;
    var rows = p.rows.slice();
    var counts = { up: 0, removed: 0, unchecked: 0, moved: 0, reported: 0 };
    rows.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
    var order = { up: 0, moved: 1, reported: 2, unchecked: 3, removed: 4 };
    var q = (p.q || '').toLowerCase();
    rows = rows.filter(function (r) {
      if (p.filter !== 'all' && r.status !== p.filter) return false;
      if (q && [r.link, r.channel_name, r.role, r.notice_label, r.notes].join(' ').toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).sort(function (a, b) {
      return (order[a.status] - order[b.status]) || String(b.last_reported_on).localeCompare(String(a.last_reported_on));
    });
    var last = pirLastChecked(p.rows);
    var kindLabel = { channel: 'Channel', message: 'Message', invite: 'Invite link', private: 'Private', account: 'Account' };
    // 50 at a time (2026-11-25): the whole log at once made this tab
    // over 20,000px tall.
    var total = rows.length, limit = p.logLimit || 50;
    rows = rows.slice(0, limit);
    var table = rows.length ? (
      '<div class="students-table-wrap"><table class="students-table sitedata-table pir-table"><thead><tr>' +
        '<th>Link</th><th>Type</th><th>Reported</th><th>Status</th><th></th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        var st = PIR_STATUS[r.status] || [r.status, ''];
        return '<tr>' +
          '<td class="pir-link-cell">' + (r.channel_name ? '<div class="pir-name">' + escapeHtml(r.channel_name) + '</div>' : '') +
            '<a href="' + escapeHtml(r.link) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(r.link.replace('https://', '')) + '</a>' +
            (r.role ? '<div class="field-hint">' + escapeHtml(r.role) + '</div>' : '') +
            (r.subscribers ? '<div class="field-hint">' + Number(r.subscribers).toLocaleString('en-IN') + ' subscribers</div>' : '') +
            (function () { var n = evForLink(r.link).length; return n ? '<button type="button" class="ev-chip js-pir-ev" data-link="' + escapeHtml(r.link) + '">📎 ' + n + ' screenshot' + (n === 1 ? '' : 's') + '</button>' : ''; })() + '</td>' +
          '<td>' + escapeHtml(kindLabel[r.kind] || r.kind) + (r.scope === 'whole' ? '<div class="field-hint">whole channel</div>' : r.scope === 'suspected' ? '<div class="field-hint">suspected</div>' : '') + '</td>' +
          '<td>' + escapeHtml(pirFmtDate(r.last_reported_on)) + (r.times_reported > 1 ? ' <span class="pir-times">×' + r.times_reported + '</span>' : '') +
            (r.notice_label ? '<div class="field-hint">' + escapeHtml(r.notice_label) + '</div>' : '') + '</td>' +
          '<td><span class="pir-st ' + st[1] + '">' + escapeHtml(st[0]) + '</span>' +
            (r.check_note && r.status !== 'reported' ? '<div class="field-hint">' + escapeHtml(r.check_note) + '</div>' : '') +
            (r.removed_on ? '<div class="field-hint">since ' + escapeHtml(pirFmtDate(r.removed_on)) + '</div>' : '') + '</td>' +
          '<td class="pir-actions">' +
            (r.status !== 'removed' && r.kind !== 'account' ? '<button class="btn btn-small js-pir-again" data-id="' + escapeHtml(r.id) + '">Report again</button>' : '') +
            '<button class="btn btn-small btn-danger js-pir-delete" data-id="' + escapeHtml(r.id) + '" data-link="' + escapeHtml(r.link) + '">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>' +
      (total > rows.length ? '<div class="list-more"><button type="button" class="btn" id="pir-more">Show 50 more</button><span class="field-hint">Showing ' + rows.length + ' of ' + total + '</span></div>' : '')
    ) : '<div class="field-hint">' + (p.rows.length ? 'Nothing matches.' : 'No links logged yet. Draft a notice and press "Add to log", or set up the Gmail auto-log above.') + '</div>';
    return (
      '<div class="chal-stats">' +
        '<div class="chal-stat"><b>' + p.rows.length + '</b><span>links reported</span></div>' +
        '<div class="chal-stat"><b>' + counts.removed + '</b><span>removed</span></div>' +
        '<div class="chal-stat"><b>' + counts.up + '</b><span>still up</span></div>' +
        '<div class="chal-stat"><b>' + counts.unchecked + '</b><span>private (can\'t check)</span></div>' +
      '</div>' +
      '<div class="chal-toolbar" style="margin-top:14px;">' +
        '<select id="pir-filter">' +
          [['all', 'All'], ['up', 'Still up'], ['removed', 'Removed'], ['moved', 'Username reused'], ['unchecked', 'Private'], ['reported', 'Not checked yet']].map(function (o) {
            return '<option value="' + o[0] + '"' + (p.filter === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') +
        '</select>' +
        '<input type="search" id="pir-search" placeholder="Search link, channel, account or notice" value="' + escapeHtml(p.q || '') + '">' +
        '<button type="button" class="btn" id="pir-check"' + (p.checking ? ' disabled' : '') + '>' + (p.checking ? 'Checking Telegram…' : '↻ Check all now') + '</button>' +
      '</div>' +
      renderPiracyIngest() +
      '<div class="field-hint" style="margin:6px 0 12px;">Checked daily at 9 AM IST from Telegram\'s public pages' + (last ? '. Last check: ' + escapeHtml(fmtIstDateTime(last)) : '') + '. A weekly summary can go to Discord: add an Announcements post with the "Piracy takedown status" source.</div>' +
      table
    );
  }

  function pirFieldHtml(i, key, label, val, opts) {
    opts = opts || {};
    var attrs = ' data-pir-sec="' + i + '" data-pir-key="' + key + '"';
    var input = opts.textarea
      ? '<textarea rows="' + (opts.rows || 3) + '"' + attrs + ' placeholder="' + escapeHtml(opts.ph || '') + '">' + escapeHtml(val) + '</textarea>'
      : '<input type="text"' + attrs + ' value="' + escapeHtml(val) + '" placeholder="' + escapeHtml(opts.ph || '') + '">';
    return '<label class="pir-field' + (opts.wide ? ' pir-wide' : '') + '"><span>' + label + '</span>' + input + (opts.hint ? '<span class="field-hint">' + opts.hint + '</span>' : '') + '</label>';
  }

  function renderPiracyNotice() {
    var p = state.piracy;
    var d = p.draft;
    var secs = d.sections.map(function (sec, i) {
      return '<div class="pir-sec">' +
        '<div class="pir-sec-head"><b>' + (d.sections.length > 1 ? 'Section ' + (i + 1) : 'Channel') + '</b>' +
          (d.sections.length > 1 ? '<button type="button" class="btn btn-small js-pir-sec-remove" data-i="' + i + '">Remove</button>' : '') + '</div>' +
        '<div class="pir-grid">' +
          pirFieldHtml(i, 'name', 'Channel name', sec.name, { ph: 'TAAI - Gate Da Latest 2027' }) +
          pirFieldHtml(i, 'link', 'Channel link or private ID', sec.link, { ph: 'https://t.me/TAAIGateDA or -1002230080912' }) +
          pirFieldHtml(i, 'subs', 'Subscribers', sec.subs, { ph: '1255' }) +
          '<label class="pir-field"><span>What to ask for</span><select data-pir-sec="' + i + '" data-pir-key="scope">' +
            [['whole', 'Remove the whole channel'], ['messages', 'Remove just these messages'], ['suspected', 'Suspected: ask Telegram to review']].map(function (o) {
              return '<option value="' + o[0] + '"' + (sec.scope === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
            }).join('') + '</select></label>' +
          pirFieldHtml(i, 'messages', sec.scope === 'whole' ? 'Sample message links' : 'Message links', sec.messages, { textarea: true, wide: true, ph: 'One link per line\nhttps://t.me/c/4492823345/640', hint: 'For a private channel, copy the message link (it looks like https://t.me/c/ID/123).' }) +
          pirFieldHtml(i, 'nature', 'Nature of infringement', sec.nature, { textarea: true, wide: true, ph: 'Distributes TAAI\'s paid Machine Learning lectures and PDFs, uses the TAAI logo as its profile picture, posts viewed 2,000+ times.', hint: 'Mention the TAAI logo or name, Manoj Kumar\'s photo, PDF names with "lyst…", prices it\'s sold for, views and subscribers.' }) +
          pirFieldHtml(i, 'accounts', 'Associated accounts', sec.accounts, { textarea: true, wide: true, rows: 2, ph: 'https://t.me/DincForge – uploader\nhttps://t.me/Piratedman01 – seller' }) +
          (sec.scope === 'whole' ? '<label class="pir-check pir-wide"><input type="checkbox" data-pir-sec="' + i + '" data-pir-key="actAccounts"' + (sec.actAccounts ? ' checked' : '') + '> Ask Telegram to act against these accounts too</label>' : '') +
        '</div>' +
      '</div>';
    }).join('');
    return (
      '<div class="pir-notice-layout">' +
        '<div class="pir-form">' +
          '<div class="pir-grid">' +
            '<label class="pir-field"><span>Notice name (for the log)</span><input type="text" data-pir-top="label" value="' + escapeHtml(d.label) + '"></label>' +
            '<label class="pir-field"><span>Subject: unauthorized…</span><select data-pir-top="kind">' +
              ['Distribution', 'Promotion', 'Sale', 'Distribution and Sale'].map(function (k) { return '<option' + (d.kind === k ? ' selected' : '') + '>' + k + '</option>'; }).join('') +
            '</select></label>' +
            '<label class="pir-field pir-wide"><span>"It has come to our attention that…"</span><textarea rows="2" data-pir-top="description" placeholder="the Telegram channels listed below are distributing TAAI\'s paid GATE DA courses for free and selling them for ₹1,000">' + escapeHtml(d.description) + '</textarea><span class="field-hint">"…without our authorization." is added after it.</span></label>' +
            '<label class="pir-field pir-wide"><span>Course to point to</span><select data-pir-top="course">' +
              PIR_COURSES.map(function (c) { return '<option value="' + escapeHtml(c[0]) + '"' + (d.course === c[0] ? ' selected' : '') + '>' + escapeHtml(c[1]) + '</option>'; }).join('') +
            '</select></label>' +
          '</div>' +
          secs +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">' +
            '<button type="button" class="btn" id="pir-add-sec">+ Add another channel</button>' +
            '<button type="button" class="btn" id="pir-clear">Start a new notice</button>' +
          '</div>' +
          '<details class="pir-sig"><summary>Signature</summary>' +
            '<textarea id="pir-sig-text" rows="6">' + escapeHtml(p.signature || PIR_DEFAULT_SIGNATURE) + '</textarea>' +
            '<div style="display:flex;gap:8px;margin-top:8px;"><button type="button" class="btn btn-primary" id="pir-sig-save"' + (p.sigSaving ? ' disabled' : '') + '>' + (p.sigSaving ? 'Saving…' : 'Save signature') + '</button></div>' +
            '<div class="field-hint">Shared by everyone on the team. Saved in the database, not the website code.</div>' +
          '</details>' +
        '</div>' +
        '<div class="pir-out" id="pir-out">' + renderPiracyPreview() + '</div>' +
      '</div>'
    );
  }

  function renderPiracyPreview() {
    var p = state.piracy;
    var n = pirBuildNotice(p.draft, p.rows);
    var w = n.warnings.length ? '<div class="pir-warnings">' + n.warnings.map(function (x) {
      return '<div class="pir-warn pir-warn-' + x.type + '">' + (x.type === 'dup' ? '🔁 ' : x.type === 'invite' ? '⚠️ ' : x.type === 'mismatch' ? '⚠️ ' : '💡 ') + escapeHtml(x.text) + '</div>';
    }).join('') + '</div>' : '';
    return w +
      '<div class="pir-out-row"><b>Subject</b><button type="button" class="btn btn-small" data-pir-copy="subject">Copy subject</button></div>' +
      '<textarea readonly class="pir-out-subject" id="pir-subject">' + escapeHtml(n.subject) + '</textarea>' +
      '<div class="pir-out-row"><b>Notice</b><button type="button" class="btn btn-small" data-pir-copy="body">Copy notice</button></div>' +
      '<textarea readonly class="pir-out-body" id="pir-body">' + escapeHtml(n.body) + '</textarea>' +
      '<div class="pir-out-row" style="margin-top:12px;">' +
        '<button type="button" class="btn btn-primary" id="pir-log-add"' + (p.saving || !n.sections.length ? ' disabled' : '') + '>' + (p.saving ? 'Adding…' : 'Sent it: add these links to the log') + '</button>' +
      '</div>' +
      '<div class="field-hint">Send it yourself (with screenshots and ownership documents attached), then press the button so the links are checked daily.</div>';
  }

  function renderPiracyTabs() {
    var p = state.piracy;
    var fresh = p.candidates.filter(function (c) { return c.status === 'new'; }).length;
    var t = function (key, label, count) {
      return '<button class="tab-btn' + (p.sub === key ? ' active' : '') + '" data-pirtab="' + key + '">' + label + (count ? ' <span class="tab-count">' + count + '</span>' : '') + '</button>';
    };
    return '<div class="tabs subtabs">' + t('log', 'Log', p.rows.length) + t('found', 'Found', fresh ? fresh + ' new' : 0) + t('notice', 'New notice', 0) + t('evidence', 'Evidence', p.ev.files.length) + '</div>';
  }
  function renderPiracyPanel() {
    var p = state.piracy;
    if (!p.draft) p.draft = pirLoadDraft();
    if (p.loading && !p.loaded) return '<div class="card"><div class="field-hint">Loading…</div></div>';
    return '<div class="card">' +
      (p.error ? '<div class="msg msg-error">' + escapeHtml(p.error) + '</div>' : '') +
      (p.msg ? '<div class="msg msg-ok">' + escapeHtml(p.msg) + '</div>' : '') +
      (p.sub === 'notice' ? renderPiracyNotice() : p.sub === 'found' ? renderPiracyFound() : p.sub === 'evidence' ? renderPiracyEvidence() : renderPiracyLog()) +
    '</div>';
  }

  // ── Evidence (2026-11-24) ───────────────────────────────────────────────
  // Screenshots kept for possible legal action, in the PRIVATE storage bucket
  // "piracy-evidence" (uploaded unchanged by scripts/upload-piracy-evidence.mjs
  // with a SHA-256 fingerprint per file). team-piracy-evidence.js gives signed
  // links that last an hour, so they're re-fetched after 50 minutes.
  function loadPiracyEvidence() {
    var ev = state.piracy.ev;
    ev.loading = true; ev.error = null;
    api('/team-piracy-evidence').then(function (data) {
      ev.files = data.files || []; ev.error = data.ready === false ? null : (data.error || null);
      ev.reports = data.reports || []; ev.reportsReady = !!data.reportsReady; ev.unfiled = data.unfiled || [];
      ev.loaded = true; ev.loading = false; ev.fetchedAt = Date.now();
      render();
    }).catch(function (err) { ev.loading = false; ev.loaded = true; ev.error = err.message; render(); });
  }
  // The index's "Link(s)" column in its own shorthand: "https://t.me/x/55,70",
  // "https://t.me/c/123/700-728", "https://t.me/c/123/2/4-17". Returns pirKey()s.
  function evKeys(links) {
    var out = [], prev = null;
    String(links || '').split(/\s+·\s+|,/).forEach(function (tok) {
      tok = tok.trim().replace(/^\//, '');
      if (!tok) return;
      var url;
      if (/^(https?:\/\/)?(t\.me|telegram\.me)\//i.test(tok)) url = pirNorm(tok);
      else if (/^\d+(-\d+)?$/.test(tok) && prev) url = prev.replace(/\/\d+(-\d+)?$/, '') + '/' + tok;
      else return;
      prev = url;
      var r = url.match(/^(.*\/)(\d+)-(\d+)$/);
      if (r) { for (var n = +r[2]; n <= +r[3] && n - +r[2] < 300; n++) out.push(pirKey(r[1] + n)); }
      else out.push(pirKey(url));
    });
    return out;
  }
  function evRoot(k) { var m = k.match(/^(https:\/\/t\.me\/c\/\d+|https:\/\/t\.me\/[^\/]+)/); return m ? m[1] : k; }
  // Screenshots that back up one logged link: the same link, or (for a whole
  // channel / account) anything from that channel.
  function evForLink(link) {
    var key = pirKey(link);
    if (!key) return [];
    var isRoot = evRoot(key) === key;
    return state.piracy.ev.files.filter(function (f) {
      if (!f._keys) f._keys = evKeys(f.links);
      return f._keys.some(function (k) { return k === key || (isRoot && evRoot(k) === key) || evRoot(key) === k; });
    });
  }
  function evName(path) { return path.split('/').pop(); }
  function evNetwork(f) { return f.path.indexOf('/') === -1 ? 'Combined files' : f.path.split('/')[0].replace(/^\d+_/, '').replace(/-/g, ' '); }
  function evDownloadUrl(f) { return f.url + (f.url.indexOf('?') === -1 ? '?' : '&') + 'download=' + encodeURIComponent(evName(f.path)); }
  function evCardHtml(f) {
    var isImg = /^image\//.test(f.type || '');
    return '<div class="ev-card">' +
      (f.url
        ? (isImg ? '<a class="ev-thumb" href="' + escapeHtml(f.url) + '" target="_blank" rel="noopener"><img loading="lazy" src="' + escapeHtml(f.url) + '" alt="' + escapeHtml((f.target || evName(f.path)) + ', ' + (f.what || 'screenshot')) + '"></a>'
                 : '<a class="ev-thumb ev-doc" href="' + escapeHtml(f.url) + '" target="_blank" rel="noopener">' + (f.type === 'application/pdf' ? 'PDF' : 'FILE') + '</a>')
        : '<div class="ev-thumb ev-doc">?</div>') +
      '<div class="ev-meta">' +
        '<div class="ev-title">' + escapeHtml(f.target ? f.target.replace(/_/g, ' ') : evName(f.path)) + '</div>' +
        '<div class="field-hint">Captured ' + escapeHtml(f.captured_on ? pirFmtDate(f.captured_on) : 'date unknown') + (f.bytes ? ' · ' + Math.round(f.bytes / 1024).toLocaleString('en-IN') + ' KB' : '') + '</div>' +
        (f.what ? '<div class="ev-what">' + escapeHtml(f.what) + '</div>' : '') +
        (f.links ? '<div class="ev-links">' + escapeHtml(f.links) + '</div>' : '') +
        '<div class="ev-hash" title="SHA-256 fingerprint of the original file">SHA-256 ' + escapeHtml(f.sha256 || '') + '</div>' +
        (f.url ? '<div class="ev-actions"><a class="btn btn-small" href="' + escapeHtml(f.url) + '" target="_blank" rel="noopener">Open</a><a class="btn btn-small" href="' + escapeHtml(evDownloadUrl(f)) + '">Download</a></div>' : '') +
      '</div>' +
    '</div>';
  }
  function evFiltered() {
    var ev = state.piracy.ev, q = (ev.q || '').trim();
    if (!q) return ev.files;
    if (/t\.me\//i.test(q)) {
      var hits = evForLink(q);
      if (hits.length) return hits;
    }
    var ql = q.toLowerCase();
    return ev.files.filter(function (f) { return [f.path, f.network, f.target, f.links, f.what, f.captured_on, f.sha256].join(' ').toLowerCase().indexOf(ql) !== -1; });
  }
  function renderPiracyEvidence() {
    var ev = state.piracy.ev;
    if (!ev.loaded) return '<div class="field-hint">Loading evidence…</div>';
    if (ev.error) return '<div class="msg msg-error">' + escapeHtml(ev.error) + '</div>';
    if (!ev.files.length) return '<div class="field-hint">No evidence stored yet.</div>';
    var files = evFiltered();
    var groups = {}, order = [];
    files.forEach(function (f) { var g = evNetwork(f); if (!groups[g]) { groups[g] = []; order.push(g); } groups[g].push(f); });
    order.sort(function (a, b) { return (a === 'Combined files') - (b === 'Combined files') || groups[b].length - groups[a].length; });
    var nets = {}; ev.files.forEach(function (f) { if (f.path.indexOf('/') !== -1) nets[evNetwork(f)] = 1; });
    var dates = ev.files.map(function (f) { return f.captured_on; }).filter(Boolean).sort();
    var openAll = !!(ev.q || '').trim();
    return (
      '<div class="chal-stats">' +
        '<div class="chal-stat"><b>' + ev.files.length + '</b><span>files stored</span></div>' +
        '<div class="chal-stat"><b>' + Object.keys(nets).length + '</b><span>operator networks</span></div>' +
        '<div class="chal-stat"><b>' + (dates.length ? escapeHtml(pirFmtDate(dates[0])) + ' to ' + escapeHtml(pirFmtDate(dates[dates.length - 1])) : '-') + '</b><span>captured</span></div>' +
      '</div>' +
      '<div class="field-hint" style="margin:12px 0;">Kept for legal action. The original files are stored unchanged in private storage, never on the public site. Links here stop working after an hour. Each file\'s SHA-256 fingerprint was recorded when it was stored, so anyone can check later that it hasn\'t been edited. Download the list and keep a copy with the files.</div>' +
      (ev.reportsReady ? '<div class="tabs ev-view-tabs">' +
        '<button type="button" class="tab-btn' + (ev.view === 'report' ? ' active' : '') + '" data-evview="report">By report</button>' +
        '<button type="button" class="tab-btn' + (ev.view === 'network' ? ' active' : '') + '" data-evview="network">By network</button>' +
      '</div>' : '') +
      '<div class="chal-toolbar">' +
        '<input type="search" id="ev-search" placeholder="Search channel, account, link, date or description" value="' + escapeHtml(ev.q || '') + '">' +
        (ev.q ? '<button type="button" class="btn" id="ev-clear">Show all</button>' : '') +
        '<button type="button" class="btn" id="ev-csv">⬇ Fingerprint list (CSV)</button>' +
      '</div>' +
      (ev.reportsReady && ev.view === 'report' ? renderEvReports() : files.length ? order.map(function (g) {
        var open = openAll || ev.open[g];
        return '<details class="ev-group" data-evgroup="' + escapeHtml(g) + '"' + (open ? ' open' : '') + '>' +
          '<summary><span>' + escapeHtml(g) + '</span><span class="field-hint">' + groups[g].length + ' file' + (groups[g].length === 1 ? '' : 's') + '</span></summary>' +
          '<div class="ev-grid">' + groups[g].sort(function (a, b) { return String(a.captured_on).localeCompare(String(b.captured_on)) || a.path.localeCompare(b.path); }).map(evCardHtml).join('') + '</div>' +
        '</details>';
      }).join('') : '<div class="field-hint" style="margin-top:12px;">Nothing matches.</div>')
    );
  }
  // ── By report: one group per row of the takedown log (reports.csv), with
  // the screenshots the server matched to it (team-piracy-evidence.js).
  function evReportMatches(r, q) {
    if (!q) return true;
    var byPath = evByPath();
    if (/t\.me\//i.test(q)) {
      var hits = evForLink(q).map(function (f) { return f.path; });
      if (r.files.some(function (pth) { return hits.indexOf(pth) !== -1; })) return true;
    }
    var ql = q.toLowerCase();
    var text = [r.date, r.channel, r.status, r.request, r.channel_link, r.links, r.accounts, r.notes, r.network, r.evidence].join(' ');
    r.files.forEach(function (pth) { var f = byPath[pth]; if (f) text += ' ' + [f.path, f.target, f.what, f.links, f.sha256].join(' '); });
    return text.toLowerCase().indexOf(ql) !== -1;
  }
  function evByPath() {
    var ev = state.piracy.ev;
    if (!ev._byPath || ev._byPathFor !== ev.files) { ev._byPath = {}; ev.files.forEach(function (f) { ev._byPath[f.path] = f; }); ev._byPathFor = ev.files; }
    return ev._byPath;
  }
  function evIso(r) { return r.iso || ''; }
  function evReportText(r) {
    var byPath = evByPath();
    var lines = [
      'TAAI takedown report #' + r.n,
      'Date drafted: ' + (r.date || '-'),
      'Channel / group: ' + (r.channel || '-'),
      'Status: ' + (r.status || '-'),
      'Request: ' + (r.request || '-'),
      'Channel link / ID: ' + (r.channel_link || '-'),
      'Infringing links: ' + (r.links || '-'),
      'Associated accounts: ' + (r.accounts || '-'),
      'Network / operator: ' + (r.network || '-'),
      'Notes: ' + (r.notes || '-'),
      'Evidence remarks: ' + (r.evidence || '-'),
      '',
      'Screenshots (' + r.files.length + '), stored unchanged in TAAI\'s private evidence storage:'
    ];
    r.files.forEach(function (pth, i) {
      var f = byPath[pth] || { path: pth };
      lines.push('', (i + 1) + '. ' + evName(pth), '   Captured: ' + (f.captured_on || '-'), '   Shows: ' + (f.what || '-'), '   Links: ' + (f.links || '-'), '   SHA-256: ' + (f.sha256 || '-'));
    });
    return lines.join('\n') + '\n';
  }
  function renderEvReports() {
    var ev = state.piracy.ev, q = (ev.q || '').trim(), byPath = evByPath();
    var list = ev.reports.filter(function (r) { return evReportMatches(r, q); });
    var withFiles = ev.reports.filter(function (r) { return r.files.length; }).length;
    var html = '<div class="field-hint" style="margin:12px 0 0;">' + ev.reports.length + ' reports from the takedown log, ' + withFiles + ' with screenshots. A screenshot is filed under a report when it shows one of the report\'s message links, or (for a channel, invite or account page) when it was captured the same day.</div>';
    if (!list.length) return html + '<div class="field-hint" style="margin-top:12px;">Nothing matches.</div>';
    html += list.map(function (r) {
      var key = 'r' + r.n;
      var open = !!q || ev.open[key];
      var meta = [['Request', r.request], ['Status', r.status], ['Channel link / ID', r.channel_link], ['Infringing links', r.links], ['Associated accounts', r.accounts], ['Network / operator', r.network], ['Notes', r.notes], ['Evidence remarks', r.evidence]]
        .filter(function (m) { return m[1]; })
        .map(function (m) { return '<dt>' + escapeHtml(m[0]) + '</dt><dd>' + escapeHtml(m[1]) + '</dd>'; }).join('');
      var cards = r.files.map(function (pth) {
        var f = byPath[pth]; if (!f) return '';
        var later = evIso(r) && f.captured_on && f.captured_on > evIso(r);
        var earlier = evIso(r) && f.captured_on && f.captured_on < evIso(r);
        return '<div class="ev-card-wrap">' + (later ? '<div class="ev-when">Captured later, ' + escapeHtml(pirFmtDate(f.captured_on)) + '</div>' : earlier ? '<div class="ev-when">From an earlier report, ' + escapeHtml(pirFmtDate(f.captured_on)) + '</div>' : '') + evCardHtml(f) + '</div>';
      }).join('');
      return '<details class="ev-group ev-report" data-evgroup="' + key + '"' + (open ? ' open' : '') + '>' +
        '<summary><span><span class="ev-rep-n">#' + r.n + '</span> ' + escapeHtml(r.date || 'Undated') + ' · ' + escapeHtml(r.channel || '(no name)') +
          '<span class="ev-rep-req">' + escapeHtml(r.request || '') + '</span></span>' +
          '<span class="field-hint">' + (r.files.length ? r.files.length + ' screenshot' + (r.files.length === 1 ? '' : 's') : 'No screenshots') + '</span></summary>' +
        '<div class="ev-rep-body">' +
          '<dl class="ev-rep-meta">' + meta + '</dl>' +
          '<div class="ev-actions" style="margin:0 0 12px;"><button type="button" class="btn btn-small js-ev-rep-dl" data-n="' + r.n + '">⬇ Report summary (text)</button></div>' +
          (cards ? '<div class="ev-grid ev-grid-flush">' + cards + '</div>' : '<div class="field-hint">No screenshot in storage matches this report.</div>') +
        '</div>' +
      '</details>';
    }).join('');
    if (ev.unfiled.length && !q) {
      html += '<details class="ev-group" data-evgroup="unfiled"' + (ev.open.unfiled ? ' open' : '') + '><summary><span>Not matched to any report</span><span class="field-hint">' + ev.unfiled.length + '</span></summary>' +
        '<div class="ev-grid">' + ev.unfiled.map(function (pth) { return byPath[pth] ? evCardHtml(byPath[pth]) : ''; }).join('') + '</div></details>';
    }
    return html;
  }

  function bindPiracyEvidence() {
    var ev = state.piracy.ev;
    var search = document.getElementById('ev-search');
    if (search) {
      search.addEventListener('change', function () { ev.q = search.value.trim(); render(); });
      search.addEventListener('keydown', function (e) { if (e.key === 'Enter') { ev.q = search.value.trim(); render(); } });
    }
    document.querySelectorAll('[data-evview]').forEach(function (b) {
      b.addEventListener('click', function () { ev.view = b.getAttribute('data-evview'); render(); });
    });
    document.querySelectorAll('.js-ev-rep-dl').forEach(function (b) {
      b.addEventListener('click', function () {
        var r = ev.reports.filter(function (x) { return String(x.n) === b.getAttribute('data-n'); })[0];
        if (!r) return;
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([evReportText(r)], { type: 'text/plain' }));
        a.download = 'taai-takedown-report-' + r.n + (r.iso ? '-' + r.iso : '') + '.txt';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      });
    });
    var clear = document.getElementById('ev-clear');
    if (clear) clear.addEventListener('click', function () { ev.q = ''; render(); });
    document.querySelectorAll('[data-evgroup]').forEach(function (d) {
      d.addEventListener('toggle', function () { if (!(ev.q || '').trim()) ev.open[d.getAttribute('data-evgroup')] = d.open; });
    });
    var csv = document.getElementById('ev-csv');
    if (csv) csv.addEventListener('click', function () {
      var cols = ['path', 'sha256', 'bytes', 'captured_on', 'network', 'target', 'links', 'what', 'uploaded_at'];
      var q = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var text = cols.join(',') + '\n' + ev.files.map(function (f) { return cols.map(function (c) { return q(f[c]); }).join(','); }).join('\n') + '\n';
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      a.download = 'taai-piracy-evidence-fingerprints-' + pirToday() + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    });
  }

  function pirRefreshPreview() {
    var out = document.getElementById('pir-out');
    if (out) { out.innerHTML = renderPiracyPreview(); bindPiracyPreview(); }
  }

  function pirCopy(id, btn) {
    var ta = document.getElementById(id);
    if (!ta) return;
    var done = function () { var t = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(function () { btn.textContent = t; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); document.execCommand('copy'); done(); });
    else { ta.select(); document.execCommand('copy'); done(); }
  }

  function bindPiracyPreview() {
    document.querySelectorAll('[data-pir-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () { pirCopy(btn.getAttribute('data-pir-copy') === 'subject' ? 'pir-subject' : 'pir-body', btn); });
    });
    var add = document.getElementById('pir-log-add');
    if (add) add.addEventListener('click', function () {
      var p = state.piracy;
      var items = pirLogItems(p.draft);
      if (!items.length) return;
      p.saving = true; p.error = null; p.msg = null;
      pirRefreshPreview();
      api('/team-piracy', { method: 'POST', body: JSON.stringify({ action: 'add', notice_label: p.draft.label, reported_on: pirToday(), items: items }) }).then(function (res) {
        p.saving = false;
        p.msg = 'Added to the log: ' + res.added + ' new link' + (res.added === 1 ? '' : 's') + (res.updated ? ', ' + res.updated + ' already there (marked reported again)' : '') + '. Checking them on Telegram now…';
        p.draft = pirNewDraft(); pirSaveDraft();
        p.sub = 'log';
        return api('/team-piracy').then(function (data) {
          p.rows = data.rows || [];
          render();
          return pirRunCheck();
        });
      }).catch(function (err) { p.saving = false; p.error = err.message; render(); });
    });
  }

  function pirRunCheck() {
    var p = state.piracy;
    p.checking = true; render();
    return api('/team-piracy', { method: 'POST', body: JSON.stringify({ action: 'check' }) }).then(function (res) {
      p.msg = 'Checked ' + res.checked + ' link' + (res.checked === 1 ? '' : 's') + ': ' + res.removed + ' removed, ' + res.up + ' still up' +
        (res.newlyRemoved && res.newlyRemoved.length ? '. Newly removed: ' + res.newlyRemoved.length : '') +
        (res.skipped ? '. ' + res.skipped + ' not checked (ran out of time), press again' : '') + '.';
      return api('/team-piracy');
    }).then(function (data) {
      p.checking = false; p.rows = data.rows || []; render();
    }).catch(function (err) { p.checking = false; p.error = err.message; render(); });
  }

  function bindPiracy() {
    var p = state.piracy;
    document.querySelectorAll('[data-pirtab]').forEach(function (btn) {
      btn.addEventListener('click', function () { p.sub = btn.getAttribute('data-pirtab'); p.msg = null; render(); });
    });
    if (!p.ev.loading && (!p.ev.loaded || (p.sub === 'evidence' && Date.now() - p.ev.fetchedAt > 50 * 60 * 1000))) loadPiracyEvidence();
    document.querySelectorAll('.js-pir-ev').forEach(function (b) {
      b.addEventListener('click', function () { p.sub = 'evidence'; p.ev.q = b.getAttribute('data-link'); p.msg = null; render(); window.scrollTo(0, 0); });
    });
    if (p.sub === 'evidence') bindPiracyEvidence();
    var filter = document.getElementById('pir-filter');
    if (filter) filter.addEventListener('change', function () { p.filter = filter.value; p.logLimit = 50; render(); });
    var search = document.getElementById('pir-search');
    if (search) search.addEventListener('change', function () { p.q = search.value.trim(); p.logLimit = 50; render(); });
    if (search) search.addEventListener('keydown', function (e) { if (e.key === 'Enter') { p.q = search.value.trim(); p.logLimit = 50; render(); } });
    var pirMore = document.getElementById('pir-more');
    if (pirMore) pirMore.addEventListener('click', function () { p.logLimit = (p.logLimit || 50) + 50; render(); });
    var ingestCopy = document.getElementById('pir-ingest-copy');
    if (ingestCopy) ingestCopy.addEventListener('click', function () { pirCopy('pir-ingest-script', ingestCopy); });
    var check = document.getElementById('pir-check');
    if (check) check.addEventListener('click', function () { p.msg = null; p.error = null; pirRunCheck(); });
    document.querySelectorAll('.js-pir-delete').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!window.confirm('Remove ' + btn.getAttribute('data-link') + ' from the log?')) return;
        var id = btn.getAttribute('data-id');
        api('/team-piracy?id=' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
          p.rows = p.rows.filter(function (r) { return r.id !== id; }); p.msg = 'Removed from the log.'; render();
        }).catch(function (err) { p.error = err.message; render(); });
      });
    });
    document.querySelectorAll('.js-pir-again').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var r = p.rows.filter(function (x) { return x.id === btn.getAttribute('data-id'); })[0];
        if (!r) return;
        var sec = pirNewSection();
        sec.name = r.channel_name || '';
        if (r.kind === 'message' || /^https:\/\/t\.me\/c\/\d+\/\d+$/.test(r.link)) {
          sec.scope = 'messages'; sec.messages = r.link;
          sec.link = r.link.replace(/\/\d+$/, '');
        } else { sec.link = r.link; sec.scope = r.scope === 'suspected' ? 'suspected' : 'whole'; }
        if (r.subscribers) sec.subs = String(r.subscribers);
        var blank = p.draft.sections.length === 1 && !p.draft.sections[0].link && !p.draft.sections[0].messages;
        if (blank) p.draft.sections = [sec]; else p.draft.sections.push(sec);
        pirSaveDraft();
        p.sub = 'notice'; p.msg = null; render();
      });
    });

    document.querySelectorAll('[data-pir-top]').forEach(function (el) {
      var ev = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, function () { p.draft[el.getAttribute('data-pir-top')] = el.value; pirSaveDraft(); pirRefreshPreview(); });
    });
    document.querySelectorAll('[data-pir-sec]').forEach(function (el) {
      var i = +el.getAttribute('data-pir-sec'); var key = el.getAttribute('data-pir-key');
      var ev = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
      el.addEventListener(ev, function () {
        p.draft.sections[i][key] = el.type === 'checkbox' ? el.checked : el.value;
        pirSaveDraft();
        if (key === 'scope') render(); else pirRefreshPreview();
      });
    });
    document.querySelectorAll('.js-pir-sec-remove').forEach(function (btn) {
      btn.addEventListener('click', function () { p.draft.sections.splice(+btn.getAttribute('data-i'), 1); pirSaveDraft(); render(); });
    });
    var addSec = document.getElementById('pir-add-sec');
    if (addSec) addSec.addEventListener('click', function () { p.draft.sections.push(pirNewSection()); pirSaveDraft(); render(); });
    var clear = document.getElementById('pir-clear');
    if (clear) clear.addEventListener('click', function () {
      if (!window.confirm('Clear this draft and start a new notice?')) return;
      p.draft = pirNewDraft(); pirSaveDraft(); render();
    });
    var sigSave = document.getElementById('pir-sig-save');
    if (sigSave) sigSave.addEventListener('click', function () {
      var t = document.getElementById('pir-sig-text').value;
      p.sigSaving = true; p.error = null; render();
      api('/site-settings', { method: 'PUT', body: JSON.stringify({ piracy_signature: t }) }).then(function () {
        p.sigSaving = false; p.signature = t.trim() || null; p.msg = 'Signature saved.'; render();
      }).catch(function (err) { p.sigSaving = false; p.error = err.message; render(); });
    });
    bindPiracyPreview();
    bindPiracyFound();
  }

  // Scanner finds (piracy-scanner/scanner.py writes piracy_candidates).
  var PIR_SCANNER_DEFAULT_TERMS = ['TAAI', 'TAAI GATE', 'TAAI GATE DA', 'Taai course', 'TAAI Manoj', 'Manoj Kumar GATE DA',
    'GATE DA 2027 course', 'GATE DA 2028 course', 'GATE DA full course free', 'Maths ML Bundle GATE DA',
    'Linear Algebra -GATE DA', 'Probability -GATE DA', 'Statistics - GATE DA', 'Calculus and Optimization -GATE DA',
    'GATE DA Maths Practice Quizzes', 'TAAI Full Length Tests', 'Say Hi to ML'];

  function renderPiracyFound() {
    var p = state.piracy;
    if (!p.candidatesReady) {
      return '<div class="field-hint" style="font-size:14px;line-height:1.6;">The Telegram scanner isn\'t set up yet. It runs daily on GitHub Actions, logged into a spare Telegram account, and lists channels that look like they share TAAI courses here, for you to review. Setup steps are in <code>piracy-scanner/README.md</code> in the code (ask the developer). It also needs the <code>piracy_candidates</code> SQL run once.</div>';
    }
    var inLog = {};
    p.rows.forEach(function (r) { inLog[pirKey(r.link)] = r; });
    var list = p.candidates.filter(function (c) { return c.status === p.foundFilter; });
    var counts = { 'new': 0, confirmed: 0, dismissed: 0 };
    p.candidates.forEach(function (c) { counts[c.status] = (counts[c.status] || 0) + 1; });
    var cards = list.length ? list.map(function (c) {
      var logged = inLog[pirKey(c.link)];
      var reasons = Array.isArray(c.reasons) ? c.reasons : [];
      var samples = Array.isArray(c.sample_links) ? c.sample_links : [];
      var files = Array.isArray(c.file_names) ? c.file_names : [];
      return '<div class="pir-found">' +
        '<div class="pir-found-head">' +
          '<div><div class="pir-name">' + escapeHtml(c.title || c.username || c.link) + '</div>' +
            '<a href="' + escapeHtml(c.link) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(c.link.replace('https://', '')) + '</a>' +
            '<div class="field-hint">' + escapeHtml({ channel: 'Channel', group: 'Group', invite: 'Private invite' }[c.kind] || c.kind || '') +
              (c.subscribers ? ' · ' + Number(c.subscribers).toLocaleString('en-IN') + ' members' : '') +
              ' · found ' + escapeHtml(fmtIstDateTime(c.first_seen_at)) + '</div></div>' +
          '<div class="pir-score" title="How strongly it matches TAAI (4 or more is shown)">' + c.score + '<span>score</span></div>' +
        '</div>' +
        (logged ? '<div class="pir-warn pir-warn-dup">🔁 Already in the log: reported ' + escapeHtml(pirFmtDate(logged.last_reported_on)) + ', ' + escapeHtml((PIR_STATUS[logged.status] || [logged.status])[0]) + '.</div>' : '') +
        '<ul class="pir-reasons">' + reasons.map(function (r) { return '<li>' + escapeHtml(r) + '</li>'; }).join('') + '</ul>' +
        (samples.length ? '<div class="field-hint">Posts: ' + samples.map(function (l) { return '<a href="' + escapeHtml(l) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(l.replace(/^https:\/\/t\.me\//, '')) + '</a>'; }).join(' · ') + '</div>' : '') +
        (files.length ? '<div class="field-hint">Files: ' + files.map(escapeHtml).join(' · ') + '</div>' : '') +
        (c.found_via ? '<div class="field-hint">How it was found: ' + escapeHtml(c.found_via) + '</div>' : '') +
        '<div class="pir-found-actions">' +
          (c.status === 'new'
            ? '<button class="btn btn-primary btn-small js-pir-found-draft" data-id="' + escapeHtml(c.id) + '">It\'s piracy: draft a notice</button>' +
              '<button class="btn btn-small js-pir-found-status" data-id="' + escapeHtml(c.id) + '" data-status="dismissed">Not piracy</button>'
            : '<button class="btn btn-small js-pir-found-status" data-id="' + escapeHtml(c.id) + '" data-status="new">Move back to New</button>') +
        '</div>' +
      '</div>';
    }).join('') : '<div class="field-hint">' + (p.foundFilter === 'new' ? 'Nothing new to review. The scanner runs daily around 7:30 AM IST.' : 'None.') + '</div>';
    return (
      '<div class="chal-toolbar">' +
        '<select id="pir-found-filter">' +
          [['new', 'New (' + counts['new'] + ')'], ['confirmed', 'Turned into a notice (' + counts.confirmed + ')'], ['dismissed', 'Not piracy (' + counts.dismissed + ')']].map(function (o) {
            return '<option value="' + o[0] + '"' + (p.foundFilter === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') +
        '</select>' +
      '</div>' +
      '<div class="field-hint" style="margin:0 0 12px;">Found by the Telegram scanner. Open each link and check it really is TAAI content before drafting a notice: the scanner only matches names, words and file names.</div>' +
      cards +
      renderPiracyTermStats() +
      '<details class="pir-sig" style="margin-top:18px;"><summary>Search terms</summary>' +
        '<textarea id="pir-terms-text" rows="10" placeholder="' + escapeHtml(PIR_SCANNER_DEFAULT_TERMS.join('\n')) + '">' + escapeHtml(p.terms || '') + '</textarea>' +
        '<div style="display:flex;gap:8px;margin-top:8px;"><button type="button" class="btn btn-primary" id="pir-terms-save"' + (p.termsSaving ? ' disabled' : '') + '>' + (p.termsSaving ? 'Saving…' : 'Save search terms') + '</button></div>' +
        '<div class="field-hint">One per line. Leave empty to use the built-in list shown in grey. Course names, odd lesson titles and the ways pirates disguise "TAAI" work best. Used from the next daily run.</div>' +
      '</details>'
    );
  }

  // Which search terms find things: totals over every scanner run
  // (piracy_scan_runs) plus how the channels each term matched were judged
  // (piracy_candidates.matched_terms + status).
  function renderPiracyTermStats() {
    var p = state.piracy;
    if (!p.runs.length) return '';
    var current = (p.terms || PIR_SCANNER_DEFAULT_TERMS.join('\n')).split('\n').map(function (t) { return t.trim(); }).filter(function (t) { return t && t.charAt(0) !== '#'; });
    var stats = {};
    function get(t) { return stats[t] || (stats[t] = { runs: 0, name: 0, posts: 0, inside: 0, finds: 0, confirmed: 0, dismissed: 0, last: null }); }
    current.forEach(get);
    p.runs.forEach(function (run, i) {
      Object.keys(run.term_stats || {}).forEach(function (t) {
        var x = run.term_stats[t] || {}; var st = get(t);
        st.runs++; st.name += x.name || 0; st.posts += x.posts || 0; st.inside += x.inside || 0;
        if (i === 0) st.last = (x.name || 0) + (x.posts || 0) + (x.inside || 0);
      });
    });
    p.candidates.forEach(function (c) {
      (Array.isArray(c.matched_terms) ? c.matched_terms : []).forEach(function (t) {
        var st = get(t); st.finds++;
        if (c.status === 'confirmed') st.confirmed++;
        if (c.status === 'dismissed') st.dismissed++;
      });
    });
    var rows = Object.keys(stats).map(function (t) { return [t, stats[t]]; }).sort(function (a, b) {
      return (b[1].confirmed - a[1].confirmed) || (b[1].finds - a[1].finds) || ((b[1].name + b[1].posts + b[1].inside) - (a[1].name + a[1].posts + a[1].inside));
    });
    var last = p.runs[0];
    return '<details class="pir-sig" style="margin-top:18px;" open><summary>Which search terms work</summary>' +
      '<div class="field-hint" style="margin-bottom:8px;">' + p.runs.length + ' scan' + (p.runs.length === 1 ? '' : 's') + ' so far. Last: ' + escapeHtml(fmtIstDateTime(last.ran_at)) + ', ' + (last.candidates || 0) + ' matching channels, ' + (last.post_searches || 0) + ' public post searches used. "Piracy" counts finds you turned into a notice. Terms that find nothing after several scans can go; put the best ones at the top of the list (the first 5 also search all public posts).</div>' +
      '<div class="students-table-wrap"><table class="students-table sitedata-table pir-table"><thead><tr>' +
        '<th>Search term</th><th title="Channels and posts this term returned, all scans">Results</th><th title="Matching channels this term surfaced or matched">Finds</th><th>Piracy</th><th>Not piracy</th><th title="Results in the last scan">Last scan</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        var st = r[1]; var inList = current.indexOf(r[0]) !== -1;
        return '<tr' + (inList ? '' : ' style="opacity:.55"') + '><td>' + escapeHtml(r[0]) + (inList ? '' : ' <span class="field-hint">(removed)</span>') + '</td>' +
          '<td>' + (st.name + st.posts + st.inside) + '</td><td>' + st.finds + '</td><td><b>' + st.confirmed + '</b></td><td>' + st.dismissed + '</td>' +
          '<td>' + (st.last == null ? '–' : st.last) + '</td></tr>';
      }).join('') +
      '</tbody></table></div></details>';
  }

  function bindPiracyFound() {
    var p = state.piracy;
    var ff = document.getElementById('pir-found-filter');
    if (ff) ff.addEventListener('change', function () { p.foundFilter = ff.value; render(); });
    function setStatus(id, status) {
      return api('/team-piracy', { method: 'PATCH', body: JSON.stringify({ id: id, candidate: true, status: status }) }).then(function () {
        p.candidates.forEach(function (c) { if (c.id === id) c.status = status; });
      });
    }
    document.querySelectorAll('.js-pir-found-status').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setStatus(btn.getAttribute('data-id'), btn.getAttribute('data-status')).then(render).catch(function (err) { p.error = err.message; render(); });
      });
    });
    document.querySelectorAll('.js-pir-found-draft').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var c = p.candidates.filter(function (x) { return x.id === btn.getAttribute('data-id'); })[0];
        if (!c) return;
        var sec = pirNewSection();
        sec.name = c.title || '';
        sec.link = c.link;
        sec.subs = c.subscribers ? String(c.subscribers) : '';
        sec.scope = c.kind === 'invite' ? 'suspected' : 'whole';
        sec.messages = (Array.isArray(c.sample_links) ? c.sample_links : []).join('\n');
        sec.nature = (Array.isArray(c.reasons) ? c.reasons : []).join('. ') + '.';
        var blank = p.draft.sections.length === 1 && !p.draft.sections[0].link && !p.draft.sections[0].messages;
        if (blank) p.draft.sections = [sec]; else p.draft.sections.push(sec);
        pirSaveDraft();
        setStatus(c.id, 'confirmed').catch(function () {});
        p.sub = 'notice'; p.msg = 'Added to the notice draft. Check the details and rewrite "Nature of infringement" in your own words.'; render();
      });
    });
    var ts = document.getElementById('pir-terms-save');
    if (ts) ts.addEventListener('click', function () {
      var t = document.getElementById('pir-terms-text').value;
      p.termsSaving = true; p.error = null; render();
      api('/site-settings', { method: 'PUT', body: JSON.stringify({ piracy_terms: t }) }).then(function () {
        p.termsSaving = false; p.terms = t.trim() || null; p.msg = 'Search terms saved.'; render();
      }).catch(function (err) { p.termsSaving = false; p.error = err.message; render(); });
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
      var shown = state.showBuiltIn === null
        ? !state.posts.some(function (p) { return p.source === 'custom'; })
        : state.showBuiltIn;
      state.showBuiltIn = !shown;
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
        if (tab === 'marketing') tab = state.lastMarketing || 'day-card';
        if (tab === state.tab) return;
        state.tab = tab;
        if (tab === 'students' && state.students === null) { loadStudents(); return; }
        if (tab === 'site-data' && ensureSiteDataLoaded(state.siteData.subTab)) return;
        if (tab === 'day-card') { render(); loadDayCardMonth(); loadDayCardTemplate(); return; }
        if (tab === 'offer-poster') { render(); loadOfferPoster(); return; }
        if (tab === 'club-winner') { render(); loadClubWinner(); loadClubRunners(); return; }
        if (tab === 'challenge') { if (!state.challenge.loaded && !state.challenge.loading) { loadChallenge(); return; } render(); return; }
        if (tab === 'piracy') { if (!state.piracy.loaded && !state.piracy.loading) { loadPiracy(); return; } render(); return; }
        if (tab === 'competitors') { if (!state.comp.loaded && !state.comp.loading) { loadCompetitors(); return; } render(); return; }
        render();
      });
    });

    document.querySelectorAll('[data-sitetab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var type = btn.getAttribute('data-sitetab');
        if (type === state.siteData.subTab) return;
        state.siteData.subTab = type;
        state.siteData.editing = null;
        if (ensureSiteDataLoaded(type)) return;
        render();
      });
    });

    document.querySelectorAll('[data-runout-batch]').forEach(function (input) {
      input.addEventListener('change', function () {
        saveScheduleRunoutOff(input.getAttribute('data-runout-batch'), input.getAttribute('data-runout-last'), input.checked);
      });
    });

    var stripSave = document.getElementById('strip-save');
    if (stripSave) stripSave.addEventListener('click', saveTopStrip);
    var stripMode = document.getElementById('strip-mode');
    if (stripMode) stripMode.addEventListener('change', function () {
      var f = document.getElementById('strip-custom-fields'); if (f) f.hidden = stripMode.value !== 'custom';
    });
    var mfltSave = document.getElementById('mflt-save');
    if (mfltSave) mfltSave.addEventListener('click', saveMiniFlt);

    document.querySelectorAll('[data-setting-field]').forEach(function (input) {
      input.addEventListener('change', function () {
        saveSiteSettingsToggle(input.getAttribute('data-setting-field'), input.checked);
      });
    });

    document.querySelectorAll('[data-mktab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.getAttribute('data-mktab');
        if (tab === state.tab) return;
        state.tab = tab; state.lastMarketing = tab;
        if (tab === 'day-card') { render(); loadDayCardMonth(); loadDayCardTemplate(); return; }
        if (tab === 'club-winner') { render(); loadClubWinner(); loadClubRunners(); return; }
        render(); loadOfferPoster();
      });
    });

    var chalSearch = document.getElementById('chal-search');
    if (chalSearch) chalSearch.addEventListener('input', function () {
      var q = chalSearch.value.trim().toLowerCase();
      state.challenge.q = q;
      document.querySelectorAll('tr[data-chal-text]').forEach(function (tr) { tr.hidden = !!q && tr.getAttribute('data-chal-text').indexOf(q) === -1; });
    });
    var chalCsv = document.getElementById('chal-csv');
    if (chalCsv) chalCsv.addEventListener('click', downloadChallengeCsv);
    var chalCopy = document.getElementById('chal-copy-link');
    if (chalCopy) chalCopy.addEventListener('click', function () {
      var url = 'https://taai.live/challenge';
      var done = function () { chalCopy.textContent = 'Copied'; setTimeout(function () { chalCopy.textContent = 'Copy link'; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { window.prompt('Copy this link:', url); });
      else window.prompt('Copy this link:', url);
    });

    var chalCutoffForm = document.getElementById('chal-cutoff-form');
    if (chalCutoffForm) chalCutoffForm.addEventListener('submit', function (e) {
      e.preventDefault();
      saveChallengeCutoff((new FormData(chalCutoffForm).get('cutoff') || '').toString());
    });
    document.querySelectorAll('.js-chal-delete').forEach(function (btn) {
      btn.addEventListener('click', function () { deleteChallengeRow(btn.getAttribute('data-id'), btn.getAttribute('data-name')); });
    });

    var resStatsBtn = document.getElementById('res-stats-refresh');
    if (resStatsBtn) resStatsBtn.addEventListener('click', loadResourceStats);
    var leadsCsv = document.getElementById('res-leads-csv');
    if (leadsCsv) leadsCsv.addEventListener('click', resLeadsCsv);
    document.querySelectorAll('.js-lead-sent').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var email = cb.getAttribute('data-email'), on = cb.checked;
        var L = state.resourceStats.leads, row = L && (L.leads || []).filter(function (r) { return r.email === email; })[0];
        cb.disabled = true;
        api('/team-resource-leads', { method: 'POST', body: JSON.stringify({ email: email, sent: on }) }).then(function () {
          if (row) row.sent_at = on ? new Date().toISOString() : null; render();
        }).catch(function (e) { cb.checked = !on; cb.disabled = false; alert('Could not save: ' + e.message); });
      });
    });

    var lmsCheckBtn = document.getElementById('lms-check-now');
    if (lmsCheckBtn) lmsCheckBtn.addEventListener('click', function () { loadLmsSync(true); });

    document.querySelectorAll('.js-res-add').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var type = state.siteData.subTab;
        var row = Object.assign({}, SITE_DATA_RESOURCES[type].newRow, { subject: btn.getAttribute('data-subject') });
        if (type === 'lectures') {
          // Next lecture number in that subject, so it's one less thing to type.
          var nums = (state.siteData.rows.lectures || []).filter(function (r) { return r.subject === row.subject; })
            .map(function (r) { return Number(r.lecture_number) || 0; });
          row.lecture_number = nums.length ? Math.max.apply(null, nums) + 1 : 1;
        }
        state.siteData.editing = { type: type, row: row };
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
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
    // no library — see bindPricingCardDrag's own comment for how it
    // tracks the intended drop position without touching the DOM until
    // the actual drop, and why. Scoped per data-drag-group ('combo'/
    // 'individual'/'test-series', see renderPricingGroups) so a card
    // can only ever be reordered within its own section, never dragged
    // across into another one.
    bindPricingCardDrag();
    bindPricingDiscountCheck();

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
    var activeFilter = document.getElementById('student-active-filter');
    if (activeFilter) activeFilter.addEventListener('change', function () {
      state.studentFilters.active = activeFilter.value;
      render();
    });
    var hpBtn = document.getElementById('student-hp');
    if (hpBtn) hpBtn.addEventListener('click', function () {
      var on = hpBtn.getAttribute('aria-pressed') === 'true';
      if (on) {
        state.studentFilters = { search: '', inactive: '', active: '', minScore: '', joinedFrom: '', joinedTo: '', rankers: '', minStreak: '', flaggedOnly: false, batch: '' };
        state.studentSort = { key: 'total_minutes', dir: 'desc' };
      } else {
        state.studentFilters = { search: '', inactive: '', active: '', minScore: '', rankers: 'hide', minStreak: '', flaggedOnly: false, batch: 'C' };
        state.studentSort = { key: 'score', dir: 'desc' };
      }
      render();
    });
    var minScoreInput = document.getElementById('student-min-score');
    if (minScoreInput) minScoreInput.addEventListener('input', function () {
      var pos = minScoreInput.selectionStart;
      state.studentFilters.minScore = minScoreInput.value;
      render();
      refocusFilterInput('student-min-score', pos);
    });
    ['student-joined-from', 'student-joined-to'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', function () { state.studentFilters[id === 'student-joined-from' ? 'joinedFrom' : 'joinedTo'] = el.value; render(); });
    });
    var rankersFilter = document.getElementById('student-rankers-filter');
    if (rankersFilter) rankersFilter.addEventListener('change', function () { state.studentFilters.rankers = rankersFilter.value; render(); });
    document.querySelectorAll('.js-rankers').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var email = btn.getAttribute('data-email'), on = btn.getAttribute('data-on') === '1';
        var st = (state.students || []).filter(function (x) { return x.email === email; })[0];
        if (!st) return;
        if (!on && !confirm('Remove ' + st.display_name + ' from the ranker\'s batch?')) return;
        state.rankersSaving = state.rankersSaving || {};
        state.rankersSaving[email] = true; render();
        api('/team-students', { method: 'PATCH', body: JSON.stringify({ email: email, rankers_batch: on }) }).then(function () {
          st.rankers_batch = on; st.rankers_batch_at = on ? new Date().toISOString() : null;
        }).catch(function (err) { alert('Couldn\'t save: ' + err.message); }).then(function () {
          delete state.rankersSaving[email]; render();
        });
      });
    });
    var minStreakInput = document.getElementById('student-min-streak');
    if (minStreakInput) minStreakInput.addEventListener('input', function () {
      var pos = minStreakInput.selectionStart;
      state.studentFilters.minStreak = minStreakInput.value;
      render();
      refocusFilterInput('student-min-streak', pos);
    });
    var flaggedOnlyCheckbox = document.getElementById('student-flagged-only');
    if (flaggedOnlyCheckbox) flaggedOnlyCheckbox.addEventListener('change', function () {
      state.studentFilters.flaggedOnly = flaggedOnlyCheckbox.checked;
      render();
    });
    var filterClearBtn = document.getElementById('student-filter-clear');
    if (filterClearBtn) filterClearBtn.addEventListener('click', function () {
      state.studentFilters = { search: '', inactive: '', active: '', minScore: '', joinedFrom: '', joinedTo: '', rankers: '', minStreak: '', flaggedOnly: false, batch: '' };
      render();
    });

    // Notes save on Enter or when the field loses focus, only if the text changed.
    // Feedback is a border colour on the field itself (see .note-input.is-*), patched
    // in place so a save never re-renders the table under the cursor.
    function saveNote(input) {
      var email = input.getAttribute('data-email');
      var notes = input.value;
      var st = (state.students || []).filter(function (x) { return x.email === email; })[0];
      if (!st || (st.notes || '') === notes) return;
      var mark = function (cls) {
        state.noteSaving[email] = cls;
        input.classList.remove('is-saving', 'is-saved', 'is-error');
        if (cls) input.classList.add('is-' + cls);
      };
      mark('saving');
      api('/team-students', { method: 'PATCH', body: JSON.stringify({ email: email, notes: notes }) })
        .then(function () {
          st.notes = notes; mark('saved');
          setTimeout(function () { if (state.noteSaving[email] === 'saved') mark(''); }, 1800);
        })
        .catch(function () { mark('error'); });
    }
    document.querySelectorAll('.js-note-input').forEach(function (input) {
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
      input.addEventListener('blur', function () { saveNote(input); });
    });
    var batchFilter = document.getElementById('student-batch-filter');
    if (batchFilter) batchFilter.addEventListener('change', function () {
      state.studentFilters.batch = batchFilter.value;
      render();
    });
    var moreBtn = document.getElementById('students-more');
    if (moreBtn) moreBtn.addEventListener('click', function () { state.studentsShown += STUDENTS_PAGE; render(); });
    var allBtn = document.getElementById('students-all');
    if (allBtn) allBtn.addEventListener('click', function () { state.studentsShown = Infinity; render(); });
    var csvBtn = document.getElementById('students-csv');
    if (csvBtn) csvBtn.addEventListener('click', function () {
      var cols = ['display_name', 'email', 'batch', 'created_at', 'last_active', 'days_inactive', 'score', 'due_progress_pct', 'tick_day_pct', 'focus_median_45_minutes', 'longest_streak', 'score_penalty', 'inactive_penalty', 'rankers_batch', 'week_minutes', 'last30_minutes', 'total_minutes', 'consistency_minutes', 'streak', 'progress_pct', 'tasks_completed', 'needs_rename', 'notes'];
      var head = ['Name', 'Email', 'Batch', 'Joined', 'Last active', 'Days inactive', 'Score', 'Progress to date %', 'Days ticked %', 'Usual focus a day, last 45d (min)', 'Longest streak', 'Early-joiner penalty', 'Inactivity penalty', 'In ranker\'s batch', 'This week (min)', 'Last 30 days (min)', 'All-time (min)', 'Consistency (min/day)', 'Streak', 'Course progress %', 'Tasks done', 'Name flagged', 'Notes'];
      var cell = function (v) {
        if (v == null) return '';
        v = String(v);
        if (/^[=+\-@]/.test(v)) v = "'" + v; // keep spreadsheets from running a cell as a formula
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      };
      var lines = [head.join(',')].concat(sortedStudents().map(function (st) {
        return cols.map(function (c) { return cell(c === 'batch' ? (STUDENT_BATCH_LABELS[st.batch] || st.batch) : st[c]); }).join(',');
      }));
      var blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'taai-students-' + new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10) + '.csv'; // IST date
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });

    function clearNameCheckBlock(email, newDisplayName) {
      state.clearBlockStatus[email] = 'saving';
      render();
      api('/team-clear-name-check', { method: 'POST', body: JSON.stringify({ email: email, new_display_name: newDisplayName || undefined }) })
        .then(function (data) {
          delete state.clearBlockStatus[email];
          var s = (state.students || []).filter(function (x) { return x.email === email; })[0];
          if (s) {
            s.gate_escalated = false;
            if (data.student) {
              if (data.student.display_name) s.display_name = data.student.display_name;
              if ('needs_rename' in data.student) s.needs_rename = data.student.needs_rename;
            }
          }
          render();
        })
        .catch(function () { state.clearBlockStatus[email] = 'error'; render(); });
    }

    document.querySelectorAll('.js-clear-block').forEach(function (btn) {
      btn.addEventListener('click', function () {
        clearNameCheckBlock(btn.getAttribute('data-email'), null);
      });
    });

    document.querySelectorAll('.js-clear-rename').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var email = btn.getAttribute('data-email');
        var input = document.querySelector('.js-clear-rename-input[data-email="' + email + '"]');
        var newName = input ? input.value.trim() : '';
        clearNameCheckBlock(email, newName);
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
    var locked = form.getAttribute('data-locked-content') === '1';
    var e = state.editing || {};
    var payload = {
      source: fd.get('source') || 'custom',
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
    if (locked) {
      // Content isn't in the form for built-in posts (see renderForm), so
      // carry the stored values through unchanged.
      payload.source = e.source;
      payload.title = e.title || '';
      payload.body = e.body || '';
      payload.color = e.color;
      payload.sections = e.sections || null;
    }
    return payload;
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
