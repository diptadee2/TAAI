// Scheduled function (see netlify.toml) — posts yesterday's top focus
// student to Discord every morning at 8 AM IST. Also directly callable via
// GET for local testing (`netlify dev` doesn't need a real cron trigger to
// invoke a scheduled function).
import { getSupabase, json, yesterdayIST, fetchTodayLeaders, postToDiscordWebhook } from './lib/supabase.js';

const TRACKER_URL = 'https://taai.live/gate-da-progress-tracker';

function formatHoursDecimal(minutes) {
  return (minutes / 60).toFixed(1) + 'h';
}

export async function handler() {
  const supabase = getSupabase();
  const date = yesterdayIST();

  const { leaders } = await fetchTodayLeaders(supabase, null, date);
  // Nobody logged any time that day — silently no-op rather than posting
  // an awkward "nobody studied" message, same "render nothing until
  // there's real data" pattern the leaderboard cards themselves use.
  if (!leaders.length) return json(200, { posted: false, reason: 'no data for ' + date });

  const top = leaders[0];
  await postToDiscordWebhook({
    title: '🏆 Yesterday\'s Top Focus Session',
    url: TRACKER_URL,
    description: `**${top.display_name}** logged the most focus time yesterday — **${formatHoursDecimal(top.total_minutes)}**!`,
    color: 0xf59e0b, // amber, matches the site's #1 medal color
    footer: { text: date },
  });

  return json(200, { posted: true, date, top: top.display_name, minutes: top.total_minutes });
}
