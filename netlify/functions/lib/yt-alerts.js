// Competitor breakout alerts (2026-11-27): /team > Competitors > Insights.
// After each 6-hourly YouTube update (yt-monitor.js), any competitor video
// that is 3 to 48 hours old and pulling at least 3x its channel's usual daily
// views (and has 1,000+ views) is recorded once in the list.
// Since 2026-11-28 ("the discord youtube messages can be weekly") nothing is
// posted then: once a week (Monday 09:00 IST, yt-alerts-weekly.js) the week's
// recorded videos go to Discord as one digest, top 10 by score, with their
// current views.
//
// Recorded alerts are kept as alerts/sent.json in the private bucket
// "competitor-insights" (the last 200), which also feeds the page's list.
// Discord channel: the webhook of the scheduled post in the "team reminders"
// channel (the same place the schedule reminders go); no channel, no post.
// Cost: one read of the last 30 days of yt_videos (~40 KB) per run, 4 runs a day.
import { postToDiscordWebhook } from './supabase.js';
import { channelBaselines, videoScore } from './video-ideas.js';

const BUCKET = 'competitor-insights';
const PATH = 'alerts/sent.json';
export const ALERT_MIN_SCORE = 3;
const MIN_VIEWS = 1000;
// Only exam-related videos are worth a ping: competitors also post poetry,
// vlogs and memes that spike for reasons TAAI can't use.
const EXAM_RE = /\bGATE\b|\bPSU|\bIIT|IISc|M\.?\s?Tech|\bexam|revision|\bPYQ|mock|test series|syllabus|lecture|one shot|\bmarks?\b|\brank|\bAIR\b|topper|strateg|probability|statistic|linear algebra|calculus|machine learning|\bML\b|\bAI\b|data science|\bDA\b|\bCSE?\b|DBMS|python|algorithm|data structure|operating system|computer network|\bTOC\b|compiler|digital logic|aptitude|discrete/i;

export async function readAlerts(s) {
  const { data } = await s.storage.from(BUCKET).download(PATH);
  if (!data) return { sent: [] };
  try { return JSON.parse(await data.text()); } catch { return { sent: [] }; }
}

async function alertWebhook(s) {
  const { data } = await s.from('scheduled_posts').select('webhook_url, channel_name, platform')
    .ilike('channel_name', '%team reminder%').limit(5);
  const row = (data || []).find(r => r.webhook_url && (r.platform || 'discord') === 'discord');
  return row ? row.webhook_url : null;
}

