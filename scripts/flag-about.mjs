// Team moderation for an About that got past the Claude check.
//   node --env-file=.env scripts/flag-about.mjs student@example.com
// 1st flag:  removes the About; the student may set a new one right away
//            (about_reset_allowed), even if this week's change was used.
// 2nd+ flag: (they circumvented with another bad one) removes it and blocks
//            setting any About for two weeks (about_banned_until).
// Enforced in netlify/functions/set-about.js. The student always stays on
// the leaderboards; only the About is affected.
import { getSupabase } from '../netlify/functions/lib/supabase.js';

const BAN_DAYS = 14;
const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('usage: node --env-file=.env scripts/flag-about.mjs <email>');
  process.exit(1);
}

const sb = getSupabase();
const { data: s, error: readErr } = await sb
  .from('students')
  .select('email, display_name, about_text, about_flag_count')
  .eq('email', email)
  .maybeSingle();
if (readErr) { console.error(readErr.message); process.exit(1); }
if (!s) { console.error('no student with that email'); process.exit(1); }

const count = (s.about_flag_count || 0) + 1;
const patch = count === 1
  ? { about_text: null, about_flag_count: count, about_reset_allowed: true, about_banned_until: null }
  : { about_text: null, about_flag_count: count, about_reset_allowed: false, about_banned_until: new Date(Date.now() + BAN_DAYS * 86400000).toISOString() };
const { data: after, error } = await sb.from('students').update(patch).eq('email', email)
  .select('display_name, about_flag_count, about_reset_allowed, about_banned_until');
if (error) { console.error(error.message); process.exit(1); }

console.log('student      :', after[0].display_name, '<' + email + '>');
console.log('removed About:', JSON.stringify(s.about_text));
console.log('flag count   :', after[0].about_flag_count);
console.log(count === 1
  ? 'outcome      : first flag, they may set a new About now'
  : 'outcome      : repeat flag, banned until ' + after[0].about_banned_until + ' (' + BAN_DAYS + ' days)');
