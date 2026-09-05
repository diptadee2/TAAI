// GET    /api/team-posts                     -> list every scheduled post
// POST   /api/team-posts   { ... }            -> create one
// POST   /api/team-posts?preview=1   { ... }  -> resolve (but don't save or post) what this would send to Discord
// POST   /api/team-posts?test=1   { ..., test_webhook_url }  -> actually post this to test_webhook_url, on demand
// PUT    /api/team-posts   { id, ... }        -> update one (recomputes next_fire_at)
// DELETE /api/team-posts?id=...               -> remove one
//
// Backs /team — role-gated (see requireAdmin in lib/supabase.js) create/
// edit/delete for scheduled_posts, the table discord-dispatch.js actually
// fires from. This is the only place these rows are ever written; the
// dispatcher only reads and updates timing fields on them.
//
// preview and test both reuse resolveScheduledPostEmbed/
// resolveScheduledPostText/buildMentionContent — the exact same content-
// resolution logic discord-dispatch.js uses for a real firing — against
// an in-memory object built from the form's current (possibly unsaved)
// values, so what's shown/sent is genuinely what a real firing would
// produce, not a hand-maintained approximation that could quietly drift
// out of sync. The only difference between them: preview never touches
// Discord/Telegram at all, test actually posts (to test_webhook_url +,
// for Telegram, telegram_test_chat_id — never the row's own saved
// destination) so you can see the real rendered message in an actual
// client, not this page's approximation.
import { getSupabase, json, requireAdmin, computeNextFireAt, resolveScheduledPostEmbed, resolveScheduledPostText, buildMentionContent, postToDiscordWebhook, postToTelegram } from './lib/supabase.js';

const VALID_SOURCES = ['custom', 'daily_leader', 'daily_leaderboard', 'weekly_leaderboard', 'monthly_consistency'];
const VALID_SCHEDULE_TYPES = ['once', 'daily', 'weekly', 'monthly'];
const VALID_PLATFORMS = ['discord', 'telegram'];

// Normalizes the optional 'sections' field (only meaningful for
// source: 'custom' — see resolveScheduledPostEmbed) — a subject label
// plus real day-rows (date/task/time), merged with every other section's
// rows into one date-grouped list when the post is actually resolved.
// Not tied to Discord's 10-embeds-per-message limit anymore (everything
// renders into the one main embed now, not one embed per section) —
// the cap here is just basic sanity, not a hard platform constraint.
function sanitizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(r => r && typeof r === 'object')
    .map(r => ({
      date: typeof r.date === 'string' ? r.date.trim() : '',
      task: typeof r.task === 'string' ? r.task.trim() : '',
      time: typeof r.time === 'string' ? r.time.trim() : '',
    }))
    .filter(r => r.date && r.task)
    .slice(0, 60);
}
function sanitizeSections(sections) {
  if (!Array.isArray(sections)) return null;
  const cleaned = sections
    .filter(s => s && typeof s === 'object')
    .map(s => ({
      title: typeof s.title === 'string' ? s.title.trim() || null : null,
      rows: sanitizeRows(s.rows),
    }))
    .filter(s => s.title || s.rows.length)
    .slice(0, 20);
  return cleaned.length ? cleaned : null;
}

function validateSchedule(body) {
  if (!VALID_SCHEDULE_TYPES.includes(body.schedule_type)) return 'invalid schedule_type';
  if (!/^\d{2}:\d{2}$/.test(body.schedule_time || '')) return 'schedule_time must be HH:MM';
  if (body.schedule_type === 'once' && !body.schedule_date) return 'schedule_date is required for a one-time post';
  if (body.schedule_type === 'weekly' && !Number.isInteger(body.schedule_day_of_week)) return 'schedule_day_of_week is required for a weekly post';
  if (body.schedule_type === 'monthly' && !Number.isInteger(body.schedule_day_of_month)) return 'schedule_day_of_month is required for a monthly post';
  return null;
}

