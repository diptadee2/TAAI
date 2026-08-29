// Scheduled function (see netlify.toml) — posts yesterday's top focus
// student to Discord every morning at 8 AM IST. Also directly callable via
// GET for local testing (`netlify dev` doesn't need a real cron trigger to
// invoke a scheduled function).
import { getSupabase, json, yesterdayIST, fetchTodayLeaders, postToDiscordWebhook, renderTemplate } from './lib/supabase.js';

const TRACKER_URL = 'https://taai.live/gate-da-progress-tracker';

// Wording is overridable via Netlify dashboard env vars (DISCORD_DAILY_TITLE,
// DISCORD_DAILY_TEXT) so it can be edited without a code deploy. DISCORD_DAILY_TEXT
// supports {{name}} and {{hours}} placeholders — see renderTemplate in lib/supabase.js.
const DEFAULT_TITLE = '🏆 Yesterday\'s Top Focus Session';
const DEFAULT_TEXT = '**{{name}}** logged the most focus time yesterday — **{{hours}}**!';

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
  const title = process.env.DISCORD_DAILY_TITLE || DEFAULT_TITLE;
  const text = renderTemplate(process.env.DISCORD_DAILY_TEXT || DEFAULT_TEXT, {
    name: top.display_name,
    hours: formatHoursDecimal(top.total_minutes),
  });
  await postToDiscordWebhook({
    title,
    url: TRACKER_URL,
    description: `${text}\n\n[📊 View the progress tracker](${TRACKER_URL})`,
    color: 0xf59e0b, // amber, matches the site's #1 medal color
    footer: { text: date },
  });

  return json(200, { posted: true, date, top: top.display_name, minutes: top.total_minutes });
}
