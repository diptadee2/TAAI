// "What students are asking" (2026-11-27): /team > Competitors > Insights.
// Runs only when someone presses the button (never on a schedule): takes the
// 15 competitor videos that beat their channel's usual the most in the chosen
// period, reads up to 40 of each one's most relevant comments with the
// YouTube API (1 quota unit per video), and asks Claude to group the repeated
// questions, complaints and requests. Saved as comments-<days>.json in the
// private bucket "competitor-insights". Cost: one Claude call per press.
import { makeApi, ytKey } from './yt-monitor.js';
import { channelBaselines, videoScore, callClaude } from './video-ideas.js';

const BUCKET = 'competitor-insights';
const TOP_VIDEOS = 15;
const PER_VIDEO = 40;

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['question', 'complaint', 'request', 'praise'] },
          theme: { type: 'string' },
          mentions: { type: 'integer' },
          examples: { type: 'array', items: { type: 'string' } },
          taai_angle: { type: 'string' },
        },
        required: ['kind', 'theme', 'mentions', 'examples', 'taai_angle'], additionalProperties: false,
      },
    },
  },
  required: ['summary', 'groups'], additionalProperties: false,
};

const SYSTEM = `You help TAAI, a small Indian GATE DA (Data Science and AI) exam-prep company. You get YouTube comments left on competitors' best-performing GATE videos. Students often write in Hinglish; read it as such.

Return:
- summary: two or three plain sentences on what students are worried about or asking for right now.
- groups: 6 to 12 themes that come up in several comments (repeated questions, complaints about the teaching or the course, requests for a topic or format, and at most one or two praise themes worth learning from). For each: kind, a short theme name, roughly how many comments mention it (mentions), 2 or 3 short example comments quoted exactly as written (trim long ones), and taai_angle: one sentence on how TAAI could answer it in a video, on the course page, or in the course itself. Skip spam, timestamps, "first" and plain thank-yous.

Plain English, no em dashes. Never invent comments.`;

export async function buildCommentInsights(s, days) {
  days = [1, 3, 7, 30].includes(Number(days)) ? Number(days) : 7;
  if (!ytKey()) throw new Error('Needs the YouTube API key in Netlify');
  const now = Date.now(), perDay = days <= 3;
  const { data: channels, error } = await s.from('yt_channels').select('channel_id, label, title, is_us, active');
  if (error) throw error;
  const chan = {}; for (const c of channels || []) chan[c.channel_id] = c;
  const since30 = new Date(now - 30 * 86400000).toISOString();
  const videos = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await s.from('yt_videos').select('video_id, channel_id, title, published_at, kind, views, comments')
      .gte('published_at', since30).range(from, from + 999);
    videos.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const base = channelBaselines(videos, now, perDay);
  const from = now - days * 86400000;
  const top = videos.filter(v => chan[v.channel_id] && chan[v.channel_id].active && !chan[v.channel_id].is_us
      && Date.parse(v.published_at) >= from && (v.comments || 0) > 0)
    .map(v => ({ v, score: videoScore(v, base, now, perDay) || 0 }))
    .sort((a, b) => b.score - a.score).slice(0, TOP_VIDEOS);
  if (!top.length) throw new Error('No competitor videos with comments in this period yet');

  const api = makeApi();
  const blocks = [], used = [];
  let total = 0;
  for (const { v } of top) {
    const d = await api.get('commentThreads', { part: 'snippet', videoId: v.video_id, order: 'relevance', maxResults: PER_VIDEO, textFormat: 'plainText' }).catch(() => null);
    const texts = ((d && d.items) || []).map(it => {
      const sn = it.snippet && it.snippet.topLevelComment && it.snippet.topLevelComment.snippet;
      return sn ? String(sn.textDisplay || '').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    }).filter(t => t.length > 3);
    if (!texts.length) continue;
    total += texts.length;
    used.push({ video_id: v.video_id, title: v.title, channel: chan[v.channel_id].label || chan[v.channel_id].title });
    blocks.push('## ' + (chan[v.channel_id].label || chan[v.channel_id].title) + ': "' + v.title + '"\n' + texts.map(t => '- ' + t).join('\n'));
  }
  if (!blocks.length) throw new Error('Could not read any comments (they may be turned off)');
  const { result, model } = await callClaude('Comments from the competitor videos that did best in the last ' + (days === 1 ? '24 hours' : days + ' days') + ':\n\n' + blocks.join('\n\n'), SYSTEM, SCHEMA);
  const doc = {
    generatedAt: new Date().toISOString(), days, model, comments: total, units: api.units,
    videos: used,
    ...result,
  };
  await s.storage.createBucket(BUCKET, { public: false }).catch(() => {});
  const { error: upErr } = await s.storage.from(BUCKET).upload('comments-' + days + '.json', JSON.stringify(doc), { contentType: 'application/json', upsert: true });
  if (upErr) throw upErr;
  return doc;
}

export async function readCommentInsights(s, days) {
  const { data } = await s.storage.from(BUCKET).download('comments-' + days + '.json');
  if (!data) return null;
  try { return JSON.parse(await data.text()); } catch { return null; }
}
