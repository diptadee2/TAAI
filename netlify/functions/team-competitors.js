// /team > Competitors (2026-11-24). Admin only.
// GET  /api/team-competitors -> { channels, stats, videos, lastRun, keyReady, ready }
//        stats: yt_channel_stats rows of the last 35 days; videos: published
//        in the last 30 days (see lib/yt-monitor.js for what is recorded).
// GET  /api/team-competitors?video=<id> -> { history: [{taken_at, views, likes, comments}] }
// GET  /api/team-competitors?season=1 -> { videos: [[channel_id, kind, published_at, views, title, video_id]], channels, lastBackfill, keyReady }
//        every stored video at least 30 days old ("Through the year")
// POST {action:'backfill'}                 -> loads the last 12 months of uploads in the background
// GET  /api/team-competitors?market=1 -> { market, tracked, keyReady } (whole GATE CSE/DA YouTube market, lib/yt-market.js)
// POST {action:'market'}                   -> scans the market now, in the background
// GET  /api/team-competitors?ideas=<1|3|7|30> -> { ideas } (last saved video ideas for that period)
// POST {action:'ideas', days}              -> starts new video ideas in the background ({started, at})
// POST {action:'refresh'}                  -> starts a run in the background ({started, at})
// POST {action:'add', input, label}        -> adds a channel (link, @handle or UC id)
// POST {action:'remove'|'restore', channel_id} -> stop / restart monitoring (data kept)
import { getSupabase, json, requireAdmin } from './lib/supabase.js';
import { resolveChannel, ytKey, YT_TRACK_DAYS } from './lib/yt-monitor.js';
import { startCompetitorsRefresh } from './competitors-refresh-background.js';
import { readVideoIdeas } from './lib/video-ideas.js';
import { readYtMarket } from './lib/yt-market.js';

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;
  const s = getSupabase();

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q.ideas) return json(200, { ideas: await readVideoIdeas(s, Number(q.ideas)) });
    if (q.market) {
      const { data: tracked } = await s.from('yt_channels').select('channel_id');
      return json(200, { keyReady: !!ytKey(), tracked: (tracked || []).map(c => c.channel_id), market: await readYtMarket(s) });
    }
    // "Through the year" (2026-11-25): every video old enough to have settled
    // (30+ days), as compact rows; the page groups them by month and topic.
    if (q.season) {
      const { data: channels, error } = await s.from('yt_channels').select('channel_id, label, title, handle, is_us, active, thumbnail').order('sort');
      if (error) return json(200, { ready: false, error: error.message });
      const before = new Date(Date.now() - YT_TRACK_DAYS * 86400000).toISOString();
      const videos = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: e2 } = await s.from('yt_videos').select('video_id, channel_id, title, published_at, kind, views')
          .lt('published_at', before).order('published_at').range(from, from + 999);
        if (e2) return json(500, { error: e2.message });
        (data || []).forEach(v => videos.push([v.channel_id, v.kind || 'video', String(v.published_at).slice(0, 10), v.views, v.title, v.video_id]));
        if (!data || data.length < 1000) break;
      }
      const { data: bf } = await s.from('yt_runs').select('*').eq('source', 'backfill').order('ran_at', { ascending: false }).limit(1);
      return json(200, { ready: true, keyReady: !!ytKey(), channels, videos, lastBackfill: (bf || [])[0] || null });
    }
    if (q.video) {
      const { data, error } = await s.from('yt_video_stats').select('taken_at, views, likes, comments')
        .eq('video_id', q.video).order('taken_at');
      if (error) return json(500, { error: error.message });
      return json(200, { history: data || [] });
    }
    const { data: channels, error } = await s.from('yt_channels').select('*').order('sort');
    if (error) return json(200, { ready: false, error: error.message, keyReady: !!ytKey() });
    const since = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);
    const { data: stats } = await s.from('yt_channel_stats').select('*').gte('taken_on', since).order('taken_on');
    const pub = new Date(Date.now() - YT_TRACK_DAYS * 86400000).toISOString();
    const videos = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await s.from('yt_videos')
        .select('video_id, channel_id, title, published_at, kind, duration_s, views, likes, comments, views_24h, views_7d')
        .gte('published_at', pub).order('published_at', { ascending: false }).range(from, from + 999);
      videos.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const { data: runs } = await s.from('yt_runs').select('*').neq('source', 'backfill').order('ran_at', { ascending: false }).limit(1);
    return json(200, { ready: true, keyReady: !!ytKey(), channels, stats: stats || [], videos, lastRun: (runs || [])[0] || null });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
  try {
    // Runs in the background (a full refresh takes longer than Netlify's
    // ~10s request limit); the page waits for the new yt_runs row.
    if (body.action === 'refresh') { const at = new Date().toISOString(); await startCompetitorsRefresh(event, 'yt'); return json(200, { started: true, at }); }
    // Claude's read of the period and video ideas for TAAI (background, see lib/video-ideas.js).
    if (body.action === 'market') {
      if (!ytKey()) return json(400, { error: 'Needs the YouTube API key in Netlify' });
      const at = new Date().toISOString(); await startCompetitorsRefresh(event, 'market'); return json(200, { started: true, at });
    }
    if (body.action === 'backfill') {
      if (!ytKey()) return json(400, { error: 'Needs the YouTube API key in Netlify' });
      const at = new Date().toISOString(); await startCompetitorsRefresh(event, 'backfill'); return json(200, { started: true, at });
    }
    if (body.action === 'ideas') { const at = new Date().toISOString(); await startCompetitorsRefresh(event, 'ideas', { days: Number(body.days) || 3 }); return json(200, { started: true, at }); }
    if (body.action === 'add') {
      const r = await resolveChannel(body.input);
      const label = String(body.label || '').trim().slice(0, 60) || r.handle || r.channel_id;
      const { data: ex } = await s.from('yt_channels').select('channel_id').eq('channel_id', r.channel_id).maybeSingle();
      if (ex) {
        await s.from('yt_channels').update({ active: true }).eq('channel_id', r.channel_id);
        return json(200, { ok: true, channel_id: r.channel_id, existed: true });
      }
      const { error } = await s.from('yt_channels').insert({ channel_id: r.channel_id, handle: r.handle, label, sort: 90 });
      if (error) throw error;
      return json(200, { ok: true, channel_id: r.channel_id });
    }
    if (body.action === 'remove' || body.action === 'restore') {
      if (!body.channel_id) return json(400, { error: 'channel_id required' });
      const { error } = await s.from('yt_channels').update({ active: body.action === 'restore' }).eq('channel_id', body.channel_id);
      if (error) throw error;
      return json(200, { ok: true });
    }
    return json(400, { error: 'unknown action' });
  } catch (e) { return json(500, { error: e.message }); }
}
