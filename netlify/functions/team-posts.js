// GET    /api/team-posts                     -> list every scheduled post
// POST   /api/team-posts   { ... }            -> create one
// POST   /api/team-posts?preview=1   { ... }  -> resolve (but don't save or post) what this would send to Discord
// PUT    /api/team-posts   { id, ... }        -> update one (recomputes next_fire_at)
// DELETE /api/team-posts?id=...               -> remove one
//
// Backs /team — role-gated (see requireAdmin in lib/supabase.js) create/
// edit/delete for scheduled_posts, the table discord-dispatch.js actually
// fires from. This is the only place these rows are ever written; the
// dispatcher only reads and updates timing fields on them.
//
// preview reuses resolveScheduledPostEmbed — the exact same content-
// resolution logic discord-dispatch.js uses for a real firing — against
// an in-memory object built from the form's current (possibly unsaved)
// values, so what's shown is genuinely what would post, not a
// hand-maintained approximation that could quietly drift out of sync.
import { getSupabase, json, requireAdmin, computeNextFireAt, resolveScheduledPostEmbed } from './lib/supabase.js';

const VALID_SOURCES = ['custom', 'daily_leader', 'daily_leaderboard', 'weekly_leaderboard', 'monthly_consistency'];
const VALID_SCHEDULE_TYPES = ['once', 'daily', 'weekly', 'monthly'];

function validateSchedule(body) {
  if (!VALID_SCHEDULE_TYPES.includes(body.schedule_type)) return 'invalid schedule_type';
  if (!/^\d{2}:\d{2}$/.test(body.schedule_time || '')) return 'schedule_time must be HH:MM';
  if (body.schedule_type === 'once' && !body.schedule_date) return 'schedule_date is required for a one-time post';
  if (body.schedule_type === 'weekly' && !Number.isInteger(body.schedule_day_of_week)) return 'schedule_day_of_week is required for a weekly post';
  if (body.schedule_type === 'monthly' && !Number.isInteger(body.schedule_day_of_month)) return 'schedule_day_of_month is required for a monthly post';
  return null;
}

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;

  const supabase = getSupabase();

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase
      .from('scheduled_posts')
      .select('*')
      .order('next_fire_at', { ascending: true, nullsFirst: false });
    if (error) return json(500, { error: error.message });
    return json(200, { posts: data });
  }

  if (event.httpMethod === 'POST' && event.queryStringParameters?.preview === '1') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
    if (!VALID_SOURCES.includes(body.source)) return json(400, { error: 'invalid source' });

    try {
      // Not a real row — never inserted, id/webhook_url/schedule fields
      // are irrelevant to what gets posted, only source/title/body/color
      // actually feed into the embed.
      const embed = await resolveScheduledPostEmbed(supabase, {
        source: body.source,
        title: body.title || null,
        body: body.body || null,
        color: Number.isFinite(body.color) ? body.color : null,
      });
      if (!embed) return json(200, { embed: null, reason: 'No data yet for this source/period — nothing would post right now.' });
      return json(200, { embed });
    } catch (err) {
      return json(400, { error: err.message });
    }
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

    if (!body.webhook_url) return json(400, { error: 'webhook_url is required' });
    if (!VALID_SOURCES.includes(body.source)) return json(400, { error: 'invalid source' });
    const scheduleError = validateSchedule(body);
    if (scheduleError) return json(400, { error: scheduleError });

    let nextFireAt;
    try {
      nextFireAt = computeNextFireAt(body);
    } catch (err) {
      return json(400, { error: err.message });
    }

    const row = {
      source: body.source,
      webhook_url: body.webhook_url,
      channel_name: body.channel_name || null,
      title: body.title || null,
      body: body.body || null,
      tag_everyone: !!body.tag_everyone,
      color: Number.isFinite(body.color) ? body.color : null,
      schedule_type: body.schedule_type,
      schedule_time: body.schedule_time,
      schedule_date: body.schedule_date || null,
      schedule_day_of_week: Number.isInteger(body.schedule_day_of_week) ? body.schedule_day_of_week : null,
      schedule_day_of_month: Number.isInteger(body.schedule_day_of_month) ? body.schedule_day_of_month : null,
      next_fire_at: nextFireAt.toISOString(),
      enabled: body.enabled !== false,
    };

    const { data, error } = await supabase.from('scheduled_posts').insert(row).select().maybeSingle();
    if (error) return json(500, { error: error.message });
    return json(200, { post: data });
  }

  if (event.httpMethod === 'PUT') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
    if (!body.id) return json(400, { error: 'id is required' });
    if (!VALID_SOURCES.includes(body.source)) return json(400, { error: 'invalid source' });
    const scheduleError = validateSchedule(body);
    if (scheduleError) return json(400, { error: scheduleError });

    let nextFireAt;
    try {
      nextFireAt = computeNextFireAt(body);
    } catch (err) {
      return json(400, { error: err.message });
    }

    const row = {
      source: body.source,
      webhook_url: body.webhook_url,
      channel_name: body.channel_name || null,
      title: body.title || null,
      body: body.body || null,
      tag_everyone: !!body.tag_everyone,
      color: Number.isFinite(body.color) ? body.color : null,
      schedule_type: body.schedule_type,
      schedule_time: body.schedule_time,
      schedule_date: body.schedule_date || null,
      schedule_day_of_week: Number.isInteger(body.schedule_day_of_week) ? body.schedule_day_of_week : null,
      schedule_day_of_month: Number.isInteger(body.schedule_day_of_month) ? body.schedule_day_of_month : null,
      next_fire_at: nextFireAt.toISOString(),
      enabled: body.enabled !== false,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from('scheduled_posts').update(row).eq('id', body.id).select().maybeSingle();
    if (error) return json(500, { error: error.message });
    if (!data) return json(404, { error: 'not found' });
    return json(200, { post: data });
  }

  if (event.httpMethod === 'DELETE') {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: 'id is required' });
    const { error } = await supabase.from('scheduled_posts').delete().eq('id', id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  return json(405, { error: 'method not allowed' });
}
