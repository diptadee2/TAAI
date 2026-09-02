// Scheduled function (see netlify.toml) — runs every 15 minutes and fires
// any scheduled_posts row that's due (enabled AND next_fire_at <= now()).
// See computeNextFireAt in lib/supabase.js for why this exists: Netlify
// Scheduled Functions run on a cron baked in at deploy time, so a
// user-editable schedule (managed via /team) can't map to "one cron per
// post" — this single, fixed-cadence dispatcher is what makes that work
// instead. Also directly callable via GET for local testing (`netlify
// dev` doesn't need a real cron trigger to invoke a scheduled function).
import {
  getSupabase, json, renderTemplate, computeNextFireAt,
  fetchTodayLeaders, fetchLastWeekLeaders, computeMonthlyConsistency,
  yesterdayIST, previousMonthIST, postToDiscordWebhook,
} from './lib/supabase.js';

const MEDALS = ['🥇', '🥈', '🥉'];
const TRACKER_URL = 'https://taai.live/gate-da-progress-tracker';

function formatHoursDecimal(minutes) {
  return (minutes / 60).toFixed(1) + 'h';
}

function monthLabel(month) {
  return new Date(month + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Resolves one row into a Discord embed — pulling live data for a
// built-in source (with the row's title/body used as an override
// template, {{name}}/{{hours}} placeholders, falling back to the
// original hardcoded defaults if blank) or using the row's literal
// title/body as-is for 'custom'. Returns null when there's genuinely
// nothing to post yet (no data for that day/week/month) — same silent
// no-op pattern the original standalone functions used, so an empty
// period never produces an awkward "nobody studied" message.
async function resolveEmbed(supabase, row) {
  if (row.source === 'custom') {
    return {
      title: row.title || undefined,
      description: row.body || '',
      color: row.color ?? 0x8b5cf6,
    };
  }

  if (row.source === 'daily_leader') {
    const date = yesterdayIST();
    const { leaders } = await fetchTodayLeaders(supabase, null, date);
    if (!leaders.length) return null;
    const top = leaders[0];
    const text = renderTemplate(
      row.body || '**{{name}}** logged the most focus time yesterday — **{{hours}}**!',
      { name: top.display_name, hours: formatHoursDecimal(top.total_minutes) }
    );
    return {
      title: row.title || '🏆 Yesterday\'s Top Focus Session',
      url: TRACKER_URL,
      description: `${text}\n\n[📊 View the progress tracker](${TRACKER_URL})`,
      color: row.color ?? 0xf59e0b,
      footer: { text: date },
    };
  }

  if (row.source === 'daily_leaderboard') {
    const date = yesterdayIST();
    const { leaders } = await fetchTodayLeaders(supabase, null, date);
    if (!leaders.length) return null;
    const top3 = leaders.slice(0, 3);
    const lines = top3.map((l, i) =>
      `${MEDALS[i] || (i + 1) + '.'} **${l.display_name}** — ${formatHoursDecimal(l.total_minutes)}`
    );
    return {
      title: row.title || '🏆 Yesterday\'s Top 3',
      url: TRACKER_URL,
      description: lines.join('\n') + `\n\n[📊 View the progress tracker](${TRACKER_URL})`,
      color: row.color ?? 0xf59e0b,
      footer: { text: date },
    };
  }

  if (row.source === 'weekly_leaderboard') {
    const { weekStart, leaders } = await fetchLastWeekLeaders(supabase, null);
    if (!leaders.length) return null;
    const lines = leaders.map((l, i) =>
      `${MEDALS[i] || (i + 1) + '.'} **${l.display_name}** — ${formatHoursDecimal(l.total_minutes)}`
    );
    return {
      title: row.title || '📅 Weekly Top 5 Leaderboard',
      url: TRACKER_URL,
      description: lines.join('\n') + `\n\n[📊 View the progress tracker](${TRACKER_URL})`,
      color: row.color ?? 0x8b5cf6,
      footer: { text: 'Week of ' + weekStart },
    };
  }

  if (row.source === 'monthly_consistency') {
    const month = previousMonthIST();
    const { top } = await computeMonthlyConsistency(supabase, month);
    if (!top.length) return null;
    const label = monthLabel(month);
    const winner = top[0];
    const runnersUp = top.slice(1).map((s, i) =>
      `${MEDALS[i + 1] || (i + 2) + '.'} **${s.display_name}** — ${formatHoursDecimal(s.medianMinutes)} typical day`
    );
    const winnerText = renderTemplate(
      row.body || '**{{name}}** was the most consistent student this month — a **typical day of {{hours}}** of focused study, day after day, all month long.',
      { name: winner.display_name, hours: formatHoursDecimal(winner.medianMinutes) }
    );
    const description =
      `${winnerText}\n\n` +
      '*How this is measured:* we look at every day of the month, including the quiet ones, and find your "typical" day — not your best day, not your worst, just what a normal day looked like for you. Someone who shows up a little every day beats someone who crams once and disappears for the rest of the month, even if their total hours end up about the same.' +
      (runnersUp.length ? `\n\n${runnersUp.join('\n')}` : '') +
      `\n\n[📊 View the progress tracker](${TRACKER_URL})`;
    return {
      title: row.title || `🏅 Most Consistent Student — ${label}`,
      url: TRACKER_URL,
      description,
      color: row.color ?? 0xf59e0b,
      footer: { text: label },
    };
  }

  throw new Error('unknown source: ' + row.source);
}

export async function handler() {
  const supabase = getSupabase();
  const now = new Date();

  const { data: due, error: dueError } = await supabase
    .from('scheduled_posts')
    .select('*')
    .eq('enabled', true)
    .lte('next_fire_at', now.toISOString());
  if (dueError) return json(500, { error: dueError.message });

  // Each row is processed independently — one row's failure (a bad
  // webhook URL, a source with no data) shouldn't stop the rest of the
  // due posts from firing, or leave the whole batch's next_fire_at stuck
  // un-advanced.
  const results = [];
  for (const row of due) {
    try {
      const embed = await resolveEmbed(supabase, row);
      if (embed) {
        await postToDiscordWebhook(embed, row.tag_everyone ? '@everyone' : undefined, row.webhook_url);
      }

      const updates = { last_fired_at: now.toISOString() };
      if (row.schedule_type === 'once') {
        updates.enabled = false;
      } else {
        updates.next_fire_at = computeNextFireAt(row, now).toISOString();
      }
      const { error: updateError } = await supabase.from('scheduled_posts').update(updates).eq('id', row.id);
      if (updateError) throw new Error(updateError.message);

      results.push({ id: row.id, source: row.source, posted: !!embed });
    } catch (err) {
      results.push({ id: row.id, source: row.source, error: err.message });
    }
  }

  return json(200, { checked: due.length, results });
}
