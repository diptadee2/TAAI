// Scheduled function (see netlify.toml) — posts the previous month's most
// consistent student on the 1st of each month, 12:00 PM IST. Also directly
// callable via GET for local testing (`netlify dev` doesn't need a real
// cron trigger to invoke a scheduled function).
//
// "Consistent" means median daily focus minutes across every day of the
// month (zero-filled, not just active days) — see computeMonthlyConsistency
// in lib/supabase.js for why median beats a raw average here, and why only
// students registered by the 7th of that month are eligible.
import { getSupabase, json, previousMonthIST, computeMonthlyConsistency, postToDiscordWebhook } from './lib/supabase.js';

const MEDALS = ['🥇', '🥈', '🥉'];
const TRACKER_URL = 'https://taai.live/gate-da-progress-tracker';

function formatHoursDecimal(minutes) {
  return (minutes / 60).toFixed(1) + 'h';
}

function monthLabel(month) {
  return new Date(month + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export async function handler() {
  const supabase = getSupabase();
  const month = previousMonthIST();

  const { top } = await computeMonthlyConsistency(supabase, month);
  // No eligible students (or nobody logged anything) — silently no-op,
  // same "render nothing until there's real data" pattern the other
  // Discord posts and leaderboard cards already use.
  if (!top.length) return json(200, { posted: false, reason: 'no eligible students for ' + month });

  const label = monthLabel(month);
  const winner = top[0];
  const runnersUp = top.slice(1).map((s, i) =>
    `${MEDALS[i + 1] || (i + 2) + '.'} **${s.display_name}** — ${formatHoursDecimal(s.medianMinutes)} typical day`
  );

  const description =
    `**${winner.display_name}** was the most consistent student this month — a **typical day of ${formatHoursDecimal(winner.medianMinutes)}** of focused study, day after day, all month long.\n\n` +
    `*How this is measured:* we look at every day of the month, including the quiet ones, and find your "typical" day — not your best day, not your worst, just what a normal day looked like for you. Someone who shows up a little every day beats someone who crams once and disappears for the rest of the month, even if their total hours end up about the same.` +
    (runnersUp.length ? `\n\n${runnersUp.join('\n')}` : '') +
    `\n\n[📊 View the progress tracker](${TRACKER_URL})`;

  await postToDiscordWebhook({
    title: `🏅 Most Consistent Student — ${label}`,
    url: TRACKER_URL,
    description,
    color: 0xf59e0b, // amber, matches the site's #1 medal color
    footer: { text: label },
  }, '@everyone');

  return json(200, { posted: true, month, top: top.map(s => ({ name: s.display_name, medianMinutes: s.medianMinutes, totalMinutes: s.totalMinutes })) });
}