// webhook_url doubles as "the endpoint/credential to POST to" for both
// platforms (a Discord webhook URL, or a Telegram bot's API base with its
// token embedded — see resolveScheduledPostText/postToTelegram) — always
// required regardless of platform. telegram_chat_id is the one genuinely
// platform-specific requirement: a Telegram bot's API base alone doesn't
// encode which chat to post to the way a Discord webhook already does.
function validatePlatformFields(body) {
  if (!body.webhook_url) return 'webhook_url is required';
  if (body.platform === 'telegram' && !body.telegram_chat_id) return 'telegram_chat_id is required for a Telegram post';
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
    const platform = VALID_PLATFORMS.includes(body.platform) ? body.platform : 'discord';

    try {
      // Not a real row — never inserted, id/webhook_url/schedule fields
      // are irrelevant to what gets posted, only source/title/body/color/
      // mention fields actually feed into the preview.
      const tempRow = {
        source: body.source,
        title: body.title || null,
        body: body.body || null,
        color: Number.isFinite(body.color) ? body.color : null,
        tag_everyone: !!body.tag_everyone,
        extra_mentions: body.extra_mentions || null,
        sections: sanitizeSections(body.sections),
      };
      if (platform === 'telegram') {
        const text = await resolveScheduledPostText(supabase, tempRow);
        if (!text) return json(200, { platform, text: null, reason: 'No data yet for this source/period — nothing would post right now.' });
        return json(200, { platform, text });
      }
      const embeds = await resolveScheduledPostEmbed(supabase, tempRow);
      const content = buildMentionContent(tempRow);
      if (!embeds) return json(200, { platform, embeds: null, content: content || null, reason: 'No data yet for this source/period — nothing would post right now.' });
      return json(200, { platform, embeds, content: content || null });
    } catch (err) {
      return json(400, { error: err.message });
    }
  }

  if (event.httpMethod === 'POST' && event.queryStringParameters?.test === '1') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
    if (!VALID_SOURCES.includes(body.source)) return json(400, { error: 'invalid source' });
    const platform = VALID_PLATFORMS.includes(body.platform) ? body.platform : 'discord';
    // Telegram's test bot API URL may fall back to the row's real one —
    // unlike a Discord webhook URL (which IS the destination), a
    // Telegram bot's API URL is only a credential; telegram_test_chat_id
    // is what actually decides where the message lands, and that's
    // always required with no fallback, same "never the row's real
    // destination" discipline Discord's Send Test already has.
    const testBotUrl = platform === 'telegram' ? (body.test_webhook_url || body.webhook_url) : body.test_webhook_url;
    if (!testBotUrl) return json(400, { error: platform === 'telegram' ? 'a bot API URL is required (fill in either Bot API URL or Test bot API URL)' : 'test_webhook_url is required' });
    if (platform === 'telegram' && !body.telegram_test_chat_id) return json(400, { error: 'telegram_test_chat_id is required' });

    try {
      const tempRow = {
        source: body.source,
        title: body.title || null,
        body: body.body || null,
        color: Number.isFinite(body.color) ? body.color : null,
        tag_everyone: !!body.tag_everyone,
        extra_mentions: body.extra_mentions || null,
        sections: sanitizeSections(body.sections),
      };
      // Always the test destination, never the row's real one — a real
      // production post is only ever sent by discord-dispatch.js on its
      // own schedule.
      if (platform === 'telegram') {
        const text = await resolveScheduledPostText(supabase, tempRow);
        if (!text) return json(200, { posted: false, reason: 'No data yet for this source/period — nothing to send.' });
        await postToTelegram(text, body.telegram_test_chat_id, testBotUrl);
        return json(200, { posted: true });
      }
      const embeds = await resolveScheduledPostEmbed(supabase, tempRow);
      if (!embeds) return json(200, { posted: false, reason: 'No data yet for this source/period — nothing to send.' });
      await postToDiscordWebhook(embeds, buildMentionContent(tempRow), body.test_webhook_url);
      return json(200, { posted: true });
    } catch (err) {
      return json(400, { error: err.message });
    }
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

    if (!VALID_SOURCES.includes(body.source)) return json(400, { error: 'invalid source' });
    const platform = VALID_PLATFORMS.includes(body.platform) ? body.platform : 'discord';
    const platformError = validatePlatformFields(body);
    if (platformError) return json(400, { error: platformError });
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
      platform,
      webhook_url: body.webhook_url,
      channel_name: body.channel_name || null,
      test_webhook_url: body.test_webhook_url || null,
      telegram_chat_id: platform === 'telegram' ? body.telegram_chat_id : null,
      telegram_test_chat_id: platform === 'telegram' ? (body.telegram_test_chat_id || null) : null,
      title: body.title || null,
      body: body.body || null,
      tag_everyone: !!body.tag_everyone,
      extra_mentions: body.extra_mentions || null,
      color: Number.isFinite(body.color) ? body.color : null,
      sections: sanitizeSections(body.sections),
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
    const platform = VALID_PLATFORMS.includes(body.platform) ? body.platform : 'discord';
    const platformError = validatePlatformFields(body);
    if (platformError) return json(400, { error: platformError });
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
      platform,
      webhook_url: body.webhook_url,
      channel_name: body.channel_name || null,
      test_webhook_url: body.test_webhook_url || null,
      telegram_chat_id: platform === 'telegram' ? body.telegram_chat_id : null,
      telegram_test_chat_id: platform === 'telegram' ? (body.telegram_test_chat_id || null) : null,
      title: body.title || null,
      body: body.body || null,
      tag_everyone: !!body.tag_everyone,
      extra_mentions: body.extra_mentions || null,
      color: Number.isFinite(body.color) ? body.color : null,
      sections: sanitizeSections(body.sections),
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
