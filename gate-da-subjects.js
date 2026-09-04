// The single source of truth for GATE DA's subject list/order — every
// page that needs this list loads this file via a plain <script> tag
// before its own script (see gate-da-progress-tracker.html, team/index.html)
// and reads window.GATE_DA_SUBJECTS, rather than keeping its own copy that
// could quietly drift out of sync with the others. Plain names only (no
// emoji, no styling) — these must match schedule_tasks.subject exactly,
// since progress.js matches against real schedule data by this exact
// string. Anything presentation-specific (an emoji per subject, say) is
// each consumer's own concern, layered on top of this list locally.
window.GATE_DA_SUBJECTS = [
  'Linear Algebra', 'Probability', 'Statistics', 'Calculus',
  'Machine Learning', 'AI', 'DBMS', 'Python', 'Data Structures', 'Algorithms',
];