// dry: only report what would be sent (for testing); nothing posted or saved.
export async function runYtAlerts(s, { post = false, dry = false } = {}) {
  const now = Date.now();
  const { data: channels, error } = await s.from('yt_channels').select('channel_id, label, title, is_us, active');
  if (error) throw error;
  const chan = {}; for (const c of channels || []) chan[c.channel_id] = c;
  const since30 = new Date(now - 30 * 86400000).toISOString();
  const videos = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await s.from('yt_videos').select('video_id, channel_id, title, published_at, kind, views')
      .gte('published_at', since30).range(from, from + 999);
    videos.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const base = channelBaselines(videos, now, true);
  const log = await readAlerts(s);
  const seen = new Set((log.sent || []).map(a => a.video_id));
  const fresh = videos.filter(v => {
    const c = chan[v.channel_id];
    if (!c || !c.active || c.is_us || seen.has(v.video_id) || !EXAM_RE.test(v.title || '')) return false;
    const ageH = (now - Date.parse(v.published_at)) / 3600000;
    if (ageH < 3 || ageH > 48 || (v.views || 0) < MIN_VIEWS) return false;
    const sc = videoScore(v, base, now, true);
    return sc != null && sc >= ALERT_MIN_SCORE;
  }).map(v => ({
    video_id: v.video_id, title: v.title, channel: chan[v.channel_id].label || chan[v.channel_id].title,
    kind: v.kind || 'video', views: v.views, published_at: v.published_at,
    score: Math.round(videoScore(v, base, now, true) * 10) / 10, at: new Date(now).toISOString(),
  })).sort((a, b) => b.score - a.score);
  if (!fresh.length) return { alerts: 0 };
  if (dry) return { alerts: fresh.length, would: fresh.map(a => a.channel + ': ' + a.title + ' (' + a.score + 'x, ' + a.views + ' views)') };

  let posted = false, postError = null;
  if (post) {
    const hook = await alertWebhook(s);
    if (hook) {
      const lines = fresh.slice(0, 8).map(a => {
        const url = 'https://www.youtube.com/' + (a.kind === 'short' ? 'shorts/' : 'watch?v=') + a.video_id;
        const h = Math.round((now - Date.parse(a.published_at)) / 3600000);
        return '**[' + a.title.replace(/[[\]]/g, '') + '](' + url + ')**\n' + a.channel + ' · ' + a.views.toLocaleString('en-IN') + ' views in ' + h + 'h · **' + a.score + '×** their usual';
      });
      try {
        await postToDiscordWebhook([{
          title: '🔥 Competitor video taking off',
          description: lines.join('\n\n') + '\n\nMake a TAAI take while it\'s hot. More on /team > Competitors > Insights.',
          color: 0xF59E0B,
        }], '', hook);
        posted = true;
      } catch (e) { postError = String(e.message || e).slice(0, 200); }
    } else postError = 'no Discord channel named "team reminders" found';
  }
  const sent = fresh.map(a => Object.assign({}, a, { posted, postError })).concat(log.sent || []).slice(0, 200);
  await s.storage.createBucket(BUCKET, { public: false }).catch(() => {});
  await s.storage.from(BUCKET).upload(PATH, JSON.stringify({ sent }), { contentType: 'application/json', upsert: true });
  return { alerts: fresh.length, posted, postError };
}

// Weekly digest: every recorded alert from the last 7 days that hasn't been
// posted yet, top 10 by score, with views as they are now. Marks them posted.
export async function runYtAlertsDigest(s, { dry = false } = {}) {
  const now = Date.now();
  const log = await readAlerts(s);
  const sent = log.sent || [];
  const week = sent.filter(a => !a.posted && Date.parse(a.at) >= now - 7 * 86400000);
  if (!week.length) return { digest: 0 };
  const ids = week.map(a => a.video_id);
  const { data: cur } = await s.from('yt_videos').select('video_id, views').in('video_id', ids);
  const views = {}; for (const v of cur || []) views[v.video_id] = v.views;
  const top = week.slice().sort((a, b) => b.score - a.score).slice(0, 10);
  const lines = top.map(a => {
    const url = 'https://www.youtube.com/' + (a.kind === 'short' ? 'shorts/' : 'watch?v=') + a.video_id;
    const v = views[a.video_id] || a.views;
    return '**[' + a.title.replace(/[[\]]/g, '') + '](' + url + ')**\n' + a.channel + ' · ' + v.toLocaleString('en-IN') + ' views now · **' + a.score + '×** their usual when spotted';
  });
  if (dry) return { digest: week.length, lines };
  const hook = await alertWebhook(s);
  let posted = false, postError = null;
  if (hook) {
    try {
      await postToDiscordWebhook([{
        title: '🔥 This week\'s competitor videos that took off',
        description: lines.join('\n\n') + (week.length > top.length ? '\n\n+' + (week.length - top.length) + ' more' : '') +
          '\n\nIdeas for TAAI videos. Full list on /team > Competitors > Insights.',
        color: 0xF59E0B,
      }], '', hook);
      posted = true;
    } catch (e) { postError = String(e.message || e).slice(0, 200); }
  } else postError = 'no Discord channel named "team reminders" found';
  const done = new Set(week.map(a => a.video_id));
  const next = sent.map(a => done.has(a.video_id) && !a.posted ? Object.assign({}, a, { posted, postError, digest_at: new Date(now).toISOString() }) : a);
  await s.storage.from(BUCKET).upload(PATH, JSON.stringify({ sent: next }), { contentType: 'application/json', upsert: true });
  return { digest: week.length, posted, postError };
}
