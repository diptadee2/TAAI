// Scheduled function (see netlify.toml) — posts last week's top 5 to
// Discord every Monday at 8 AM IST. Also directly callable via GET for
// local testing (`netlify dev` doesn't need a real cron trigger to invoke
// a scheduled function).
import { getSupabase, json, fetchLastWeekLeaders, postToDiscordWebhook } from './lib/supabase.js';

const MEDALS = ['🥇', '🥈', '🥉'];
const TRACKER_URL = 'https://taai.live/gate-da-progress-tracker';

function formatHoursDecimal(minutes) {
  return (minutes / 60).toFixed(1) + 'h';
}

export async function handler() {
  const supabase = getSupabase();

  // email=null — a public Discord post has no "viewer" to flag with is_me.
  const { weekStart, leaders } = await fetchLastWeekLeaders(supabase, null);
  // Nobody logged any time last week — silently no-op rather than posting
  // an empty leaderboard, same "render nothing until there's real data"
  // pattern the champions card itself uses.
  if (!leaders.length) return json(200, { posted: false, reason: 'no data for week of ' + weekStart });

  const lines = leaders.map((l, i) =>
    `${MEDALS[i] || (i + 1) + '.'} **${l.display_name}** — ${formatHoursDecimal(l.total_minutes)}`
  );

  await postToDiscordWebhook({
    title: '📅 Weekly Top 5 Leaderboard',
    url: TRACKER_URL,
    description: lines.join('\n'),
    color: 0x8b5cf6, // purple, matches the site's brand accent
    footer: { text: 'Week of ' + weekStart },
  });

  return json(200, { posted: true, weekStart, leaders: leaders.map(l => ({ name: l.display_name, minutes: l.total_minutes })) });
}
