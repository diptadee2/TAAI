// Scheduled function (see netlify.toml) — runs every 15 minutes and fires
// any scheduled_posts row that's due (enabled AND next_fire_at <= now()).
// See computeNextFireAt in lib/supabase.js for why this exists: Netlify
// Scheduled Functions run on a cron baked in at deploy time, so a
// user-editable schedule (managed via /team) can't map to "one cron per
// post" — this single, fixed-cadence dispatcher is what makes that work
// instead. Also directly callable via GET for local testing (`netlify
// dev` doesn't need a real cron trigger to invoke a scheduled function).
//
// Content resolution (resolveScheduledPostEmbed) lives in lib/supabase.js,
// shared with team-posts.js's preview endpoint — so a preview always shows
// exactly what a real firing would post, never a separate approximation.
import { getSupabase, json, computeNextFireAt, resolveScheduledPostEmbed, buildMentionContent, postToDiscordWebhook } from './lib/supabase.js';

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
      const embeds = await resolveScheduledPostEmbed(supabase, row);
      if (embeds) {
        await postToDiscordWebhook(embeds, buildMentionContent(row), row.webhook_url);
      }

      const updates = { last_fired_at: now.toISOString() };
      if (row.schedule_type === 'once') {
        updates.enabled = false;
      } else {
        updates.next_fire_at = computeNextFireAt(row, now).toISOString();
      }
      const { error: updateError } = await supabase.from('scheduled_posts').update(updates).eq('id', row.id);
      if (updateError) throw new Error(updateError.message);

      results.push({ id: row.id, source: row.source, posted: !!embeds });
    } catch (err) {
      results.push({ id: row.id, source: row.source, error: err.message });
    }
  }

  return json(200, { checked: due.length, results });
}
